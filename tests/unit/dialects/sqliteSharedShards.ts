import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { number, pipe } from 'valibot'

import { executeSqliteMigration } from '@/dialects/sqlite/migration/runtime'
import { createDb0NodeSqliteOperationSessionProvider } from '@/dialects/sqlite/operationSession'
import { column, defineTable } from '@/index'
import type { Executor } from '@/query'
import { MigrationError } from '@/utils/error'

import { createControllableProvider } from '../helpers/operationSessionFixtures'

import type {
  CoordinationContractEvent,
  CoordinationContractFactory,
  CoordinationContractLockManager,
} from './migrationCoordinationContract'
import type { ProviderContractFactoryOptions } from './operationSessionProviderContract'

/** Supplies the catalog observations needed by controlled SQLite migration scenarios. */
function controlledProviderQueryRows(sql: string, created: boolean): unknown[] {
  if (sql === 'pragma busy_timeout') return [{ timeout: 0 }]
  if (sql === 'pragma foreign_keys') return [{ foreign_keys: 0 }]
  if (sql === 'pragma main.integrity_check') return [{ integrity_check: 'ok' }]
  if (sql === 'pragma main.foreign_key_check') return []
  if (sql.includes('sqlite_version()')) return [{ version: '3.50.0' }]
  if (sql.includes('pragma_database_list')) return [{ seq: 0, name: 'main', file: '' }]

  if (sql.includes('pragma_table_list'))
    return created
      ? [
          {
            schema: 'main',
            name: 'provider_contract_events',
            type: 'table',
            ncol: 1,
            wr: 0,
            strict: 0,
          },
        ]
      : []

  if (sql.includes('sqlite_schema'))
    return created
      ? [
          {
            type: 'table',
            name: 'provider_contract_events',
            tbl_name: 'provider_contract_events',
            sql: 'CREATE TABLE provider_contract_events (id INTEGER PRIMARY KEY NOT NULL)',
          },
        ]
      : []

  if (sql.includes('pragma_table_xinfo'))
    return [
      {
        cid: 0,
        name: 'id',
        type: 'INTEGER',
        column_notnull: 1,
        dflt_value: null,
        pk: 1,
        hidden: 0,
      },
    ]

  return []
}

/** Adapts native SQLite calls to the reusable semantic session lifecycle. */
function createCommonRuntime() {
  const native = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const events: ('query' | 'run' | 'cancel' | 'release:reuse' | 'close')[] = []
  return {
    provider: {
      nativeTransactions: true as const,
      /** Opens the real DatabaseSync lease and records semantic calls. */
      async open() {
        const session = await native.open()
        return {
          identity: session.identity,
          /** Runs the contract's query through StatementSync.all. */
          async query() {
            events.push('query')
            return session.query({ sql: 'select 1', params: [] })
          },
          /** Runs the contract's command through StatementSync.run. */
          async run() {
            events.push('run')
            return session.run({ sql: 'pragma user_version=1', params: [] })
          },
          /** Poisons the real lease. */
          async cancel() {
            events.push('cancel')
            await session.cancel()
          },
          /** Releases the lease with its requested disposition. */
          async release(disposition: 'reuse' | 'discard') {
            if (disposition === 'reuse') events.push('release:reuse')

            await session.release(disposition)
          },
        }
      },
      /** Closes the native provider. */
      async close() {
        events.push('close')
        await native.close()
      },
    },
    /** Returns the semantic lifecycle recorded by the adapter. */
    events: () => events,
  }
}

export const sqliteOperationSessionContractShard = {
  operationSession: {
    state: 'supported',
    common: { state: 'supported', input: { createRuntime: createCommonRuntime } },
    controlled: {
      state: 'supported',
      input: {
        createProvider: (options?: ProviderContractFactoryOptions) => {
          let created = false
          return createControllableProvider({
            ...options,
            beforeCall: async (session, sql) => {
              await options?.beforeCall?.(session, sql)

              if (/^create table/i.test(sql)) created = true
            },
            queryRows: (sql: string) => controlledProviderQueryRows(sql, created),
          })
        },
        migration: {
          state: 'supported',
          input: {
            connector: () => nodeSqliteConnector({ name: ':memory:' }),
            appliedSchemas: () => [
              defineTable(
                'provider_contract_events',
                {
                  id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })),
                },
                { primaryKey: 'id' },
              ),
            ],
            planningFailureSchemas: () => [
              defineTable(
                'provider_planning_events',
                {
                  id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })),
                },
                { primaryKey: 'id' },
              ),
              defineTable(
                'provider_planning_events',
                {
                  id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })),
                },
                { primaryKey: 'id', namespace: [{ role: 'database', spelling: 'main' }] },
              ),
            ],
          },
        },
      },
    },
  },
} as const

type CoordinationOptions = Parameters<CoordinationContractFactory>[0]
type Controls = NonNullable<CoordinationOptions>
const COORDINATION_KEY = 'sqlite-main-file'

/** Creates one lock manager when the shared contract does not supply one. */
function localLocks(): CoordinationContractLockManager {
  let owner: string | undefined
  return {
    /** Claims the fixture's native writer slot. */
    tryAcquire(client) {
      if (owner) return owner === client

      owner = client
      return true
    },
    /** Releases the fixture's native writer slot. */
    release(client) {
      if (owner === client) owner = undefined
    },
  }
}

/** Converts SQLite's busy-policy cleanup into the contract's semantic release event. */
function semanticReleaseError(cause: unknown): never {
  if (cause instanceof MigrationError && cause.stage === 'sessionCleanup') {
    throw new MigrationError({
      message: cause.message,
      cause: cause.cause,
      stage: 'unlock',
      outcome: cause.outcome,
      retryable: cause.retryable,
      cleanupFailures: [{ stage: 'unlock', cause: cause.cause }],
    })
  }

  throw cause
}

/** Supplies physical BEGIN/COMMIT behavior to the production migration runtime. */
function coordinationExecutor(
  emit: (event: CoordinationContractEvent) => void,
  manager: CoordinationContractLockManager,
  client: string,
  lockResults: boolean[],
  releaseResults: boolean[],
): Executor {
  return {
    /** Reads SQLite's current busy policy for the actual migration runtime. */
    async execute(query) {
      if (query.sql === 'pragma busy_timeout') return [{ timeout: 125 }]
      if (query.sql === 'pragma foreign_keys') return [{ foreign_keys: 0 }]
      if (query.sql === 'pragma main.foreign_key_check') return []
      if (query.sql === 'pragma main.integrity_check') return [{ integrity_check: 'ok' }]

      emit('introspection')
      return []
    },
    /** Executes the actual runtime's physical command sequence against writer controls. */
    async run(query) {
      if (query.sql.startsWith('pragma foreign_keys=')) return

      if (query.sql === 'begin immediate') {
        emit('acquire')

        if (
          lockResults.shift() === false ||
          !manager.tryAcquire(client, COORDINATION_KEY)
        )
          throw Object.assign(new Error('SQLite writer busy'), { code: 'SQLITE_BUSY' })

        emit('transaction')
        return
      }

      if (query.sql === 'commit' || query.sql === 'rollback') {
        manager.release(client, COORDINATION_KEY)
        emit('release')
        return
      }

      if (query.sql.startsWith('pragma busy_timeout=')) {
        if (query.sql !== 'pragma busy_timeout=0' && releaseResults.shift() === false)
          throw new Error('busy policy restoration failed')

        return
      }

      emit('ddl')
    },
  }
}

/** Runs the production runtime through one contract-controlled physical executor. */
async function executeCoordination(
  executor: Executor,
  controls: Controls,
  emit: (event: CoordinationContractEvent) => void,
  hold: Promise<void>,
  runtimeOptions: { lockTimeoutMs?: number; signal?: AbortSignal },
): Promise<{ outcome: 'applied' | 'unchanged' }> {
  try {
    return await executeSqliteMigration({
      executor,
      databaseIdentity: COORDINATION_KEY,
      discard: () => undefined,
      cancel: async () => undefined,
      /** Holds the writer after BEGIN to exercise exclusion. */
      async prepare() {
        emit('introspection')

        if (controls.holdAfterTransaction) await hold

        return {
          atomicity: 'plan-atomic',
          preconditions: [],
          actions: controls.noWork
            ? []
            : [
                {
                  sourceStepIndexes: [0],
                  transaction: 'allowed',
                  statements: [
                    { sql: 'create table contract_record (id integer)', params: [] },
                  ],
                },
              ],
        }
      },
      ...runtimeOptions,
    })
  } catch (cause) {
    semanticReleaseError(cause)
  }
}

/** Adapts actual BEGIN IMMEDIATE execution to dialect-neutral semantic events. */
const createSqliteCoordinationRuntime: CoordinationContractFactory = (options = {}) => {
  const controls: Controls = options
  const events: CoordinationContractEvent[] = []
  const listeners = new Map<CoordinationContractEvent, () => void>()
  const manager = controls.sharedLockManager ?? localLocks()
  const client = controls.clientId ?? 'single'
  let releaseHold!: () => void
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve
  })

  const lockResults = [...(controls.lockResults ?? [])]
  const releaseResults = [...(controls.releaseResults ?? [])]

  /** Records one physical coordination phase and wakes its contract waiter. */
  function emit(event: CoordinationContractEvent): void {
    events.push(event)
    listeners.get(event)?.()
  }

  const executor = coordinationExecutor(
    emit,
    manager,
    client,
    lockResults,
    releaseResults,
  )

  return {
    /** Executes the production SQLite migration algorithm with semantic SQL controls. */
    execute: (runtimeOptions = {}) =>
      executeCoordination(executor, controls, emit, hold, runtimeOptions),
    /** Returns dialect-neutral phases observed by the physical SQL adapter. */
    events: () => events,
    /** Lets the protected migration finish. */
    releaseHold,
    /** Resolves after one requested semantic phase is observed. */
    waitFor: (event) =>
      events.includes(event)
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            listeners.set(event, resolve)
          }),
  }
}

export const sqliteCoordinationContractShard = {
  coordination: { state: 'supported', input: createSqliteCoordinationRuntime },
} as const
