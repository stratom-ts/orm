import type { SQLDialect } from 'db0'
import { integer, number, pipe } from 'valibot'
import { describe, expect, it } from 'vitest'

import { postgresDialect } from '@/dialects/postgres/dialect'
import { registerDialectForTest } from '@/dialects/resolve'
import { DriverError, QueryError, createDatabase, defineTable } from '@/index'
import type { OperationSessionProvider } from '@/index'
import {
  OperationCoordinator,
  getOperationReleaseCleanupFailures,
} from '@/operations/coordinator'

import { deferred } from '../helpers/deferredPromise'

import {
  createControllableProvider,
  customConnector,
  withDeadline,
} from './helpers/operationSessionFixtures'

const CoordinatorRecords = defineTable(
  'coordinator_records',
  {
    id: pipe(number(), integer()),
  },
  { primaryKey: 'id' },
)

/** Installs a member whose classifier differs from the native PostgreSQL adapter. */
function classifiedDatabase(
  stage: 'query' | 'open',
  driver: DriverError,
  cleanup: Error,
) {
  const controls = createControllableProvider({
    ...(stage === 'open' ? { openFailure: { session: 1, value: driver } } : {}),
    /** Fails only the selected provider query. */
    beforeCall: async (_session, sql) => {
      if (stage === 'query' && sql === 'select 1') throw driver
    },
    /** Retains cleanup evidence beside the reclassified query failure. */
    beforeRelease: async () => {
      if (stage === 'query') throw cleanup
    },
  })

  const dialect = {
    ...postgresDialect,
    id: 'classification-member',
    /** Exercises member selection independently of the PostgreSQL native adapter. */
    classifyDriverError: () => ({ kind: 'checkViolation' as const, retryable: false }),
  }

  const unregister = registerDialectForTest(dialect)
  const db = createDatabase({
    connector: { ...customConnector(), dialect: dialect.id as SQLDialect },
    operationSessionProvider: controls.provider,
    schemas: [],
  })

  return { db, unregister }
}

describe('selected member provider failure classification', () => {
  it.each(['query', 'open'] as const)(
    'applies the selected member classifier to recognized %s provider failures',
    async (stage) => {
      const native = { code: '23505' }
      const driver = new DriverError({
        message: 'native failure',
        dialect: 'classification-member',
        sql: 'select 1',
        cause: native,
        kind: 'unknown',
        retryable: false,
      })

      const cleanup = new Error('release failed')
      const { db, unregister } = classifiedDatabase(stage, driver, cleanup)

      try {
        const failure = await db.ping().catch((cause: unknown) => cause)
        expect(failure).toMatchObject({
          _tag: 'DriverError',
          kind: 'checkViolation',
          retryable: false,
          cause: native,
          sql: 'select 1',
        })

        expect((failure as DriverError).cause).toBe(native)

        expect(getOperationReleaseCleanupFailures(failure)).toEqual(
          stage === 'query' ? [cleanup] : [],
        )
      } finally {
        await db.close()
        unregister()
      }
    },
  )
})

it('keeps query context and release cleanup evidence when it wraps a driver failure', async () => {
  const secret = 'native-secret-value'
  const nativeCause = new Error(`query failed: ${secret}`)
  const driver = new DriverError({
    message: 'database session query failed',
    dialect: 'postgresql',
    sql: 'select * from coordinator_records',
    cause: nativeCause,
    kind: 'unknown',
    retryable: false,
  })

  const releaseFailure = new Error('session release failed')
  const controls = createControllableProvider({
    beforeCall: async (_session, sql) => {
      if (sql.includes('coordinator_records')) throw driver
    },
    beforeRelease: async () => {
      throw releaseFailure
    },
  })

  const db = createDatabase({
    connector: customConnector(),
    operationSessionProvider: controls.provider,
    schemas: [CoordinatorRecords],
  })

  const failure = await db
    .from(CoordinatorRecords)
    .execute()
    .catch((cause: unknown) => cause)

  expect(failure).toBeInstanceOf(DriverError)
  expect((failure as DriverError).message).toContain('select from')
  expect((failure as DriverError).message).toContain('coordinator_records')
  expect((failure as DriverError).message).not.toContain(secret)
  expect((failure as DriverError).cause).toBe(nativeCause)
  expect(getOperationReleaseCleanupFailures(failure)).toEqual([releaseFailure])
  expect(JSON.stringify(failure)).toContain(`query failed: ${secret}`)

  await db.close()
})

it('names ping and transaction lifecycle failures without exposing native text', async () => {
  for (const [sql, operation, run] of [
    [
      'select 1',
      'postgresql database ping failed',
      (db: ReturnType<typeof createDatabase>) => db.ping(),
    ],
    [
      'begin',
      'postgresql database transaction begin failed',
      (db: ReturnType<typeof createDatabase>) => db.transaction(async () => undefined),
    ],
  ] as const) {
    const secret = 'lifecycle-secret'
    const nativeCause = new Error(`driver detail: ${secret}`)
    const driver = new DriverError({
      message: 'database session query failed',
      dialect: 'postgresql',
      sql,
      cause: nativeCause,
      kind: 'unknown',
      retryable: false,
    })

    const controls = createControllableProvider({
      beforeCall: async (_session, currentSql) => {
        if (currentSql === sql) throw driver
      },
    })

    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const failure = await run(db).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(DriverError)
    expect((failure as DriverError).message).toContain(operation)
    expect((failure as DriverError).message).not.toContain(secret)
    expect((failure as DriverError).cause).toBe(nativeCause)
    await db.close()
  }
})

it.each(['capture', 'verification'] as const)(
  'preserves a %s identity getter defect and discards the session',
  async (stage) => {
    const defect = new TypeError(`${stage} identity getter failed`)
    const stack = defect.stack
    const dispositions: string[] = []
    let reads = 0
    const provider: OperationSessionProvider = {
      nativeTransactions: true,
      async open() {
        return {
          get identity() {
            reads++

            if (stage === 'capture' || reads === 2) throw defect

            return { database: 'db', physicalSession: 'session' }
          },
          async query() {
            return []
          },
          async run() {},
          async cancel() {},
          async release(disposition) {
            dispositions.push(disposition)
          },
        }
      },
      async close() {},
    }

    const coordinator = new OperationCoordinator(provider)
    try {
      const failure = await coordinator
        .run(async () => undefined)
        .catch((cause: unknown) => cause)

      expect(failure).toBe(defect)
      expect((failure as Error).stack).toBe(stack)
      expect(dispositions).toEqual(['discard'])
    } finally {
      await coordinator.close()
    }
  },
)

it('snapshots nested namespace identity and discards when the live context changes', async () => {
  const namespaceContext = {
    writableDefault: [
      { role: 'database' as const, spelling: 'coordinator_test' },
      { role: 'schema' as const, spelling: 'public' },
    ],
  }

  const dispositions: string[] = []
  const provider: OperationSessionProvider = createMutableNamespaceProvider(
    namespaceContext,
    dispositions,
  )

  const coordinator = new OperationCoordinator(provider)
  let capturedSchema: string | undefined

  try {
    const error = await coordinator
      .run(async ({ identity }) => {
        namespaceContext.writableDefault[1]!.spelling = 'tenant'
        capturedSchema = identity.namespaceContext?.writableDefault[1]?.spelling
      })
      .catch((cause: unknown) => cause)

    expect(capturedSchema).toBe('public')
    expect(error).toBeInstanceOf(QueryError)

    expect(error).toMatchObject({
      message: expect.stringMatching(/identity changed/i) as unknown,
    })

    expect(dispositions).toEqual(['discard'])
  } finally {
    await coordinator.close()
  }
})

describe('OperationCoordinator: advances the queue and closes after an early provider-open failure', () => {
  it('advances the queue and closes after an early provider-open failure', async () => {
    const controls = createControllableProvider({
      openFailure: { session: 1, value: new Error('open failed') },
    })

    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const first = db.ping()
    const successor = db.ping()
    const close = db.close()
    await expect(withDeadline(first)).rejects.toThrow(/open failed/i)
    await expect(withDeadline(successor)).resolves.toBeUndefined()
    await expect(withDeadline(close)).resolves.toBeUndefined()

    expect(controls.events).toEqual([
      'lease-opened:1',
      'lease-opened:2',
      'statement:2:select 1',
      'release-started:2:reuse',
      'release-finished:2:reuse',
      'provider-closed',
    ])
  })
})

describe('OperationCoordinator: rejects descendant root use across nested clients without deadlocking', () => {
  it('rejects descendant root use across nested clients without deadlocking', async () => {
    const firstControls = createControllableProvider()
    const secondControls = createControllableProvider()
    const first = createDatabase({
      connector: customConnector(),
      operationSessionProvider: firstControls.provider,
      schemas: [],
    })

    const second = createDatabase({
      connector: customConnector(),
      operationSessionProvider: secondControls.provider,
      schemas: [],
    })

    const operation = first.transaction(async () =>
      second.transaction(async () => first.ping()),
    )

    await expect(withDeadline(operation)).rejects.toThrow(/root database client/i)
    expect(firstControls.openCount).toBe(1)
    expect(secondControls.openCount).toBe(1)
    await Promise.all([first.close(), second.close()])
  })
})

describe('OperationCoordinator: rejects descendant root use across nested clients without deadlocking: retains savepoint ancestry across another client coordinator', () => {
  it('retains savepoint ancestry across another client coordinator', async () => {
    const firstControls = createControllableProvider()
    const secondControls = createControllableProvider()
    const first = createDatabase({
      connector: customConnector(),
      operationSessionProvider: firstControls.provider,
      schemas: [],
    })

    const second = createDatabase({
      connector: customConnector(),
      operationSessionProvider: secondControls.provider,
      schemas: [],
    })

    const invalid = first.transaction(async (firstTrx) =>
      firstTrx.transaction(async () => second.transaction(async () => firstTrx.ping())),
    )

    await expect(withDeadline(invalid)).rejects.toThrow(/use the nested callback client/i)

    await withDeadline(
      first.transaction(async (firstTrx) => {
        await firstTrx.transaction(async (nestedFirst) => {
          await second.transaction(async (secondTrx) => secondTrx.ping())
          await nestedFirst.ping()
        })
      }),
    )

    expect(firstControls.openCount).toBe(2)
    expect(secondControls.openCount).toBe(2)
    await Promise.all([first.close(), second.close()])
  })
})

describe('OperationCoordinator queue and shutdown', () => {
  it('keeps FIFO order across failures and release cleanup', async () => {
    const releaseFirst = deferred()
    const releaseStarted = deferred()
    const controls = createControllableProvider({
      failSession: 1,
      /** Signals or holds release to expose the requested cleanup scenario. */
      beforeRelease: (session) => {
        if (session !== 1) return Promise.resolve()

        releaseStarted.resolve()
        return releaseFirst.promise
      },
    })

    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const first = db.ping()
    const second = db.ping()
    await releaseStarted.promise
    expect(controls.openCount).toBe(1)
    releaseFirst.resolve()
    await expect(first).rejects.toThrow(/session 1 failed/i)
    await expect(second).resolves.toBeUndefined()

    expect(controls.events.slice(0, 6)).toEqual([
      'lease-opened:1',
      'statement:1:select 1',
      'release-started:1:reuse',
      'release-finished:1:reuse',
      'lease-opened:2',
      'statement:2:select 1',
    ])

    await db.close()
  })
})

describe('OperationCoordinator queue and shutdown: rejects callback root reentrancy while unrelated roots wait FIFO', () => {
  it('rejects callback root reentrancy while unrelated roots wait FIFO', async () => {
    const callbackStarted = deferred()
    const finishCallback = deferred()
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const transaction = db.transaction(async () => {
      callbackStarted.resolve()
      await expect(db.ping()).rejects.toBeInstanceOf(QueryError)
      await expect(db.close()).rejects.toThrow(/active operation callback/i)
      await finishCallback.promise
    })

    await callbackStarted.promise
    const unrelated = db.ping()
    await Promise.resolve()
    expect(controls.openCount).toBe(1)
    finishCallback.resolve()
    await transaction
    await unrelated
    expect(controls.openCount).toBe(2)
    await db.close()
  })
})

describe('OperationCoordinator queue and shutdown: lets an accepted transaction keep using its scoped client while close drains', () => {
  it('lets an accepted transaction keep using its scoped client while close drains', async () => {
    const callbackStarted = deferred()
    const resumeCallback = deferred()
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const transaction = db.transaction(async (trx) => {
      callbackStarted.resolve()
      await resumeCallback.promise
      await trx.ping()
    })

    await callbackStarted.promise
    const close = db.close()
    await expect(db.ping()).rejects.toThrow(/closed/i)
    resumeCallback.resolve()

    await transaction
    await close

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'select 1',
      'commit',
    ])

    expect(controls.events.at(-1)).toBe('provider-closed')
  })
})

describe('OperationCoordinator queue and shutdown: rejects providers without mandatory native transaction semantics', () => {
  it('rejects providers without mandatory native transaction semantics', () => {
    expect(
      () =>
        new OperationCoordinator({
          /** Opens an exclusive fixture session with lifecycle controls. */
          open() {},
          /** Closes the fixture provider after its leases settle. */
          close() {},
        } as never),
    ).toThrow(/native transaction semantics/i)
  })
})

/**
 * Exposes mutable native namespace evidence to verify coordinator snapshots.
 *
 * @param namespaceContext - Live writable namespace mutated by the scenario.
 * @param dispositions - Release dispositions observed after identity verification.
 *
 * @returns A provider retaining the supplied live namespace object.
 */
function createMutableNamespaceProvider(
  namespaceContext: NonNullable<
    Awaited<ReturnType<OperationSessionProvider['open']>>['identity']['namespaceContext']
  >,
  dispositions: string[],
): OperationSessionProvider {
  return {
    nativeTransactions: true,
    /** Opens an exclusive fixture session with lifecycle controls. */
    async open() {
      return {
        identity: {
          database: 'coordinator_test',
          physicalSession: 'physical-namespace',
          namespaceContext,
        },
        /** Runs fixture SQL and records physical-session ownership. */
        async query() {
          return []
        },
        /** Runs a fixture statement with configured outcomes. */
        async run() {},
        /** Cancels the active physical-session operation. */
        async cancel() {},
        /** Releases the fixture lease with configured cleanup behavior. */
        async release(disposition) {
          dispositions.push(disposition)
        },
      }
    },
    /** Closes the fixture provider after its leases settle. */
    async close() {},
  }
}
