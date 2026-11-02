import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { integer, nullable, number, pipe, string } from 'valibot'
import { vi } from 'vitest'

import { sqliteDialect } from '@/dialects/sqlite'
import { createDb0NodeSqliteOperationSessionProvider } from '@/dialects/sqlite/operationSession'
import type { OperationCommand } from '@/dialects/types'
import { defineTable } from '@/index'

import type { DialectLifecycleContractRuntime } from '../../unit/dialects/dialectMemberContract'

const Lifecycle = defineTable(
  'lifecycle_records',
  { id: pipe(number(), integer()), label: string(), note: nullable(string()) },
  { primaryKey: 'id' },
)

const lifecycleMigration: DialectLifecycleContractRuntime['migration'] = {
  state: 'supported',
  expectedPlan: {
    steps: [
      {
        kind: 'add_column',
        target: {
          kind: 'column',
          relation: {
            namespace: [
              {
                role: 'database',
                identifier: { spelling: 'main', comparisonKey: 'main' },
              },
            ],
            relation: {
              spelling: 'lifecycle_records',
              comparisonKey: 'lifecycle_records',
            },
          },
          column: { spelling: 'note', comparisonKey: 'note' },
        },
        dataType: 'TEXT',
        notNull: false,
      },
    ],
  },
  expectedPostMigrationState: ['id', 'label', 'note'],
}

/**
 * Records public lifecycle calls around the real connector and selected production
 * facets.
 */
function createNativeSqliteLifecycleRuntime(): DialectLifecycleContractRuntime {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const state = {
    initialized: false,
    disposed: false,
    selected: undefined as typeof connector | undefined,
    params: undefined as readonly unknown[] | undefined,
  }

  const commands: OperationCommand[] = []
  const compile = sqliteDialect.operations.compile.bind(sqliteDialect.operations)
  vi.spyOn(sqliteDialect.operations, 'compile').mockImplementation((command) => {
    commands.push(command)
    return compile(command)
  })

  recordProvider(connector, state)
  const directPrepare = vi.fn<() => unknown>()
  const prepare = connector.prepare.bind(connector)
  vi.spyOn(connector, 'prepare').mockImplementation((sql) => {
    directPrepare()
    return prepare(sql)
  })

  return {
    dialect: sqliteDialect,
    registerDialect: false,
    connector,
    schemas: [Lifecycle],
    executeQuery: (database) =>
      database
        .from(Lifecycle)
        .select([Lifecycle.id, Lifecycle.label])
        .where(Lifecycle.label, 'eq', 'connector-selected')
        .execute(),
    operationCommands: commands,
    selectedConnector: () => state.selected,
    disposed: () => state.disposed,
    queryParams: () => state.params,
    foreignPolicyLeak: () => false,
    directConnectorMethods: [directPrepare],
    expected: {
      queryRows: [{ id: 1, label: 'connector-selected' }],
      queryParam: 'connector-selected',
    },
    postMigrationState: async () =>
      (await connector.getInstance())
        .prepare('pragma table_info(lifecycle_records)')
        .all()
        .map((row) => row.name),
    migration: lifecycleMigration,
  }
}

type LifecycleState = {
  initialized: boolean
  disposed: boolean
  selected?: ReturnType<typeof nodeSqliteConnector>
  params?: readonly unknown[]
}

/** Wraps session observation while retaining the exact native production provider. */
function recordProvider(
  connector: ReturnType<typeof nodeSqliteConnector>,
  state: LifecycleState,
): void {
  const createProvider = sqliteDialect.operations.createSessionProvider.bind(
    sqliteDialect.operations,
  )

  vi.spyOn(sqliteDialect.operations, 'createSessionProvider').mockImplementation(
    (selected, dialectId) => {
      state.selected = selected as typeof connector
      const provider = createProvider(selected, dialectId)
      return {
        ...provider,
        /** Seeds representative query data once on the actual pinned native session. */
        open: async () => {
          const session = await provider.open()

          if (!state.initialized) {
            await session.run({
              sql: 'create table lifecycle_records(id INTEGER primary key, label TEXT not null)',
              params: [],
            })

            await session.run({
              sql: 'insert into lifecycle_records values(1, ?)',
              params: ['connector-selected'],
            })

            state.initialized = true
          }

          return {
            ...session,
            /** Records only representative public-query bindings. */
            query: async (query) => {
              if (query.params.includes('connector-selected')) state.params = query.params

              return session.query(query)
            },
          }
        },
        /** Observes acknowledged native disposal after the public Client closes. */
        close: async () => {
          await provider.close()
          state.disposed = true
        },
      }
    },
  )
}

/** Adapts native SQLite calls to the reusable semantic session lifecycle. */
function createNativeSqliteCommonRuntime() {
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

export { createNativeSqliteLifecycleRuntime, createNativeSqliteCommonRuntime }
