import type { Connector, Statement } from 'db0'
import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'
import { scanPostgresSql } from '@/dialects/postgres/postgresSql'
import type { OperationSession, OperationSessionProvider } from '@/index'
import {
  QueryError,
  column,
  createDatabase,
  createDb0PostgresqlOperationSessionProvider,
  defineTable,
} from '@/index'

import { createNativePostgresClient } from './helpers/nativePostgresClient'

type Deferred = {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve,
  }
}

function withDeadline<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operation timed out')), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

function createNativeConnector(options?: {
  onQuery?: (
    text: string,
    signal: AbortSignal | undefined,
    values: unknown[],
  ) => Promise<unknown[]>
  beforeEnd?: () => Promise<void>
  disposeFailures?: number
  releaseFailure?: { value: unknown }
}) {
  let nextProcessId = 4000
  let client: ReturnType<typeof createClient> | undefined
  let disposeCount = 0
  let endCount = 0
  let activeCalls = 0
  let maxActiveCalls = 0
  let disposeFailures = options?.disposeFailures ?? 0
  const queryCalls: { text: string; values: unknown[] }[] = []

  const createClient = () => {
    const processID = nextProcessId++
    let activeQuery: object | null = null
    let rejectActive: ((cause: Error) => void) | undefined
    const nativeClient = {
      processID,
      database: 'operations_test',
      readyForQuery: true,
      get activeQuery() {
        return activeQuery
      },
      queryQueue: [],
      async end() {
        endCount++
        await options?.beforeEnd?.()
        rejectActive?.(new Error('native connection terminated'))
      },
      async query(
        query: string | { text: string; values: unknown[]; signal?: AbortSignal },
      ) {
        const text = typeof query === 'string' ? query : query.text
        const signal = typeof query === 'string' ? undefined : query.signal
        const values = typeof query === 'string' ? [] : query.values
        queryCalls.push({ text, values })

        if (text === POSTGRES_OPERATION_IDENTITY_SQL) {
          return {
            rows: [
              {
                physicalSession: String(processID),
                database: 'operations_test',
              },
            ],
          }
        }

        if (
          text === POSTGRES_OPERATION_ROLLBACK_SQL ||
          text === POSTGRES_OPERATION_UNLOCK_SQL
        ) {
          if (options?.releaseFailure) throw options.releaseFailure.value
          return { rows: [] }
        }

        activeQuery = {}
        nativeClient.readyForQuery = false
        activeCalls++
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls)

        try {
          const terminated = new Promise<never>((_, reject) => {
            rejectActive = reject
          })
          const rows = await Promise.race([
            options?.onQuery?.(text, signal, values) ?? Promise.resolve([]),
            terminated,
          ])
          return { rows }
        } finally {
          rejectActive = undefined
          activeQuery = null
          nativeClient.readyForQuery = true
          activeCalls--
        }
      },
    }
    return nativeClient
  }

  const connector: Connector & {
    readonly disposeCount: number
    readonly endCount: number
    readonly maxActiveCalls: number
    readonly queryCalls: readonly { text: string; values: unknown[] }[]
  } = {
    name: 'postgresql',
    dialect: 'postgresql',
    getInstance: () => (client ??= createClient()),
    exec: async () => ({}),
    prepare: () => {
      throw new Error('native provider must not use db0 prepare')
    },
    async dispose() {
      disposeCount++

      if (disposeFailures > 0) {
        disposeFailures--
        throw new Error('connector dispose failed')
      }

      client = undefined
    },
    get disposeCount() {
      return disposeCount
    },
    get endCount() {
      return endCount
    },
    get maxActiveCalls() {
      return maxActiveCalls
    },
    get queryCalls() {
      return queryCalls
    },
  }
  return connector
}

type ProviderControls = {
  provider: OperationSessionProvider
  events: string[]
  calls: { session: number; sql: string }[]
  get openCount(): number
  get maxActiveCalls(): number
  get closeCount(): number
}

function createControllableProvider(options?: {
  beforeCall?: (session: number, sql: string) => Promise<void>
  beforeCancel?: (session: number) => Promise<void>
  beforeRelease?: (session: number) => Promise<void>
  failSession?: number
  openFailure?: { session: number; value: unknown }
  releaseFailure?: { session: number; value: unknown }
  closeFailure?: { value: unknown }
  unlockResult?: boolean
}): ProviderControls {
  const events: string[] = []
  const calls: { session: number; sql: string }[] = []
  let openCount = 0
  let activeCalls = 0
  let maxActiveCalls = 0
  let closeCount = 0

  const provider: OperationSessionProvider = {
    nativeTransactions: true,
    async open() {
      const id = ++openCount
      events.push(`open:${id}`)
      if (options?.openFailure?.session === id) throw options.openFailure.value
      let released = false
      let queue = Promise.resolve()

      const call = <T>(sql: string, operation: () => Promise<T>): Promise<T> => {
        if (released) throw new Error('released session used')
        const result = queue.then(async () => {
          calls.push({ session: id, sql })
          events.push(`call:${id}:${sql}`)
          activeCalls++
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls)

          try {
            await options?.beforeCall?.(id, sql)
            if (options?.failSession === id) throw new Error(`session ${id} failed`)
            return await operation()
          } finally {
            activeCalls--
          }
        })
        queue = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      }

      const session: OperationSession = {
        identity: Object.freeze({
          database: 'coordinator_test',
          physicalSession: `physical-${id}`,
        }),
        query(query) {
          return call(query.sql, async () => {
            if (/current_database\(\)/i.test(query.sql)) {
              return [
                {
                  database: 'coordinator_test',
                  schema: 'public',
                  version: '160000',
                },
              ]
            }

            if (/-- catalog:namespace/i.test(query.sql)) {
              return [{ schema: 'public', owner: 'app' }]
            }

            if (/pg_advisory_unlock\(/i.test(query.sql)) {
              return [{ unlocked: options?.unlockResult ?? true }]
            }

            if (/pg_try_advisory_lock\(/i.test(query.sql)) {
              return [{ locked: true }]
            }

            return []
          })
        },
        run(query) {
          return call(query.sql, async () => undefined)
        },
        async cancel() {
          events.push(`cancel:${id}`)
          await options?.beforeCancel?.(id)
        },
        async release(disposition) {
          if (released) throw new Error('released twice')
          released = true
          await queue
          events.push(`release-start:${id}:${disposition}`)
          await options?.beforeRelease?.(id)

          if (options?.releaseFailure?.session === id) {
            throw options.releaseFailure.value
          }

          events.push(`release-end:${id}:${disposition}`)
        },
      }
      return session
    },
    async close() {
      closeCount++
      events.push('provider-close')
      if (options?.closeFailure) throw options.closeFailure.value
    },
  }

  return {
    provider,
    events,
    calls,
    get openCount() {
      return openCount
    },
    get maxActiveCalls() {
      return maxActiveCalls
    },
    get closeCount() {
      return closeCount
    },
  }
}

function customConnector(): Connector {
  return {
    name: 'custom',
    dialect: 'postgresql',
    getInstance: () => ({}),
    exec: async () => ({}),
    prepare: () => {
      throw new Error('custom connector should be accessed only through its provider')
    },
  }
}

describe('db0 PostgreSQL operation sessions', () => {
  it('avoids extra round trips for plain operations and fully cleans stateful work', async () => {
    const connector = createNativeConnector()
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const plainSql = `select '?' as "?", $1::text as value`

    const first = await provider.open()
    await first.query({ sql: plainSql, params: ['bound'] })
    await first.release('reuse')
    expect(connector.queryCalls).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: plainSql, values: ['bound'] },
    ])

    const beforeSecond = connector.queryCalls.length
    const second = await provider.open()
    await second.query({ sql: 'select 2', params: [] })
    await second.release('reuse')
    expect(connector.queryCalls.slice(beforeSecond)).toEqual([
      { text: 'select 2', values: [] },
    ])

    const beforeTransaction = connector.queryCalls.length
    const transaction = await provider.open()
    await transaction.run({ sql: 'begin', params: [] })
    await transaction.run({ sql: 'commit', params: [] })
    await transaction.release('reuse')
    expect(connector.queryCalls.slice(beforeTransaction)).toEqual([
      { text: 'begin', values: [] },
      { text: 'commit', values: [] },
      { text: POSTGRES_OPERATION_ROLLBACK_SQL, values: [] },
      { text: POSTGRES_OPERATION_UNLOCK_SQL, values: [] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])

    const beforeAdvisory = connector.queryCalls.length
    const advisory = await provider.open()
    await advisory.run({ sql: 'select pg_advisory_lock(1, 2)', params: [] })
    await advisory.release('reuse')
    expect(connector.queryCalls.slice(beforeAdvisory)).toEqual([
      { text: 'select pg_advisory_lock(1, 2)', values: [] },
      { text: POSTGRES_OPERATION_ROLLBACK_SQL, values: [] },
      { text: POSTGRES_OPERATION_UNLOCK_SQL, values: [] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])
    await provider.close()
  })

  it('lexically classifies stateful SQL without matching inert quoted text', async () => {
    const connector = createNativeConnector()
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const warm = await provider.open()
    await warm.release('reuse')

    const run = async (sql: string) => {
      const offset = connector.queryCalls.length
      const session = await provider.open()
      await session.run({ sql, params: [] })
      await session.release('reuse')
      return connector.queryCalls.slice(offset)
    }

    for (const sql of [
      `select 'begin; pg_advisory_lock(1)' as value`,
      `select 1 as "abort", '?' as "begin"`,
      `select $body$ begin; pg_advisory_lock(1) $body$ as body`,
      `select 1 /* begin /* rollback */ end */`,
      `select 1 -- begin\n`,
      `select 1 as pg_advisory_lock`,
      `select "PG_ADVISORY_LOCK"(1)`,
      `select "pg_advisory_""lock"(1)`,
      `select "pg_catalog"."not_advisory"(1)`,
      'merge into target using source on false when not matched then insert default values',
      'table users',
    ]) {
      expect(await run(sql)).toEqual([{ text: sql, values: [] }])
    }

    for (const sql of [
      '/* trace */ begin',
      'select 1; begin',
      'END',
      'ABORT',
      'select pg_advisory_lock /* trace */ (1)',
      'select "pg_advisory_lock"(1)',
      'select "pg_catalog"."pg_advisory_lock"(1)',
      'select "pg""_catalog"."pg_advisory_lock" /* trace */ (1)',
      `select 'unterminated`,
      'select $body$ unterminated',
      'select 1 /* unterminated',
      'mystery command',
    ]) {
      expect(await run(sql)).toEqual([
        { text: sql, values: [] },
        { text: POSTGRES_OPERATION_ROLLBACK_SQL, values: [] },
        { text: POSTGRES_OPERATION_UNLOCK_SQL, values: [] },
        { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      ])
    }

    await provider.close()
  })

  it('rewrites only executable PostgreSQL parameters in the test adapter', async () => {
    const prepared: string[] = []
    const binds: unknown[][] = []
    const statement: Statement = {
      bind(...params) {
        binds.push(params)
        return statement
      },
      async all() {
        return []
      },
      async run() {
        return { success: true }
      },
      async get() {
        return undefined
      },
    }
    const client = createNativePostgresClient((sql) => {
      prepared.push(sql)
      return statement
    })

    const sql =
      `alter table test alter column value set default '$1';\n` +
      `select "$2", $body$ $3 $body$, /* $4 */ $2, -- $5\n$1, $2`
    await client.query({
      text: sql,
      values: ['first', 'second'],
    })
    expect(prepared).toEqual([
      `alter table test alter column value set default '$1';\n` +
        `select "$2", $body$ $3 $body$, /* $4 */ ?, -- $5\n?, ?`,
    ])
    expect(binds).toEqual([['second', 'first', 'second']])
  })

  it('distinguishes standard strings from PostgreSQL escape strings', () => {
    const standard = scanPostgresSql(String.raw`select 'a\' || $1`)
    const escaped = scanPostgresSql(String.raw`select E'a\'' || $1`)

    expect(standard.malformed).toBe(false)
    expect(standard.parameters.map((parameter) => parameter.index)).toEqual([0])
    expect(escaped.malformed).toBe(false)
    expect(escaped.parameters.map((parameter) => parameter.index)).toEqual([0])
  })

  it('uses row execution for commented and parenthesized result queries', async () => {
    let allCalls = 0
    let runCalls = 0
    const statement: Statement = {
      bind() {
        return statement
      },
      async all() {
        allCalls++
        return []
      },
      async run() {
        runCalls++
        return { success: true }
      },
      async get() {
        return undefined
      },
    }
    const client = createNativePostgresClient(() => statement)

    for (const sql of [
      '/* trace */ select 1',
      '-- trace\nselect 1',
      '((select 1))',
      'with value as (select 1) select * from value',
      'insert into test default values returning id',
    ]) {
      await client.query({ text: sql, values: [] })
    }

    await client.query({ text: 'update test set value = 1', values: [] })

    expect(allCalls).toBe(5)
    expect(runCalls).toBe(1)
  })

  it('proves stable identity and serializes native calls through reuse release', async () => {
    const gates = [deferred(), deferred()]
    const firstStarted = deferred()
    let call = 0
    const connector = createNativeConnector({
      onQuery: async () => {
        const index = call++
        if (index === 0) firstStarted.resolve()
        const gate = gates[index]!
        await gate.promise
        return []
      },
    })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const session = await provider.open()
    const identity = session.identity

    const first = session.query({ sql: 'select 1', params: [] })
    const second = session.run({ sql: 'update test set value = 1', params: [] })
    await firstStarted.promise
    expect(connector.maxActiveCalls).toBe(1)
    gates[0]!.resolve()
    await first
    gates[1]!.resolve()
    await second

    expect(session.identity).toBe(identity)
    await session.release('reuse')
    expect(connector.disposeCount).toBe(0)
    await expect(session.release('reuse')).rejects.toThrow(/more than once/i)
    await provider.close()
  })

  it('cancels an active call and safely discards the uncertain client', async () => {
    const started = deferred()
    const endStarted = deferred()
    const finishEnd = deferred()
    const connector = createNativeConnector({
      onQuery: () => {
        started.resolve()
        return new Promise(() => {})
      },
      beforeEnd: async () => {
        endStarted.resolve()
        await finishEnd.promise
      },
    })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
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
    await expect(withDeadline(query)).rejects.toThrow(/terminated/i)
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

  it('rejects connectors that cannot prove native PostgreSQL pinning', async () => {
    expect(() => createDb0PostgresqlOperationSessionProvider(customConnector())).toThrow(
      /automatic operation sessions/i,
    )

    const connector = {
      ...customConnector(),
      name: 'postgresql',
      dispose: async () => {},
    }
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    await expect(provider.open()).rejects.toThrow(/exact native pg\.Client/i)

    const missingReadiness = {
      processID: 123,
      database: 'test',
      query: async () => ({
        rows: [{ physicalSession: '123', database: 'test' }],
      }),
      async end() {},
    }
    const readinessProvider = createDb0PostgresqlOperationSessionProvider({
      ...connector,
      getInstance: () => missingReadiness,
    })
    await expect(readinessProvider.open()).rejects.toThrow(/readiness.*queue/i)

    const missingCancellation = {
      ...missingReadiness,
      readyForQuery: true,
      activeQuery: null,
      queryQueue: [],
      end: undefined,
    }
    const cancellationProvider = createDb0PostgresqlOperationSessionProvider({
      ...connector,
      getInstance: () => missingCancellation,
    })
    await expect(cancellationProvider.open()).rejects.toThrow(
      /cancellation capabilities/i,
    )

    const dirtyProvider = createDb0PostgresqlOperationSessionProvider({
      ...connector,
      getInstance: () => ({
        ...missingReadiness,
        readyForQuery: false,
        activeQuery: null,
        queryQueue: [],
      }),
    })
    await expect(dirtyProvider.open()).rejects.toThrow(/not clean for operation use/i)
  })

  it('preserves an undefined rejection from exact-provider release verification', async () => {
    const connector = createNativeConnector({
      releaseFailure: { value: undefined },
    })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const session = await provider.open()

    await session.run({ sql: 'begin', params: [] })
    await expect(session.release('reuse')).rejects.toBeUndefined()
    expect(connector.disposeCount).toBe(1)
    await provider.close()
  })

  it('waits for an active lease before deduplicated provider close', async () => {
    const connector = createNativeConnector()
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
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

  it('allows provider close cleanup to retry after disposal fails', async () => {
    const connector = createNativeConnector({ disposeFailures: 1 })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)

    const firstClose = provider.close()
    await expect(firstClose).rejects.toThrow(/dispose failed/i)
    const retry = provider.close()
    expect(retry).not.toBe(firstClose)
    await expect(retry).resolves.toBeUndefined()
    expect(connector.disposeCount).toBe(2)
  })
})

describe('client root-operation coordination', () => {
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
      'open:1',
      'open:2',
      'call:2:select 1',
      'release-start:2:reuse',
      'release-end:2:reuse',
      'provider-close',
    ])
  })

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

  it('keeps FIFO order across failures and release cleanup', async () => {
    const releaseFirst = deferred()
    const releaseStarted = deferred()
    const controls = createControllableProvider({
      failSession: 1,
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
      'open:1',
      'call:1:select 1',
      'release-start:1:reuse',
      'release-end:1:reuse',
      'open:2',
      'call:2:select 1',
    ])
    await db.close()
  })

  it('reuses one token for transaction calls, concurrent calls, and savepoints', async () => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    await db.transaction(async (trx) => {
      await Promise.all([trx.ping(), trx.ping()])
      await trx.transaction(async (nested) => nested.ping())
    })

    expect(controls.openCount).toBe(1)
    expect(controls.maxActiveCalls).toBe(1)
    expect(controls.calls.every((entry) => entry.session === 1)).toBe(true)
    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'select 1',
      'select 1',
      'savepoint sp_1',
      'select 1',
      'release savepoint sp_1',
      'commit',
    ])
    await db.close()
  })

  it('serializes sibling savepoint callbacks while preserving deeper nesting', async () => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    await db.transaction(async (trx) => {
      await Promise.all([
        trx.transaction(async (first) => {
          await first.transaction(async (deep) => deep.ping())
        }),
        trx.transaction(async (second) => second.ping()),
      ])
    })

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'savepoint sp_2',
      'select 1',
      'release savepoint sp_2',
      'release savepoint sp_1',
      'savepoint sp_3',
      'select 1',
      'release savepoint sp_3',
      'commit',
    ])
    await db.close()
  })

  it('rejects ancestor transaction use from a descendant callback', async () => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    await withDeadline(
      db.transaction(async (trx) => {
        await trx.transaction(async (nested) => {
          await expect(
            withDeadline(trx.transaction(async () => undefined)),
          ).rejects.toThrow(/use the nested callback client/i)
          await expect(withDeadline(trx.ping())).rejects.toThrow(
            /use the nested callback client/i,
          )
          await nested.transaction(async (deep) => deep.ping())
        })
      }),
    )

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'savepoint sp_2',
      'select 1',
      'release savepoint sp_2',
      'release savepoint sp_1',
      'commit',
    ])
    await db.close()
  })

  it('queues unrelated ancestor statements until a successful savepoint releases', async () => {
    const nestedStarted = deferred()
    const finishNested = deferred()
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })
    let ancestor!: Parameters<Parameters<typeof db.transaction>[0]>[0]

    const transaction = db.transaction(async (trx) => {
      ancestor = trx
      await trx.transaction(async () => {
        nestedStarted.resolve()
        await finishNested.promise
      })
    })
    await nestedStarted.promise
    const ancestorStatement = ancestor.ping()
    await Promise.resolve()
    expect(controls.calls.map((entry) => entry.sql)).toEqual(['begin', 'savepoint sp_1'])

    finishNested.resolve()
    await withDeadline(Promise.all([transaction, ancestorStatement]))
    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'release savepoint sp_1',
      'select 1',
      'commit',
    ])
    await db.close()
  })

  it('queues unrelated ancestor statements until a failing savepoint cleans up', async () => {
    const nestedStarted = deferred()
    const failNested = deferred()
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })
    let ancestor!: Parameters<Parameters<typeof db.transaction>[0]>[0]

    const transaction = db.transaction(async (trx) => {
      ancestor = trx
      await trx
        .transaction(async () => {
          nestedStarted.resolve()
          await failNested.promise
          throw new Error('nested callback failed')
        })
        .catch(() => undefined)
    })
    await nestedStarted.promise
    const ancestorStatement = ancestor.ping()
    await Promise.resolve()
    expect(controls.calls.map((entry) => entry.sql)).toEqual(['begin', 'savepoint sp_1'])

    failNested.resolve()
    await withDeadline(Promise.all([transaction, ancestorStatement]))
    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'rollback to savepoint sp_1',
      'release savepoint sp_1',
      'select 1',
      'commit',
    ])
    await db.close()
  })

  it('poisons cleanup failure and suppresses queued sibling and ancestor SQL', async () => {
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/^rollback to savepoint/i.test(sql)) {
          throw new Error('savepoint rollback cleanup failed')
        }
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const transaction = db.transaction(async (trx) => {
      await Promise.all([
        trx.transaction(async () => {
          throw new Error('primary nested failure')
        }),
        trx.transaction(async (sibling) => sibling.ping()),
        trx.ping(),
      ])
    })
    await expect(withDeadline(transaction)).rejects.toThrow(/primary nested failure/i)

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'rollback to savepoint sp_1',
      'rollback',
    ])
    expect(controls.events).toContain('release-start:1:discard')
    await db.close()
  })

  it('poisons failed savepoint release and suppresses all queued scoped SQL', async () => {
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/^release savepoint sp_1$/i.test(sql)) {
          throw new Error('savepoint release cleanup failed')
        }
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const transaction = db.transaction(async (trx) => {
      await Promise.all([
        trx.transaction(async () => undefined),
        trx.transaction(async (sibling) => sibling.ping()),
        trx.ping(),
      ])
    })
    await expect(withDeadline(transaction)).rejects.toThrow(
      /savepoint release cleanup failed/i,
    )

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'release savepoint sp_1',
      'rollback',
    ])
    expect(controls.events).toContain('release-start:1:discard')
    await db.close()
  })

  it('drains an accepted sibling savepoint before root rollback', async () => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    await expect(
      db.transaction(async (trx) => {
        await Promise.all([
          trx.transaction(async () => {
            throw new Error('first sibling failed')
          }),
          trx.transaction(async (second) => second.ping()),
        ])
      }),
    ).rejects.toThrow(/first sibling failed/i)

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'rollback to savepoint sp_1',
      'release savepoint sp_1',
      'savepoint sp_2',
      'select 1',
      'release savepoint sp_2',
      'rollback',
    ])
    await db.close()
  })

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
    expect(controls.events.at(-1)).toBe('provider-close')
  })

  it('excludes queries from complete migration DDL and cleanup', async () => {
    const ddlStarted = deferred()
    const finishDdl = deferred()
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) {
          ddlStarted.resolve()
          await finishDdl.promise
        }
      },
    })
    const Events = defineTable(
      'operation_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'public' },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const migration = db.migrate().execute()
    await ddlStarted.promise
    const query = db.ping()
    await Promise.resolve()
    expect(controls.openCount).toBe(1)
    finishDdl.resolve()
    await migration
    await query

    const firstRelease = controls.events.indexOf('release-end:1:reuse')
    const secondOpen = controls.events.indexOf('open:2')
    expect(firstRelease).toBeGreaterThan(-1)
    expect(secondOpen).toBeGreaterThan(firstRelease)
    expect(
      controls.calls
        .filter((entry) => entry.session === 1)
        .some((entry) => /pg_advisory_unlock/i.test(entry.sql)),
    ).toBe(true)
    await db.close()
  })

  it('discards a migration session when rollback and unlock cleanup fail', async () => {
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) throw new Error('primary DDL failure')
        if (/^rollback$/i.test(sql)) throw new Error('rollback cleanup failure')
        if (/pg_advisory_unlock/i.test(sql)) throw new Error('unlock cleanup failure')
      },
    })
    const Events = defineTable(
      'cleanup_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'public' },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    await expect(db.migrate().execute()).rejects.toThrow(/primary DDL failure/i)
    expect(controls.events).toContain('release-start:1:discard')
    await db.close()
  })

  it('keeps a runtime DDL failure primary when provider release also fails', async () => {
    const releaseCause = new Error('secondary provider release failure')
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/^create table/i.test(sql)) throw new Error('primary runtime DDL failure')
      },
      releaseFailure: {
        session: 1,
        value: releaseCause,
      },
    })
    const Events = defineTable(
      'primary_runtime_failure_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'public' },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'ddl',
      outcome: 'rolledBack',
      retryable: false,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: releaseCause }],
    })
    expect((error as Error).message).toMatch(/primary runtime DDL failure/i)
    expect((error as Error).message).not.toMatch(/secondary provider release failure/i)
    await db.close()
  })

  it('normalizes provider-open failure before the migration callback', async () => {
    const openCause = new Error('migration provider open failed')
    const controls = createControllableProvider({
      openFailure: { session: 1, value: openCause },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'sessionCleanup',
      outcome: 'unchanged',
      retryable: false,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: openCause }],
    })
    await db.close()
  })

  it('reports advisory unlock failure after a committed no-op and discards', async () => {
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/pg_advisory_unlock/i.test(sql)) throw new Error('unlock cleanup failure')
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'unlock',
      outcome: 'unchanged',
      retryable: false,
      cleanupFailures: [{ stage: 'unlock' }],
    })
    expect(controls.events).toContain('release-start:1:discard')
    await db.close()
  })

  it('reports an unverified advisory unlock and discards', async () => {
    const controls = createControllableProvider({ unlockResult: false })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'unlock',
      outcome: 'unchanged',
      retryable: false,
    })
    expect(controls.events).toContain('release-start:1:discard')
    await db.close()
  })

  it('reports provider release failure after committed DDL as applied session cleanup', async () => {
    const releaseCause = new Error('provider release failed after DDL')
    const controls = createControllableProvider({
      releaseFailure: { session: 1, value: releaseCause },
    })
    const Events = defineTable(
      'release_failure_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'public' },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'sessionCleanup',
      outcome: 'applied',
      retryable: false,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: releaseCause }],
    })
    await db.close()
  })

  it('reports provider release failure after a committed no-op as unchanged cleanup', async () => {
    const releaseCause = new Error('provider release failed after no-op')
    const controls = createControllableProvider({
      releaseFailure: { session: 1, value: releaseCause },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'sessionCleanup',
      outcome: 'unchanged',
      retryable: false,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: releaseCause }],
    })
    await db.close()
  })

  it('discards after migration lock acquisition fails', async () => {
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/pg_try_advisory_lock\(/i.test(sql)) {
          throw new Error('lock acquisition failure')
        }
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'lock',
      outcome: 'unchanged',
      retryable: false,
    })
    expect((error as Error).message).toMatch(/lock acquisition failure/i)
    expect(controls.events).toContain('release-start:1:discard')
    expect(controls.calls.some((entry) => /pg_advisory_unlock/i.test(entry.sql))).toBe(
      false,
    )
    await db.close()
  })

  it('cancels the physical session when a lock try never settles', async () => {
    const lockStarted = deferred()
    let rejectLock!: (cause: Error) => void
    const hangingLock = new Promise<void>((_, reject) => {
      rejectLock = reject
    })
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/pg_try_advisory_lock/i.test(sql)) {
          lockStarted.resolve()
          await hangingLock
        }
      },
      beforeCancel: async () => {
        rejectLock(new Error('cancelled hanging lock query'))
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const controller = new AbortController()
    const migration = db.migrate().execute({ signal: controller.signal })
    await lockStarted.promise
    controller.abort()
    const error = await migration.catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })
    expect(controls.events).toContain('cancel:1')
    expect(controls.events).toContain('release-start:1:discard')
    expect(
      controls.calls.some((entry) => /^begin|pg_advisory_unlock/i.test(entry.sql)),
    ).toBe(false)
    await db.close()
  })

  it('discards after an ambiguous migration commit failure', async () => {
    const controls = createControllableProvider({
      beforeCall: async (_session, sql) => {
        if (/^commit$/i.test(sql)) throw new Error('commit outcome unknown')
      },
    })
    const Events = defineTable(
      'ambiguous_commit_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'public' },
    )
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [Events],
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'commit',
      outcome: 'unknown',
      retryable: false,
    })
    expect((error as Error).message).toMatch(/commit outcome unknown/i)
    expect(controls.calls.some((entry) => /^rollback$/i.test(entry.sql))).toBe(false)
    expect(controls.events).toContain('release-start:1:discard')
    await db.close()
  })

  it('gives query, transaction, dry-run, and migration distinct FIFO root slots', async () => {
    const firstCall = deferred()
    const finishFirst = deferred()
    const controls = createControllableProvider({
      beforeCall: async (session) => {
        if (session === 1) {
          firstCall.resolve()
          await finishFirst.promise
        }
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const query = db.ping()
    await firstCall.promise
    const transaction = db.transaction(async (trx) => trx.ping())
    const dryRun = db.migrate().dryRun()
    const migration = db.migrate().execute()
    expect(controls.openCount).toBe(1)
    finishFirst.resolve()
    await Promise.all([query, transaction, dryRun, migration])

    expect(controls.events.filter((event) => event.startsWith('open:'))).toEqual([
      'open:1',
      'open:2',
      'open:3',
      'open:4',
    ])
    expect(
      controls.calls.some((entry) => entry.session === 2 && entry.sql === 'begin'),
    ).toBe(true)
    expect(
      controls.calls.some(
        (entry) => entry.session === 3 && /current_database\(\)/i.test(entry.sql),
      ),
    ).toBe(true)
    expect(
      controls.calls.some(
        (entry) => entry.session === 4 && /pg_try_advisory_lock/i.test(entry.sql),
      ),
    ).toBe(true)
    await db.close()
  })

  it('drains accepted operations and releases them before provider close', async () => {
    const firstStarted = deferred()
    const finishFirst = deferred()
    const controls = createControllableProvider({
      beforeCall: async (session) => {
        if (session === 1) {
          firstStarted.resolve()
          await finishFirst.promise
        }
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const first = db.ping()
    await firstStarted.promise
    const second = db.ping()
    const close = db.close()
    const sameClose = db.close()
    expect(sameClose).toBe(close)
    await Promise.resolve()
    expect(controls.events).not.toContain('provider-close')
    finishFirst.resolve()
    await Promise.all([first, second, close])
    expect(controls.events.at(-1)).toBe('provider-close')
    expect(controls.events).toContain('release-end:2:reuse')
    await expect(db.ping()).rejects.toThrow(/closed/i)
  })

  it('returns one shutdown promise and preserves provider close rejection', async () => {
    const closeError = new Error('provider close failed')
    const controls = createControllableProvider({
      closeFailure: { value: closeError },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const first = db.close()
    const second = db.close()
    expect(second).toBe(first)
    await expect(first).rejects.toBe(closeError)
    const later = db.close()
    expect(later).toBe(first)
    await expect(later).rejects.toBe(closeError)
    expect(controls.closeCount).toBe(1)
  })

  it('preserves rejection with undefined from callbacks and release cleanup', async () => {
    const callbackControls = createControllableProvider()
    const callbackDb = createDatabase({
      connector: customConnector(),
      operationSessionProvider: callbackControls.provider,
      schemas: [],
    })
    const transaction = callbackDb.transaction(async () => {
      throw undefined
    })
    await expect(transaction).rejects.toBeUndefined()
    expect(callbackControls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'rollback',
    ])
    await callbackDb.close()

    const releaseControls = createControllableProvider({
      releaseFailure: { session: 1, value: undefined },
    })
    const releaseDb = createDatabase({
      connector: customConnector(),
      operationSessionProvider: releaseControls.provider,
      schemas: [],
    })
    await expect(releaseDb.ping()).rejects.toMatchObject({
      _tag: 'QueryError',
      cause: undefined,
    })
    await expect(releaseDb.ping()).resolves.toBeUndefined()
    expect(releaseControls.openCount).toBe(2)
    await releaseDb.close()
  })

  it('rejects custom providers without mandatory native transaction semantics', () => {
    expect(() =>
      createDatabase({
        connector: customConnector(),
        operationSessionProvider: { open() {}, close() {} } as never,
        schemas: [],
      }),
    ).toThrow(/native transaction semantics/i)
  })
})
