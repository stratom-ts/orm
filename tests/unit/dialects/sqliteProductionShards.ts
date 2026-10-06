import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { integer, nullable, number, pipe, string } from 'valibot'
import { vi } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationSemanticProfile } from '@/ddl/migrationPlan'
import type { MigrationCapabilityIssue } from '@/ddl/migrationProgram'
import { sqliteDialect } from '@/dialects/sqlite'
import type { OperationCommand } from '@/dialects/types'
import { defineTable } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import type { MigrationContractCase } from './dialectContractKit'
import type { DialectLifecycleContractRuntime } from './dialectMemberContract'

const main = [{ role: 'database' as const, spelling: 'main' }]
const Records = defineTable(
  'contract_records',
  { id: pipe(number(), integer()), label: string() },
  { primaryKey: 'id' },
)

const Lifecycle = defineTable(
  'lifecycle_records',
  { id: pipe(number(), integer()), label: string(), note: nullable(string()) },
  { primaryKey: 'id' },
)

const migrationProgram: MigrationContractCase['expectedProgram'] = {
  atomicity: 'plan-atomic',
  preconditions: [],
  actions: [
    {
      sourceStepIndexes: [0],
      transaction: 'required',
      statements: [
        {
          sql: 'create table "main"."contract_records" ("id" INTEGER primary key not null, "label" TEXT not null)',
          params: [],
        },
      ],
    },
  ],
}

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

/** Builds an independently specified empty-catalog production lowering contract. */
export async function createSqliteMigrationCase(): Promise<MigrationContractCase> {
  const catalog = await sqliteDialect.catalog.introspectCatalog(
    {
      /** Observes an empty main database without assuming a production catalog shape. */
      execute: async ({ sql }) => {
        if (sql.includes('sqlite_version')) return [{ version: '3.50.0' }]

        if (sql.includes('pragma_database_list'))
          return [{ seq: 0, name: 'main', file: '' }]

        return []
      },
    },
    createCatalogRequest([Records], []),
  )

  const planned = planMigration([Records], catalog, sqliteDialect.migration.planning)
  const profile = planned.profile
  return {
    dialect: sqliteDialect,
    planned,
    profile,
    mismatchedProfiles: {
      identityAdapter: mismatch(
        { ...profile, identityAdapter: 'other' },
        'SQLite identity adapter does not match the executing Semantic Profile',
      ),
      namespaceContext: mismatch(
        {
          ...profile,
          namespaceContext: { writableDefault: [{ role: 'database', spelling: 'temp' }] },
        },
        'SQLite writable namespace context does not match the executing session',
      ),
      registrationDefault: mismatch(
        { ...profile, registrationDefault: main },
        'SQLite registration default does not match the executing configuration',
      ),
    },
    expectedProgram: migrationProgram,
  }
}

/** Specifies the capability evidence expected for one profile mismatch. */
function mismatch(profile: MigrationSemanticProfile, message: string) {
  return {
    profile,
    issues: [{ code: 'profile_mismatch' as const, message, sourceStepIndexes: [] }],
  }
}

/** Exercises unsupported structured targets through the same production lowerer. */
export async function createSqliteUnsupportedCase() {
  const base = await createSqliteMigrationCase()
  const relation = {
    namespace: [
      {
        role: 'database' as const,
        identifier: { spelling: 'temp', comparisonKey: 'temp' },
      },
    ],
    relation: { spelling: 'records', comparisonKey: 'records' },
  }

  const issue: MigrationCapabilityIssue = {
    code: 'invalid_target',
    message: 'SQLite migration targets must use database:main',
    sourceStepIndexes: [0],
  }

  return {
    dialect: sqliteDialect,
    profile: base.profile,
    planned: {
      ...base.planned,
      plan: {
        steps: [
          {
            kind: 'drop_table' as const,
            target: { kind: 'relation' as const, relation },
          },
        ],
      },
    },
    issue,
  }
}

/**
 * Records public lifecycle calls around the real connector and selected production
 * facets.
 */
export function createSqliteLifecycleRuntime(): DialectLifecycleContractRuntime {
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
      (await connector.getInstance!())
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
    (selected) => {
      state.selected = selected as typeof connector
      const provider = createProvider(selected)
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
