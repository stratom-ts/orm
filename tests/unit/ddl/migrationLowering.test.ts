import { pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import type { MigrationSemanticProfile, PlannedMigration } from '@/ddl/migrationPlan'
import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationProgram } from '@/ddl/migrationProgram'
import { column, defineTable, postgresDialect, reference } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import type { PostgresCatalogSnapshotFixture as CatalogSnapshot } from '../helpers/catalog'
import { completePostgresCatalog } from '../helpers/catalog'

const namespaceContext = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' }, unique: true })),
  },
  {
    primaryKey: 'id',
    namespace: [{ role: 'schema', spelling: 'public' }],
    indexes: [{ columns: ['email'] }],
  },
)

const Posts = defineTable(
  'posts',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    authorId: reference(Users, 'id', { onDelete: 'cascade' }),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

function emptyCatalog(): CatalogSnapshot {
  return {
    namespaceContext,
    tables: [],
    nameReservations: [],
    constraintNameReservations: [],
  }
}

function plan(catalog: CatalogSnapshot = emptyCatalog()): PlannedMigration {
  const schemas = [Users, Posts]
  return planMigration(
    schemas,
    completePostgresCatalog(catalog, createCatalogRequest(schemas, [])),
    postgresDialect,
  )
}

const expectedProfile: MigrationSemanticProfile = {
  identityAdapter: 'postgresql',
  namespaceContext,
}

function lower(planned: PlannedMigration, profile = expectedProfile): MigrationProgram {
  const result = postgresDialect.migration!.lower(planned, profile)
  if (result.issues)
    throw new Error(result.issues.map((issue) => issue.message).join('\n'))
  return result.program
}

describe('PostgreSQL whole-plan lowering', () => {
  it('lowers an empty plan to an exact zero-action program', () => {
    const planned = plan()

    expect(
      postgresDialect.migration!.lower(
        { ...planned, plan: { steps: [] } },
        expectedProfile,
      ),
    ).toEqual({
      program: {
        atomicity: 'plan-atomic',
        preconditions: [],
        actions: [],
      },
    })
  })

  it('lowers one semantic step to one exact action with its source provenance', () => {
    const planned = plan()
    const audit = planned.identities.resolveNamespace([
      { role: 'schema', spelling: 'audit' },
    ])

    expect(
      postgresDialect.migration!.lower(
        {
          ...planned,
          plan: {
            steps: [
              {
                kind: 'ensure_namespace',
                target: { kind: 'namespace', namespace: audit },
              },
            ],
          },
        },
        expectedProfile,
      ),
    ).toEqual({
      program: {
        atomicity: 'plan-atomic',
        preconditions: [],
        actions: [
          {
            sourceStepIndexes: [0],
            transaction: 'required',
            statements: [{ sql: 'create schema if not exists "audit"', params: [] }],
          },
        ],
      },
    })
  })

  it('compiles a plan-atomic program with canonical source provenance', () => {
    const program = lower(plan())

    expect(program).toEqual({
      atomicity: 'plan-atomic',
      preconditions: [],
      actions: [
        {
          sourceStepIndexes: [0],
          transaction: 'required',
          statements: [
            {
              sql: 'create table "public"."posts" ("id" uuid not null, "authorId" uuid not null, constraint "posts_id__974c7fecddd5ce59_pkey" primary key ("id"))',
              params: [],
            },
          ],
        },
        {
          sourceStepIndexes: [1],
          transaction: 'required',
          statements: [
            {
              sql: 'create table "public"."users" ("id" uuid not null, "email" text not null constraint "users_email__fbe036e21ce3ec59_key" unique, constraint "users_id__c2b82cf39bf9f504_pkey" primary key ("id"))',
              params: [],
            },
          ],
        },
        {
          sourceStepIndexes: [2],
          transaction: 'required',
          statements: [
            {
              sql: 'create index "users_email__2532f63e0a33e664_idx" on "public"."users" ("email")',
              params: [],
            },
          ],
        },
        {
          sourceStepIndexes: [3],
          transaction: 'required',
          statements: [
            {
              sql: 'alter table "public"."posts" add constraint "posts_authorId__6c2aebd50afe2836_fkey" foreign key ("authorId") references "public"."users" ("id") on delete CASCADE',
              params: [],
            },
          ],
        },
      ],
    })
  })

  it('removes fresh foreign keys from table creation and defers them until both tables exist', () => {
    const statements = lower(plan()).actions.flatMap((action) => action.statements)
    const postsCreate = statements.find((statement) =>
      /create table "public"\."posts"/i.test(statement.sql),
    )
    const usersCreateIndex = statements.findIndex((statement) =>
      /create table "public"\."users"/i.test(statement.sql),
    )
    const foreignKeyIndex = statements.findIndex((statement) =>
      /foreign key \("authorId"\)/i.test(statement.sql),
    )

    expect(postsCreate?.sql).not.toContain('references')
    expect(foreignKeyIndex).toBeGreaterThan(usersCreateIndex)
    expect(statements[foreignKeyIndex]?.sql).toContain(
      'references "public"."users" ("id")',
    )
  })

  it('returns profile capability issues without a partial program', () => {
    const result = postgresDialect.migration!.lower(plan(), {
      identityAdapter: 'sqlite',
      namespaceContext: {
        writableDefault: [{ role: 'database', spelling: 'production' }],
      },
      registrationDefault: [{ role: 'database', spelling: 'other' }],
    })

    expect(result).toEqual({
      issues: [
        {
          code: 'profile_mismatch',
          message: "Executing profile adapter 'sqlite' does not match PostgreSQL",
          sourceStepIndexes: [],
        },
        {
          code: 'profile_mismatch',
          message:
            "Identity adapter 'postgresql' does not match executing adapter 'sqlite'",
          sourceStepIndexes: [],
        },
        {
          code: 'profile_mismatch',
          message: 'Registration default does not match the executing configuration',
          sourceStepIndexes: [],
        },
        {
          code: 'profile_mismatch',
          message: 'Writable namespace context does not match the executing session',
          sourceStepIndexes: [],
        },
      ],
    })
  })

  it.each([
    {
      field: 'PostgreSQL dialect adapter',
      plannedProfile: { ...expectedProfile, identityAdapter: 'sqlite-fixture' },
      executingProfile: { ...expectedProfile, identityAdapter: 'sqlite-fixture' },
      message: "Executing profile adapter 'sqlite-fixture' does not match PostgreSQL",
    },
    {
      field: 'identity adapter',
      plannedProfile: {
        ...expectedProfile,
        identityAdapter: 'sqlite-fixture',
      },
      executingProfile: expectedProfile,
      message:
        "Identity adapter 'sqlite-fixture' does not match executing adapter 'postgresql'",
    },
    {
      field: 'writable namespace context',
      plannedProfile: expectedProfile,
      executingProfile: {
        ...expectedProfile,
        namespaceContext: {
          writableDefault: [
            { role: 'database' as const, spelling: 'test' },
            { role: 'schema' as const, spelling: 'tenant' },
          ],
        },
      },
      message: 'Writable namespace context does not match the executing session',
    },
    {
      field: 'registration default',
      plannedProfile: expectedProfile,
      executingProfile: {
        ...expectedProfile,
        registrationDefault: [{ role: 'schema' as const, spelling: 'tenant' }],
      },
      message: 'Registration default does not match the executing configuration',
    },
  ])('rejects a mismatched $field before physical step compilation', (testCase) => {
    const planned = plan()
    const traversal = vi.fn(() => {
      throw new Error('step traversal started after a profile mismatch')
    })
    const compilation = vi.fn(() => {
      throw new Error('physical step compilation started after a profile mismatch')
    })
    const relation = planned.identities.resolve({ relation: 'users' })
    const guardedStep = {
      kind: 'add_column' as const,
      target: {
        kind: 'column' as const,
        relation,
        column: planned.identities.member('column', 'guarded_column'),
      },
      get dataType(): string {
        compilation()
        return 'text'
      },
      notNull: false,
    }
    const guardedPlan = {
      ...planned,
      profile: testCase.plannedProfile,
      plan: {
        get steps() {
          traversal()
          return [guardedStep]
        },
      },
    }

    const result = postgresDialect.migration!.lower(
      guardedPlan,
      testCase.executingProfile,
    )

    expect(traversal).not.toHaveBeenCalled()
    expect(compilation).not.toHaveBeenCalled()
    expect(result.program).toBeUndefined()
    expect(result.issues).toEqual([
      {
        code: 'profile_mismatch',
        message: testCase.message,
        sourceStepIndexes: [],
      },
    ])
  })

  it('treats an empty registration default as none', () => {
    expect(
      postgresDialect.migration!.lower(plan(), {
        ...expectedProfile,
        registrationDefault: [],
      }).issues,
    ).toBeUndefined()
  })

  it('accepts equivalent spellings of one resolved registration default', () => {
    const schemas = [Users, Posts]
    const registrationDefault = [{ role: 'schema' as const, spelling: 'public' }]
    const planned = planMigration(
      schemas,
      completePostgresCatalog(
        emptyCatalog(),
        createCatalogRequest(schemas, [], registrationDefault),
      ),
      postgresDialect,
      { registrationDefault },
    )

    expect(
      postgresDialect.migration!.lower(planned, {
        ...expectedProfile,
        registrationDefault: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'public' },
        ],
      }).issues,
    ).toBeUndefined()
  })

  it('returns every deterministic issue and no partial program for malformed steps', () => {
    const planned = plan()
    const users = planned.identities.resolve({ relation: 'users' })
    const otherDatabase = {
      ...users,
      namespace: users.namespace.map((segment) =>
        segment.role === 'database'
          ? {
              ...segment,
              identifier: { spelling: 'other', comparisonKey: 'other' },
            }
          : segment,
      ),
    }
    const malformed: PlannedMigration = {
      ...planned,
      plan: {
        steps: [
          {
            kind: 'drop_table',
            target: { kind: 'relation', relation: otherDatabase },
          },
          {
            kind: 'create_table',
            target: { kind: 'relation', relation: users },
          },
          {
            kind: 'alter_column_type',
            target: {
              kind: 'column',
              relation: users,
              column: planned.identities.member('column', 'email'),
            },
            dataType: 'text; select 1',
          },
        ],
      },
      desiredTables: planned.identities.createRegistry(),
    }
    const result = postgresDialect.migration!.lower(malformed, expectedProfile)

    expect(result).toEqual({
      issues: [
        {
          code: 'invalid_target',
          message:
            'Migration target namespace database "other" does not match executing database "test"',
          sourceStepIndexes: [0],
        },
        {
          code: 'missing_desired_table',
          message:
            'Cannot create table [database:"test", schema:"public", relation:"users"]: lowered desired table not found',
          sourceStepIndexes: [1],
        },
        {
          code: 'compile_failure',
          message:
            'Cannot compile migration step 2: unsafe column data type: "text; select 1"',
          sourceStepIndexes: [2],
        },
      ],
    })
    expect(postgresDialect.migration!.lower(malformed, expectedProfile)).toEqual(result)
  })

  it('orders child table drops before retained catalog parents', () => {
    const planned = plan()
    const parent = planned.identities.resolve({
      namespace: [{ role: 'schema', spelling: 'public' }],
      relation: 'users',
    })
    const child = planned.identities.resolve({
      namespace: [{ role: 'schema', spelling: 'public' }],
      relation: 'posts',
    })
    const dropPlan: PlannedMigration = {
      ...planned,
      plan: {
        steps: [
          { kind: 'drop_table', target: { kind: 'relation', relation: parent } },
          { kind: 'drop_table', target: { kind: 'relation', relation: child } },
        ],
      },
      planningCatalog: {
        ...planned.planningCatalog,
        tables: [
          {
            identity: parent,
            columns: [],
            indexes: [],
            primaryKey: null,
            uniqueConstraints: [],
            foreignKeys: [],
            opaqueObjects: [],
          },
          {
            identity: child,
            columns: [],
            indexes: [],
            primaryKey: null,
            uniqueConstraints: [],
            foreignKeys: [
              {
                name: 'posts_author_fkey',
                columns: ['authorId'],
                semanticCompleteness: 'supportedSimple',
                isValid: true,
                referencedRelation: parent,
                referencedColumns: ['id'],
                onDelete: 'no action',
                onUpdate: 'no action',
              },
            ],
            opaqueObjects: [],
          },
        ],
      },
    }

    expect(lower(dropPlan).actions.map((action) => action.sourceStepIndexes)).toEqual([
      [1],
      [0],
    ])
  })

  it('reports unsupported retained foreign-key drop cycles without a program', () => {
    const planned = plan()
    const parent = planned.identities.resolve({ relation: 'users' })
    const child = planned.identities.resolve({ relation: 'posts' })
    const foreignKey = (referencedRelation: typeof parent) => ({
      name: 'cycle_fkey',
      columns: ['id'],
      semanticCompleteness: 'supportedSimple' as const,
      isValid: true,
      referencedRelation,
      referencedColumns: ['id'],
      onDelete: 'no action' as const,
      onUpdate: 'no action' as const,
    })
    const cyclePlan: PlannedMigration = {
      ...planned,
      plan: {
        steps: [
          { kind: 'drop_table', target: { kind: 'relation', relation: parent } },
          { kind: 'drop_table', target: { kind: 'relation', relation: child } },
        ],
      },
      planningCatalog: {
        ...planned.planningCatalog,
        tables: [
          {
            identity: parent,
            columns: [],
            indexes: [],
            primaryKey: null,
            uniqueConstraints: [],
            foreignKeys: [foreignKey(child)],
            opaqueObjects: [],
          },
          {
            identity: child,
            columns: [],
            indexes: [],
            primaryKey: null,
            uniqueConstraints: [],
            foreignKeys: [foreignKey(parent)],
            opaqueObjects: [],
          },
        ],
      },
    }
    const result = postgresDialect.migration!.lower(cyclePlan, expectedProfile)

    expect(result.program).toBeUndefined()
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: 'unsupported_dependency_cycle',
        sourceStepIndexes: [0, 1],
      }),
    ])
  })

  it('declares SET NOT NULL as a semantic precondition', () => {
    const planned = plan()
    const relation = planned.identities.resolve({ relation: 'users' })
    const column = planned.identities.member('column', 'email')
    const setNotNull: PlannedMigration = {
      ...planned,
      plan: {
        steps: [
          {
            kind: 'set_not_null',
            target: { kind: 'column', relation, column },
          },
        ],
      },
    }

    expect(lower(setNotNull).preconditions).toEqual([
      {
        kind: 'column_has_no_nulls',
        relation,
        column: 'email',
        sourceStepIndexes: [0],
      },
    ])
  })

  it('rejects cross-database step and foreign-key reference targets', () => {
    const planned = plan()
    const users = planned.identities.resolve({ relation: 'users' })
    const posts = planned.identities.resolve({ relation: 'posts' })
    const inOtherDatabase = (identity: typeof users) => ({
      ...identity,
      namespace: identity.namespace.map((segment, index) =>
        index === 0
          ? {
              ...segment,
              identifier: { spelling: 'other', comparisonKey: 'other' },
            }
          : segment,
      ),
    })
    const crossDatabase: PlannedMigration = {
      ...planned,
      plan: {
        steps: [
          {
            kind: 'drop_table',
            target: { kind: 'relation', relation: inOtherDatabase(users) },
          },
          {
            kind: 'add_foreign_key',
            target: {
              kind: 'column',
              relation: posts,
              column: planned.identities.member('column', 'authorId'),
            },
            references: {
              relation: inOtherDatabase(users),
              column: planned.identities.member('column', 'id'),
            },
          },
        ],
      },
    }
    const result = postgresDialect.migration!.lower(crossDatabase, expectedProfile)

    expect(result.program).toBeUndefined()
    expect(
      result.issues
        ?.filter((issue) => issue.code === 'invalid_target')
        .map((issue) => issue.sourceStepIndexes),
    ).toEqual([[0], [1]])
    expect(result.issues?.map((issue) => issue.message).join('\n')).toMatch(
      /does not match executing database/i,
    )
  })

  it.each([
    ['missing segments', []],
    [
      'duplicate database roles',
      [
        {
          role: 'database' as const,
          identifier: { spelling: 'test', comparisonKey: 'test' },
        },
        {
          role: 'database' as const,
          identifier: { spelling: 'public', comparisonKey: 'public' },
        },
      ],
    ],
    [
      'wrong role order',
      [
        {
          role: 'schema' as const,
          identifier: { spelling: 'public', comparisonKey: 'public' },
        },
        {
          role: 'database' as const,
          identifier: { spelling: 'test', comparisonKey: 'test' },
        },
      ],
    ],
  ])('rejects PostgreSQL targets with %s', (_label, namespace) => {
    const planned = plan()
    const users = planned.identities.resolve({ relation: 'users' })
    const malformed: PlannedMigration = {
      ...planned,
      plan: {
        steps: [
          {
            kind: 'drop_table',
            target: {
              kind: 'relation',
              relation: { ...users, namespace },
            },
          },
        ],
      },
    }
    const result = postgresDialect.migration!.lower(malformed, expectedProfile)

    expect(result.program).toBeUndefined()
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid_target',
          sourceStepIndexes: [0],
        }),
      ]),
    )
  })
})
