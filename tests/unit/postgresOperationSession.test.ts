import type { Connector } from 'db0'
import { describe, expect, it } from 'vitest'

import { compilePostgresOperationCommand } from '@/dialects/postgres/operations'
import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'
import type { OperationSessionProvider } from '@/index'
import { createDatabase, createDb0PostgresOperationSessionProvider } from '@/index'
import {
  OperationCoordinator,
  getOperationReleaseCleanupFailures,
} from '@/operations/coordinator'
import type { DriverError } from '@/utils/error'

import { deferred } from '../helpers/deferredPromise'

import {
  createNativeConnector,
  customConnector,
  withDeadline,
} from './helpers/operationSessionFixtures'

it.each([0, 7, null])(
  'returns native PostgreSQL count %s through executor.run',
  async (rowCount) => {
    const coordinator = new OperationCoordinator(
      createDb0PostgresOperationSessionProvider(createNativeConnector({ rowCount })),
    )

    try {
      await expect(
        coordinator.run(({ executor }) =>
          executor.run({ sql: 'update records set value = 1', params: [] }),
        ),
      ).resolves.toBe(rowCount ?? undefined)
    } finally {
      await coordinator.close()
    }
  },
)

it('preserves a connector open defect through db.ping()', async () => {
  const defect = new TypeError('connector getInstance failed')
  const stack = defect.stack
  const connector = {
    ...createNativeConnector(),
    getInstance() {
      throw defect
    },
  }

  const db = createDatabase({ connector, schemas: [] })

  try {
    const failure = await db.ping().catch((cause: unknown) => cause)
    expect(failure).toBe(defect)
    expect((failure as Error).stack).toBe(stack)
  } finally {
    await db.close()
  }
})

it('retains disposal failure beside a frozen connector defect during open', async () => {
  const defect = Object.freeze(new TypeError('connector open failed'))
  const cleanup = new Error('disposal failed')
  const connector = {
    ...createNativeConnector(),
    getInstance() {
      throw defect
    },
    async dispose() {
      throw cleanup
    },
  }

  const provider = createDb0PostgresOperationSessionProvider(connector)

  const failure = await provider.open().catch((cause: unknown) => cause)

  expect(failure).toBe(defect)
  expect((failure as Error).stack).toBe(defect.stack)
  expect(getOperationReleaseCleanupFailures(failure)).toEqual([cleanup])
})

it('retains disposal failure after release verification rejects a primitive', async () => {
  let openings = 0
  const cleanup = new Error('disposal failed')
  const connector = {
    ...createNativeConnector(),
    getInstance() {
      openings++

      if (openings === 2) throw 'identity unavailable'

      return createNativeConnector().getInstance()
    },
    async dispose() {
      throw cleanup
    },
  }

  const provider = createDb0PostgresOperationSessionProvider(connector)
  const session = await provider.open()
  const failure = await session.release('reuse').catch((cause: unknown) => cause)

  expect(failure).toMatchObject({
    _tag: 'MigrationError',
    defect: true,
    cause: 'identity unavailable',
    cleanupFailures: [{ stage: 'sessionCleanup', cause: cleanup }],
  })
})

describe('native PostgreSQL driver classification', () => {
  it.each([undefined, null, 7, { code: '23505' }])(
    'retains native rejection %s with the selected dialect and parameter-free SQL',
    async (nativeCause) => {
      const sql = 'insert into records (value) values ($1)'
      const connector = createNativeConnector({
        /** Rejects only the statement under test. */
        onQuery: async (text) => {
          if (text === sql) throw nativeCause

          return []
        },
      })

      const provider = createDb0PostgresOperationSessionProvider(connector, 'custom-pg')
      const session = await provider.open()

      try {
        const error = await session
          .run({ sql, params: ['secret-bound-value'] })
          .catch((cause: unknown) => cause)

        expect(error).toMatchObject({
          _tag: 'DriverError',
          dialect: 'custom-pg',
          sql,
          cause: nativeCause,
        })

        expect((error as DriverError).code).toBe(
          nativeCause && typeof nativeCause === 'object' && 'code' in nativeCause
            ? nativeCause.code
            : undefined,
        )

        expect(error).not.toHaveProperty('params')
      } finally {
        await session.release('discard')
        await provider.close()
      }
    },
  )
})

describe('native PostgreSQL lifecycle failure classification', () => {
  it.each([
    { command: { kind: 'ping' } as const, sql: 'select 1', call: 'query' as const },
    {
      command: { kind: 'createSavepoint', id: 3 } as const,
      sql: 'savepoint sp_3',
      call: 'run' as const,
    },
  ])(
    'classifies a failed $command.kind call as DriverError',
    async ({ command, sql, call }) => {
      const nativeCause = Object.assign(new Error('native lifecycle failure'), {
        code: 'XX000',
      })

      const connector = createNativeConnector({
        /** Rejects the lifecycle SQL while allowing provider identity checks. */
        onQuery: async (text) => {
          if (text === sql) throw nativeCause

          return []
        },
      })

      const provider = createDb0PostgresOperationSessionProvider(connector, 'custom-pg')
      const session = await provider.open()

      try {
        const compiled = compilePostgresOperationCommand(command)
        const failure = await session[call](compiled).catch((cause: unknown) => cause)

        expect(failure).toMatchObject({
          _tag: 'DriverError',
          dialect: 'custom-pg',
          code: 'XX000',
          sql,
          cause: nativeCause,
        })

        expect((failure as DriverError).cause).toBe(nativeCause)
      } finally {
        await session.release('discard')
        await provider.close()
      }
    },
  )
})

describe('db0 PostgreSQL operation-session adapter', () => {
  it('proves identity at every lease and after reuse cleanup', async () => {
    const connector = createNativeConnector()
    const provider = createDb0PostgresOperationSessionProvider(connector)
    const plainSql = `select '?' as "?", $1::text as value`

    const first = await provider.open()
    await first.query({ sql: plainSql, params: ['bound'] })
    await first.release('reuse')

    expect(connector.queryCalls).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: plainSql, values: ['bound'] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])

    const beforeSecond = connector.queryCalls.length
    const second = await provider.open()
    await second.query({ sql: 'select 2', params: [] })
    await second.release('reuse')

    expect(connector.queryCalls.slice(beforeSecond)).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: 'select 2', values: [] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])

    await assertTransactionLeaseCleanup(connector, provider)

    const beforeAdvisory = connector.queryCalls.length
    const advisory = await provider.open()
    await advisory.run({ sql: 'select pg_advisory_lock(1, 2)', params: [] })
    await advisory.release('reuse')

    expect(connector.queryCalls.slice(beforeAdvisory)).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: 'select pg_advisory_lock(1, 2)', values: [] },
      { text: POSTGRES_OPERATION_ROLLBACK_SQL, values: [] },
      { text: POSTGRES_OPERATION_UNLOCK_SQL, values: [] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])

    await provider.close()
  })
})

describe('db0 PostgreSQL operation-session adapter: reads changed current_schema for a fresh physical-session lease', () => {
  it('reads changed current_schema for a fresh physical-session lease', async () => {
    let schema = 'public'
    const connector = createNativeConnector({
      /** Returns the schema currently reported by the native-client fixture. */
      currentSchema: () => schema,
    })

    const provider = createDb0PostgresOperationSessionProvider(connector)

    const first = await provider.open()
    expect(first.identity.namespaceContext?.writableDefault).toEqual([
      { role: 'database', spelling: 'operations_test' },
      { role: 'schema', spelling: 'public' },
    ])

    await first.release('reuse')

    schema = 'tenant'
    const second = await provider.open()
    expect(second.identity.namespaceContext?.writableDefault).toEqual([
      { role: 'database', spelling: 'operations_test' },
      { role: 'schema', spelling: 'tenant' },
    ])

    await second.release('reuse')

    expect(
      connector.queryCalls.filter(({ text }) => text === POSTGRES_OPERATION_IDENTITY_SQL),
    ).toHaveLength(4)

    await provider.close()
  })
})

describe('db0 PostgreSQL operation-session adapter: discards a reused session when DDL changes current_schema during its lease', () => {
  it('discards a reused session when DDL changes current_schema during its lease', async () => {
    let schema = 'public'
    const connector = createNativeConnector({
      /** Returns the schema currently reported by the native-client fixture. */
      currentSchema: () => schema,
      /** Handles native query observations for the configured session scenario. */
      onQuery: async (text) => {
        if (/^create schema/i.test(text)) schema = 'tenant'

        return []
      },
    })

    const provider = createDb0PostgresOperationSessionProvider(connector)
    const session = await provider.open()

    await session.run({ sql: 'create schema tenant', params: [] })

    await expect(session.release('reuse')).rejects.toThrow(
      /session identity changed before release/i,
    )

    expect(connector.disposeCount).toBe(1)
    await provider.close()
  })

  it('discards a reused session when final namespace evidence cannot be read', async () => {
    const connector = createNativeConnector({ identityFailureAt: 2 })
    const provider = createDb0PostgresOperationSessionProvider(connector)
    const session = await provider.open()

    await session.run({ sql: 'select 1', params: [] })

    const failure = await session.release('reuse').catch((cause: unknown) => cause)
    expect(failure).toMatchObject({
      message: 'postgresql database session identity check failed',
    })

    expect((failure as DriverError).cause).toMatchObject({
      message: 'identity evidence unavailable',
    })

    expect(connector.disposeCount).toBe(1)
    await provider.close()
  })
})

describe('db0 PostgreSQL operation-session adapter: retains final namespace-evidence cleanup without replacing a primary operation failure', () => {
  it('retains final namespace-evidence cleanup without replacing a primary operation failure', async () => {
    const primary = new Error('primary native operation failure')
    const connector = createNativeConnector({
      identityFailureAt: 2,
      /** Handles native query observations for the configured session scenario. */
      onQuery: async (text) => {
        if (text === 'select primary failure') throw primary

        return []
      },
    })

    const coordinator = new OperationCoordinator(
      createDb0PostgresOperationSessionProvider(connector),
    )

    const error = await coordinator
      .run(({ executor }) => executor.run({ sql: 'select primary failure', params: [] }))
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      _tag: 'DriverError',
      dialect: 'postgresql',
      sql: 'select primary failure',
      cause: primary,
    })

    expect(getOperationReleaseCleanupFailures(error)).toHaveLength(1)

    expect(getOperationReleaseCleanupFailures(error)[0]).toMatchObject({
      message: 'postgresql database session identity check failed',
      cause: { message: 'identity evidence unavailable' },
    })

    expect(connector.disposeCount).toBe(1)
    await coordinator.close()
  })
})

describe('db0 PostgreSQL operation-session lifecycle', () => {
  it('proves stable identity and serializes native calls through reuse release', async () => {
    const gates = [deferred(), deferred()]
    const firstStarted = deferred()
    let call = 0
    const connector = createNativeConnector({
      /** Handles native query observations for the configured session scenario. */
      onQuery: async () => {
        const index = call++

        if (index === 0) firstStarted.resolve()

        const gate = gates[index]!
        await gate.promise
        return []
      },
    })

    const provider = createDb0PostgresOperationSessionProvider(connector)
    const session = await provider.open()
    const identity = session.identity
    const initialDatabase = identity.database
    const initialPhysicalSession = identity.physicalSession

    const first = session.query({ sql: 'select 1', params: [] })
    const second = session.run({ sql: 'update test set value = 1', params: [] })
    await firstStarted.promise
    expect(connector.maxActiveCalls).toBe(1)
    gates[0]!.resolve()
    await first
    gates[1]!.resolve()
    await second

    expect(session.identity).toMatchObject({
      database: initialDatabase,
      physicalSession: initialPhysicalSession,
    })

    await session.release('reuse')
    expect(connector.disposeCount).toBe(0)
    await expect(session.release('reuse')).rejects.toThrow(/more than once/i)
    await provider.close()
  })
})

describe('db0 PostgreSQL operation-session lifecycle: cancels an active call and safely discards the uncertain client', () => {
  it('cancels an active call and safely discards the uncertain client', async () => {
    const started = deferred()
    const endStarted = deferred()
    const finishEnd = deferred()
    const connector = createNativeConnector({
      /** Handles native query observations for the configured session scenario. */
      onQuery: () => {
        started.resolve()
        return new Promise(() => {})
      },
      /** Holds native-client shutdown until the test releases its completion barrier. */
      beforeEnd: async () => {
        endStarted.resolve()
        await finishEnd.promise
      },
    })

    const provider = createDb0PostgresOperationSessionProvider(connector)
    const session = await provider.open()
    const originalIdentity = session.identity
    const query = session.query({ sql: 'select pg_sleep(30)', params: [] })
    await started.promise

    const cancel = session.cancel()
    await endStarted.promise

    expect(
      await Promise.race([cancel.then(() => 'settled'), Promise.resolve('pending')]),
    ).toBe('pending')

    finishEnd.resolve()
    await expect(withDeadline(cancel)).resolves.toBeUndefined()
    const failure = await withDeadline(query).catch((cause: unknown) => cause)
    expect(failure).toMatchObject({
      message: 'postgresql database session SQL execution failed',
    })

    expect((failure as DriverError).cause).toMatchObject({
      message: expect.stringMatching(/terminated/i) as string,
    })

    await session.release('reuse')
    expect(connector.endCount).toBe(1)
    expect(connector.disposeCount).toBe(1)

    const replacement = await provider.open()
    expect(replacement.identity.physicalSession).not.toBe(
      originalIdentity.physicalSession,
    )

    await replacement.release('reuse')
    await provider.close()
  })
})

describe('db0 PostgreSQL operation-session lifecycle: rejects connectors that cannot prove native PostgreSQL pinning', () => {
  it('rejects connectors that cannot prove native PostgreSQL pinning', async () => {
    expect(() => createDb0PostgresOperationSessionProvider(customConnector())).toThrow(
      /automatic operation sessions/i,
    )

    const connector = {
      ...customConnector(),
      name: 'postgresql',
      /** Records disposal and closes owned fixture resources. */
      dispose: async () => {},
    }

    const provider = createDb0PostgresOperationSessionProvider(connector)
    const { readinessProvider, missingReadiness } = await assertMissingPostgresReadiness(
      provider,
      connector,
    )

    await expect(readinessProvider.open()).rejects.toThrow(/readiness.*queue/i)

    const missingCancellation = {
      ...missingReadiness,
      readyForQuery: true,
      activeQuery: null,
      queryQueue: [],
      end: undefined,
    }

    const cancellationProvider = createDb0PostgresOperationSessionProvider({
      ...connector,
      /** Returns the native client owned by the fixture connector. */
      getInstance: () => missingCancellation,
    })

    await expect(cancellationProvider.open()).rejects.toThrow(
      /cancellation capabilities/i,
    )

    const dirtyProvider = createDb0PostgresOperationSessionProvider({
      ...connector,
      /** Returns the native client owned by the fixture connector. */
      getInstance: () => ({
        ...missingReadiness,
        readyForQuery: false,
        activeQuery: null,
        queryQueue: [],
      }),
    })

    await expect(dirtyProvider.open()).rejects.toThrow(/not clean for operation use/i)
  })
})

describe('db0 PostgreSQL operation-session lifecycle: preserves an undefined rejection from exact-provider release verification', () => {
  it('preserves an undefined rejection from exact-provider release verification', async () => {
    const connector = createNativeConnector({
      releaseFailure: { value: undefined },
    })

    const provider = createDb0PostgresOperationSessionProvider(connector)
    const session = await provider.open()

    await session.run({ sql: 'begin', params: [] })

    await expect(session.release('reuse')).rejects.toMatchObject({
      _tag: 'DriverError',
      sql: POSTGRES_OPERATION_ROLLBACK_SQL,
      cause: undefined,
    })

    expect(connector.disposeCount).toBe(1)
    await provider.close()
  })

  it('waits for an active lease before deduplicated provider close', async () => {
    const connector = createNativeConnector()
    const provider = createDb0PostgresOperationSessionProvider(connector)
    const session = await provider.open()

    const firstClose = provider.close()
    const secondClose = provider.close()
    expect(secondClose).toBe(firstClose)

    expect(
      await Promise.race([firstClose.then(() => 'settled'), Promise.resolve('waiting')]),
    ).toBe('waiting')

    await expect(provider.open()).rejects.toThrow(/closed/i)
    await session.query({ sql: 'select 1', params: [] })
    await session.release('reuse')
    await expect(withDeadline(firstClose)).resolves.toBeUndefined()
    expect(connector.disposeCount).toBe(1)
  })
})

describe('db0 PostgreSQL operation-session lifecycle: preserves an undefined rejection from exact-provider release verification: allows provider close cleanup to retry after disposal fails', () => {
  it('allows provider close cleanup to retry after disposal fails', async () => {
    const connector = createNativeConnector({ disposeFailures: 1 })
    const provider = createDb0PostgresOperationSessionProvider(connector)

    const firstClose = provider.close()
    await expect(firstClose).rejects.toThrow(/dispose failed/i)
    const retry = provider.close()
    expect(retry).not.toBe(firstClose)
    await expect(retry).resolves.toBeUndefined()
    expect(connector.disposeCount).toBe(2)
  })
})

/**
 * Checks rejection of native clients that cannot prove query readiness.
 *
 * @param provider - Provider that owns exclusive session leases and shutdown.
 * @param connector - Connector that owns native connection resources.
 *
 * @returns A provider and native-client fixture without query-readiness evidence.
 */
async function assertMissingPostgresReadiness(
  provider: OperationSessionProvider,
  connector: Connector,
) {
  await expect(provider.open()).rejects.toThrow(/exact native pg\.Client/i)

  const missingReadiness = {
    processID: 123,
    database: 'test',
    /** Runs fixture SQL and records physical-session ownership. */
    query: async () => ({
      rows: [{ physicalSession: '123', database: 'test' }],
    }),
    /** Closes the native PostgreSQL client and its physical connection. */
    async end() {},
  }

  const readinessProvider = createDb0PostgresOperationSessionProvider({
    ...connector,
    /** Returns the native client owned by the fixture connector. */
    getInstance: () => missingReadiness,
  })

  return { readinessProvider, missingReadiness }
}

/**
 * Checks transaction cleanup, physical-session release, and provider shutdown
 * observations.
 *
 * @param connector - Connector that owns native connection resources.
 * @param provider - Provider that owns exclusive session leases and shutdown.
 */
async function assertTransactionLeaseCleanup(
  connector: Connector & {
    readonly disposeCount: number
    readonly endCount: number
    readonly maxActiveCalls: number
    readonly queryCalls: readonly { text: string; values: unknown[] }[]
  },
  provider: OperationSessionProvider,
) {
  const beforeTransaction = connector.queryCalls.length
  const transaction = await provider.open()
  await transaction.run({ sql: 'begin', params: [] })
  await transaction.run({ sql: 'commit', params: [] })
  await transaction.release('reuse')

  expect(connector.queryCalls.slice(beforeTransaction)).toEqual([
    { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    { text: 'begin', values: [] },
    { text: 'commit', values: [] },
    { text: POSTGRES_OPERATION_ROLLBACK_SQL, values: [] },
    { text: POSTGRES_OPERATION_UNLOCK_SQL, values: [] },
    { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
  ])
}
