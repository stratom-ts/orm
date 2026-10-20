import { integer, nullable, number, pipe, string } from 'valibot'
import { vi } from 'vitest'

import type { MigrationSemanticProfile } from '@/ddl/migrationPlan'
import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationCapabilityIssue } from '@/ddl/migrationProgram'
import { sqliteDialect } from '@/dialects/sqlite'
import type { OperationCommand } from '@/dialects/types'
import { defineTable } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

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

/** Runs the public lifecycle against deterministic SQLite catalog and session controls. */
export function createSqliteLifecycleRuntime(): DialectLifecycleContractRuntime {
  const connector = customConnector('sqlite')
  const state: LifecycleState = { migrated: false, disposed: false }

  const commands: OperationCommand[] = []
  const compile = sqliteDialect.operations.compile.bind(sqliteDialect.operations)
  vi.spyOn(sqliteDialect.operations, 'compile').mockImplementation((command) => {
    commands.push(command)
    return compile(command)
  })

  recordLifecycleProvider(state)

  const directPrepare = vi.fn<() => unknown>()
  vi.spyOn(connector, 'prepare').mockImplementation(() => {
    directPrepare()
    throw new Error('connector methods must go through the provider')
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
    postMigrationState: () =>
      state.migrated ? ['id', 'label', 'note'] : ['id', 'label'],
    migration: lifecycleMigration,
  }
}

const lifecycleColumns = [
  {
    cid: 0,
    name: 'id',
    type: 'INTEGER',
    column_notnull: 1,
    dflt_value: null,
    pk: 1,
    hidden: 0,
  },
  {
    cid: 1,
    name: 'label',
    type: 'TEXT',
    column_notnull: 1,
    dflt_value: null,
    pk: 0,
    hidden: 0,
  },
  {
    cid: 2,
    name: 'note',
    type: 'TEXT',
    column_notnull: 0,
    dflt_value: null,
    pk: 0,
    hidden: 0,
  },
]

/** Supplies independently authored catalog rows before and after the add-column action. */
function lifecycleRows(sql: string, migrated: boolean): unknown[] {
  if (sql === 'pragma busy_timeout') return [{ timeout: 0 }]
  if (sql === 'pragma foreign_keys') return [{ foreign_keys: 0 }]
  if (sql === 'pragma main.integrity_check') return [{ integrity_check: 'ok' }]
  if (sql.includes('sqlite_version()')) return [{ version: '3.50.0' }]
  if (sql.includes('pragma_database_list')) return [{ seq: 0, name: 'main', file: '' }]

  if (sql.includes('pragma_table_list'))
    return [
      {
        schema: 'main',
        name: 'lifecycle_records',
        type: 'table',
        ncol: migrated ? 3 : 2,
        wr: 0,
        strict: 0,
      },
    ]

  if (sql.includes('sqlite_schema'))
    return [
      {
        type: 'table',
        name: 'lifecycle_records',
        tbl_name: 'lifecycle_records',
        sql: `CREATE TABLE lifecycle_records (id INTEGER PRIMARY KEY NOT NULL, label TEXT NOT NULL${migrated ? ', note TEXT' : ''})`,
      },
    ]

  if (sql.includes('pragma_table_xinfo'))
    return migrated ? lifecycleColumns : lifecycleColumns.slice(0, 2)

  if (sql.startsWith('select') && sql.includes('"lifecycle_records"'))
    return [{ id: 1, label: 'connector-selected' }]

  return []
}

type LifecycleState = {
  migrated: boolean
  disposed: boolean
  selected?: DialectLifecycleContractRuntime['connector']
  params?: readonly unknown[]
}

/** Records selected-provider ownership and query bindings around generic session controls. */
function recordLifecycleProvider(state: LifecycleState): void {
  const controls = createControllableProvider({
    beforeCall: async (_session, sql) => {
      if (sql === 'alter table "main"."lifecycle_records" add column "note" TEXT')
        state.migrated = true
    },
    queryRows: (sql) => lifecycleRows(sql, state.migrated),
  })

  vi.spyOn(sqliteDialect.operations, 'createSessionProvider').mockImplementation(
    (selected) => {
      state.selected = selected
      return {
        ...controls.provider,
        async open() {
          const session = await controls.provider.open()
          return {
            ...session,
            async query(query) {
              if (query.params.includes('connector-selected')) state.params = query.params

              return session.query(query)
            },
          }
        },
        async close() {
          await controls.provider.close()
          state.disposed = true
        },
      }
    },
  )
}
