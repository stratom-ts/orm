import type { Connector, Statement } from 'db0'
import {
  exactOptional,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  optional,
  pipe,
  string,
  undefinedable,
} from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { POSTGRES_POLICY } from '@/dialects/postgres/identity'
import { POSTGRES_PHYSICAL_NAMING } from '@/dialects/postgres/naming'
import {
  MigrationError,
  column,
  createDatabase,
  defineTable,
  postgresDialect,
  reference,
} from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { generatedIndexName } from '@/migrations/physicalNaming'

import { createNativePostgresClient } from './helpers/nativePostgresClient'
import { columnTarget, namespaceTarget, relationTarget } from './helpers/planTargets'

afterEach(() => {
  vi.restoreAllMocks()
})

type LiveColumn = {
  name: string
  dataType: string
  isNullable: boolean
  defaultExpression?: string | null
  identityGeneration?: 'always' | 'byDefault' | null
}

type LiveIndex = {
  name: string
  columns: string[]
  unique: boolean
}

type LiveTable = {
  schema: string
  name: string
  columns: LiveColumn[]
  indexes?: LiveIndex[]
  primaryKey?: string[]
  uniqueConstraints?: { name: string; columns: string[] }[]
  foreignKeys?: {
    name: string
    columns: string[]
    referencedSchema?: string
    referencedTable: string
    referencedColumns: string[]
    onDelete?: string
    onUpdate?: string
  }[]
}

/**
 * Creates a reusable db0 statement fixture with deterministic rows and optional execution
 * failure.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param runError - Expected operation rejection retained during cleanup checks.
 *
 * @returns A reusable db0 statement fixture with deterministic rows and optional
 *   execution failure.
 */
function createMockStatement(rows: unknown[] = [], runError?: Error): Statement {
  const statement: Statement = {
    /** Binds fixture parameter values and returns the statement for execution. */
    bind() {
      return statement
    },
    /** Returns the fixture statement rows or its configured rejection. */
    async all() {
      return rows
    },
    /** Runs a fixture statement with configured outcomes. */
    async run() {
      if (runError) throw runError

      return { success: true }
    },
    /** Returns the first fixture row, or undefined when no rows exist. */
    async get() {
      return rows[0]
    },
  }
  return statement
}

/**
 * Supplies native namespace, relation, or column rows for migration introspection
 * queries.
 *
 * @param normalized - Portable catalog view used for normalized-evidence assertions.
 * @param liveTables - Observed table definitions supplied to reconciliation.
 *
 * @returns Native namespace, relation, or column rows for migration introspection
 *   queries.
 */
function relationCatalogStatement(
  normalized: string,
  liveTables: LiveTable[],
): Statement | undefined {
  if (normalized.includes('current_database()')) {
    return createMockStatement([
      { database: 'test', schema: 'public', version: '160000' },
    ])
  }

  if (normalized.includes('-- catalog:namespace')) {
    const schemas = ['public', ...liveTables.map((table) => table.schema)].filter(
      (schema, index, values) => values.indexOf(schema) === index,
    )
    return createMockStatement(schemas.map((schema) => ({ schema, owner: 'app' })))
  }

  const inventory = relationInventoryStatement(normalized, liveTables)

  if (inventory) return inventory

  if (normalized.includes('-- catalog:column')) {
    return createMockStatement(
      liveTables.flatMap((table) =>
        table.columns.map((column, index) => liveColumnCatalogRow(table, column, index)),
      ),
    )
  }

  return undefined
}

/**
 * Projects fixture indexes into PostgreSQL native index query rows.
 *
 * @param liveTables - Observed table definitions supplied to reconciliation.
 *
 * @returns Fixture indexes into PostgreSQL native index query rows.
 */
function indexCatalogStatement(liveTables: LiveTable[]): Statement {
  return createMockStatement(
    liveTables.flatMap((table) =>
      (table.indexes ?? []).map((index) => ({
        schema: table.schema,
        table_name: table.name,
        index_name: index.name,
        is_unique: index.unique,
        columns: index.columns,
        has_supported_semantics: true,
        is_valid: true,
        nulls_not_distinct: false,
        native_definition: `create index ${index.name} on ${table.name} (${index.columns.join(', ')})`,
      })),
    ),
  )
}

/**
 * Creates a connector fixture that records prepared statements and supplies controlled
 * native behavior.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A connector fixture that records prepared statements and supplies controlled
 *   native behavior.
 */
function createMockConnector(options?: {
  tables?: LiveTable[]
  pgClassOnlyReservations?: { schema: string; name: string }[]
  nullCount?: number
  failRun?: RegExp
}): Connector & {
  prepared: string[]
  runSql: string[]
  liveTables: LiveTable[]
} {
  const prepared: string[] = []
  const runSql: string[] = []
  const liveTables = structuredClone(options?.tables ?? [])

  /** Prepares the fixture statement for the supplied SQL. */
  const prepare = (sql: string) =>
    prepareMockQuery(sql, prepared, runSql, liveTables, options)

  const nativeClient = createNativePostgresClient(prepare)
  const connector = {
    name: 'postgresql',
    dialect: 'postgresql' as const,
    prepared,
    runSql,
    liveTables,
    /** Returns the native client owned by the fixture connector. */
    getInstance: () => nativeClient,
    /** Executes connector SQL for the fixture scenario. */
    exec: async () => ({}),
    prepare,
    /** Records disposal and closes owned fixture resources. */
    dispose: async () => {},
  }
  return connector
}

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

const WrapperMigration = defineTable(
  'wrapper_migration',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    exact: exactOptional(
      pipe(
        string(),
        column({
          physicalType: { postgresql: 'varchar(20)' },
          databaseDefault: { kind: 'literal', value: 'default' },
        }),
      ),
    ),
    undefinedValue: undefinedable(
      pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    ),
    nullableValue: nullable(
      pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    ),
    nullishValue: nullish(
      pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    ),
    nonOptionalValue: nonOptional(
      optional(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    ),
    nonNullableValue: nonNullable(
      optional(
        nullable(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
      ),
    ),
    nonNullishValue: nonNullish(
      nullish(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    ),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

const AppUsers = defineTable(
  'users',
  { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'app' }] },
)

const AppPosts = defineTable(
  'posts',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    authorId: reference(AppUsers, 'id', { onDelete: 'cascade' }),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'app' }] },
)

const Memberships = defineTable(
  'memberships',
  {
    orgId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    userId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
  },
  {
    primaryKey: ['orgId', 'userId'],
    namespace: [{ role: 'schema', spelling: 'app' }],
  },
)

/** Builds observed users-table facts matching the desired schema, with optional overrides. */
function matchingUsers(extra?: Partial<LiveTable>): LiveTable {
  return {
    schema: 'public',
    name: 'users',
    columns: [
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ],
    primaryKey: ['id'],
    uniqueConstraints: [],
    foreignKeys: [],
    indexes: [],
    ...extra,
  }
}

/** Builds destructive catalog evidence for schema reconciliation checks. */
const destructiveCatalog = (): LiveTable[] => [
  matchingUsers({
    columns: [
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
      { name: 'legacy', dataType: 'text', isNullable: true },
    ],
    indexes: [{ name: 'users_legacy_idx', columns: ['legacy'], unique: false }],
  }),
  {
    schema: 'public',
    name: 'orphan',
    columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
  },
]

describe('db.migrate() adapters and execution', () => {
  it('returns a stable PostgreSQL SQL preview without running DDL', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const preview = await db.migrate().dryRun()

    expect(preview).toMatchObject({
      atomicity: 'plan-atomic',
      actions: [
        {
          sourceStepIndexes: [0],
          transaction: 'required',
          statements: [
            {
              sql: 'create table "public"."users" ("id" uuid not null, "email" text not null, constraint "users_id__c2b82cf39bf9f504_pkey" primary key ("id"))',
              params: [],
            },
          ],
        },
      ],
    })

    expect(connector.runSql).toEqual([])

    expect(connector.prepared.some((sql) => /^(?:create|alter|drop)\s/i.test(sql))).toBe(
      false,
    )

    await db.close()
  })
})

describe('db.migrate() adapters and execution: lowers wrapper nullability and inferred types consistently in plan and execute', () => {
  it('lowers wrapper nullability and inferred types consistently in plan and execute', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [WrapperMigration] })

    const plan = await db.migrate().plan()
    expect(plan.steps.some((step) => step.kind === 'create_table')).toBe(true)
    expect(connector.runSql).toEqual([])

    await db.migrate().execute()
    const createSql = connector.runSql.find((sql) =>
      /create table .*wrapper_migration/i.test(sql),
    )
    expect(createSql).toBeDefined()
    expect(createSql).toContain('"exact" varchar(20) not null default')
    expect(createSql).toContain('"undefinedValue" text not null')
    expect(createSql).toContain('"nullableValue" text')
    expect(createSql).not.toMatch(/"nullableValue" text not null/i)
    expect(createSql).toContain('"nullishValue" text')
    expect(createSql).not.toMatch(/"nullishValue" text not null/i)
    expect(createSql).toContain('"nonNullableValue" text not null')
    expect(createSql).toContain('"nonOptionalValue" text not null')
    expect(createSql).toContain('"nonNullishValue" text not null')

    await db.close()
  })
})

describe('db.migrate() adapters and execution: lowers the desired schema once per migration operation', () => {
  it('lowers the desired schema once per migration operation', async () => {
    const connector = createMockConnector()
    const lower = vi.spyOn(postgresDialect.schema, 'lowerDesiredSchema')
    const db = createDatabase({ connector, schemas: [Users] })

    try {
      await db.migrate().plan()
      expect(lower).toHaveBeenCalledTimes(1)

      lower.mockClear()
      await db.migrate().execute()
      expect(lower).toHaveBeenCalledTimes(1)
    } finally {
      lower.mockRestore()
      await db.close()
    }
  })
})

describe('db.migrate() adapters and execution: treats omitted and public schemas as the same resolved registry target', () => {
  it('treats omitted and public schemas as the same resolved registry target', async () => {
    const BareItems = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const PublicItems = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )

    const db = createDatabase({
      connector: createMockConnector(),
      schemas: [BareItems, PublicItems],
    })

    const error = await db
      .migrate()
      .plan()
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MigrationError)

    expect(error).toMatchObject({
      stage: 'planning',
      outcome: 'unchanged',
      retryable: false,
    })

    expect((error as Error).message).toMatch(/duplicate registered table/i)
    await db.close()
  })
})

describe('db.migrate() adapters and execution: treats omitted and public schemas as the same resolved registry target: resolves target-only table steps, compiles dependencies, and commits', () => {
  it('resolves target-only table steps, compiles dependencies, and commits', async () => {
    const connector = createMockConnector()
    const db = createDatabase({
      connector,
      schemas: [AppPosts, Memberships, AppUsers],
    })

    await db.migrate().execute()

    expect(connector.runSql).toContain('begin isolation level repeatable read')
    expect(connector.runSql).toContain('commit')
    expect(connector.runSql).not.toContain('rollback')

    expect(
      connector.runSql.some((sql) => /create schema if not exists "app"/i.test(sql)),
    ).toBe(true)

    expect(
      connector.runSql.find((sql) => /create table "app"\."memberships"/i.test(sql)),
    ).toContain('primary key ("orgId", "userId")')

    expect(
      connector.runSql.find((sql) => /foreign key \("authorId"\)/i.test(sql)),
    ).toContain('references "app"."users" ("id")')

    expect(
      connector.runSql.some((sql) =>
        /constraint ".*__[0-9a-f]{16}_pkey" primary key/i.test(sql),
      ),
    ).toBe(true)

    expect(
      connector.runSql.some((sql) =>
        /add constraint ".*__[0-9a-f]{16}_fkey" foreign key/i.test(sql),
      ),
    ).toBe(true)

    await db.close()
  })
})

describe('db.migrate() adapters and execution: keeps planning free of locking, transactions, and DDL', () => {
  it('keeps planning free of locking, transactions, and DDL', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().plan()).resolves.toMatchObject({
      steps: [{ kind: 'create_table', target: relationTarget('public', 'users') }],
    })

    expect(connector.runSql).toEqual([])

    await db.close()
  })
})

describe('db.migrate() lowering and rollback', () => {
  it('reuses planned generated index names during AST lowering', async () => {
    const IndexedEvents = defineTable(
      'indexed_events',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        createdAt: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id', indexes: [{ columns: ['createdAt'] }] },
    )
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [IndexedEvents] })

    const plan = await db.migrate().plan()
    const index = plan.steps.find((step) => step.kind === 'create_index')
    expect(index?.kind).toBe('create_index')

    if (index?.kind !== 'create_index') throw new Error('Expected generated index step')

    await db.migrate().execute()

    expect(
      connector.runSql.some((sql) =>
        sql.includes(
          `create index "${index.target.index.spelling}" on "public"."indexed_events"`,
        ),
      ),
    ).toBe(true)

    await db.close()
  })
})

describe('db.migrate() lowering and rollback: preflights generated names against pg_class reservations', () => {
  it('preflights generated names against pg_class reservations', async () => {
    const ReservedEvents = defineTable(
      'reserved_events',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        payload: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id', indexes: [{ columns: ['payload'] }] },
    )
    const identities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_POLICY,
      context: {
        writableDefault: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'public' },
        ],
      },
    })
    const reservedName = generatedIndexName(
      identities.resolve({ relation: 'reserved_events' }),
      ['payload'],
      false,
      POSTGRES_PHYSICAL_NAMING,
    )
    const connector = createMockConnector({
      pgClassOnlyReservations: [{ schema: 'public', name: reservedName }],
    })
    const db = createDatabase({ connector, schemas: [ReservedEvents] })

    await expect(db.migrate().plan()).rejects.toThrow(/physical name collision/i)

    expect(connector.prepared.some((sql) => /c\.relname as object_name/i.test(sql))).toBe(
      true,
    )

    await db.close()
  })
})

describe('db.migrate() lowering and rollback: lowers additive unique-constraint steps with the planned naming profile', () => {
  it('lowers additive unique-constraint steps with the planned naming profile', async () => {
    const UniqueUsers = defineTable(
      'users',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        email: pipe(
          string(),
          column({ physicalType: { postgresql: 'text' }, unique: true }),
        ),
      },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const connector = createMockConnector({ tables: [matchingUsers()] })
    const db = createDatabase({
      connector,
      schemas: [UniqueUsers],
      migrationOwnership: [
        { kind: 'relation', relation: UniqueUsers, shape: 'additive' },
      ],
    })

    await expect(db.migrate().plan()).resolves.toMatchObject({
      steps: [
        {
          kind: 'add_unique_constraint',
          target: columnTarget('public', 'users', 'email'),
        },
      ],
    })

    await db.migrate().execute()

    expect(
      connector.runSql.some((sql) =>
        /add constraint ".*__[0-9a-f]{16}_key" unique \("email"\)/i.test(sql),
      ),
    ).toBe(true)

    await db.close()
  })
})

describe('db.migrate() lowering and rollback: lowers additive unique-constraint steps with the planned naming profile: executes an explicit registration default through canonical handle lookup', () => {
  it('executes an explicit registration default through canonical handle lookup', async () => {
    const TenantItems = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const connector = createMockConnector()
    const db = createDatabase({
      connector,
      schemas: [TenantItems],
      defaultNamespace: [{ role: 'schema', spelling: 'tenant' }],
    })

    await expect(db.migrate().plan()).resolves.toEqual({
      steps: [
        { kind: 'ensure_namespace', target: namespaceTarget('tenant') },
        { kind: 'create_table', target: relationTarget('tenant', 'items') },
      ],
    })

    await expect(db.migrate().execute()).resolves.toBeUndefined()

    expect(
      connector.runSql.some((sql) => /create schema if not exists "tenant"/i.test(sql)),
    ).toBe(true)

    expect(
      connector.runSql.some((sql) => /create table "tenant"\."items"/i.test(sql)),
    ).toBe(true)

    expect(connector.runSql).toContain('commit')

    await db.close()
  })
})

describe('db.migrate() lowering and rollback: executes dotted relation tuples through distinct canonical handle lookups', () => {
  it('executes dotted relation tuples through distinct canonical handle lookups', async () => {
    const DottedSchema = defineTable(
      'c',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        schemaMarker: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a.b' }] },
    )
    const DottedRelation = defineTable(
      'b.c',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        relationMarker: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a' }] },
    )
    const connector = createMockConnector()
    const db = createDatabase({
      connector,
      schemas: [DottedSchema, DottedRelation],
    })

    await db.migrate().execute()

    const dottedSchemaSql = connector.runSql.find((sql) =>
      /create table "a\.b"\."c"/i.test(sql),
    )
    const dottedRelationSql = connector.runSql.find((sql) =>
      /create table "a"\."b\.c"/i.test(sql),
    )
    expect(dottedSchemaSql).toBeDefined()
    expect(dottedRelationSql).toBeDefined()
    expect(dottedSchemaSql).toContain('"schemaMarker" text')
    expect(dottedSchemaSql).not.toContain('"relationMarker"')
    expect(dottedRelationSql).toContain('"relationMarker" text')
    expect(dottedRelationSql).not.toContain('"schemaMarker"')

    await db.close()
  })
})

describe('db.migrate() runtime rollback', () => {
  it('checks runtime data and rolls back before setting NOT NULL', async () => {
    const RequiredUsers = defineTable(
      'users',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const connector = createMockConnector({
      tables: [
        matchingUsers({
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: true },
          ],
        }),
      ],
      nullCount: 3,
    })
    const db = createDatabase({ connector, schemas: [RequiredUsers] })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MigrationError)

    expect(error).toMatchObject({
      stage: 'precondition',
      outcome: 'unchanged',
      retryable: false,
    })

    expect((error as Error).message).toMatch(/NULL values/i)
    expect(connector.runSql).toContain('begin isolation level repeatable read')
    expect(connector.runSql).toContain('rollback')
    expect(connector.runSql).not.toContain('commit')
    expect(connector.runSql.some((sql) => /set not null/i.test(sql))).toBe(false)

    await db.close()
  })
})

describe('db.migrate() runtime rollback: wraps executor errors, rolls back, and releases the lock', () => {
  it('wraps executor errors, rolls back, and releases the lock', async () => {
    const connector = createMockConnector({ failRun: /^create table/ })
    const db = createDatabase({ connector, schemas: [Users] })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toBeInstanceOf(MigrationError)

    expect(error).toMatchObject({
      stage: 'ddl',
      outcome: 'rolledBack',
      retryable: false,
    })

    expect((error as Error).message).toMatch(/executor rejected/i)
    expect(connector.runSql).toContain('begin isolation level repeatable read')
    expect(connector.runSql).toContain('rollback')
    expect(connector.runSql).not.toContain('commit')
    expect(connector.runSql.some((sql) => /pg_advisory_unlock/i.test(sql))).toBe(true)

    await db.close()
  })
})

describe('db.migrate() policy and coordination', () => {
  it.each([-1, Number.POSITIVE_INFINITY, Number.NaN])(
    'rejects invalid lock timeout %s before opening an operation',
    async (lockTimeoutMs) => {
      const connector = createMockConnector()
      const db = createDatabase({ connector, schemas: [] })

      const error = await db
        .migrate()
        .execute({ lockTimeoutMs })
        .catch((cause: unknown) => cause)
      expect(error).toMatchObject({
        stage: 'lock',
        outcome: 'unchanged',
        retryable: false,
      })

      expect(connector.prepared).toEqual([])
      await db.close()
    },
  )
})

describe('db.migrate() policy and coordination: classifies authoritative catalog observation failures as introspection', () => {
  it('classifies authoritative catalog observation failures as introspection', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [] })

    vi.spyOn(postgresDialect.catalog, 'introspectCatalog').mockRejectedValueOnce(
      new Error('catalog observation failed'),
    )

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: false,
    })

    expect(connector.runSql).toContain('rollback')

    expect(connector.runSql.some((sql) => /^(?:create|alter|drop)\s/i.test(sql))).toBe(
      false,
    )

    await db.close()
  })
})

describe('db.migrate() policy and coordination: executes no DDL when whole-plan lowering reports a capability issue', () => {
  it('executes no DDL when whole-plan lowering reports a capability issue', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })
    const capabilityIssues = [
      {
        code: 'compile_failure' as const,
        message: 'deterministic capability failure',
        sourceStepIndexes: [2, 0],
      },
      {
        code: 'invalid_target' as const,
        message: 'second deterministic capability failure',
        sourceStepIndexes: [2],
      },
    ]
    vi.spyOn(postgresDialect.migration!, 'lower').mockReturnValueOnce({
      issues: capabilityIssues,
    })

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes: [0, 2],
    })

    expect((error as { capabilityIssues?: unknown }).capabilityIssues).toEqual(
      capabilityIssues,
    )

    expect(connector.runSql).toContain('rollback')

    expect(
      connector.runSql.filter((sql) => /^(?:create|alter|drop)\s/i.test(sql)),
    ).toHaveLength(0)

    await db.close()
  })
})

describe('db.migrate() permissions and coordination', () => {
  it('keeps allow permissions out of planning', async () => {
    const connector = createMockConnector({ tables: destructiveCatalog() })
    const db = createDatabase({ connector, schemas: [Users] })

    const plan = await db.migrate().plan()
    const allowed = await db
      .migrate()
      .allow('dropColumn', 'dropIndex', 'dropTable')
      .plan()

    expect(allowed).toEqual(plan)
    expect(plan.steps.map((step) => step.kind)).toEqual(['drop_index', 'drop_column'])

    await db.close()
  })

  it('rejects missing destructive permission in the authoritative transaction before DDL', async () => {
    const connector = createMockConnector({ tables: destructiveCatalog() })
    const db = createDatabase({ connector, schemas: [Users] })
    const lower = vi.spyOn(postgresDialect.migration!, 'lower')

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      stage: 'permission',
      outcome: 'unchanged',
      retryable: false,
    })

    expect((error as Error).message).toMatch(/allow\('dropIndex'\)/i)
    expect(connector.runSql).toContain('begin isolation level repeatable read')
    expect(connector.runSql).toContain('rollback')
    expect(lower).not.toHaveBeenCalled()
    expect(connector.runSql.some((sql) => /^(?:alter|drop)\s/i.test(sql))).toBe(false)

    await db.close()
  })
})

describe('db.migrate() permissions and coordination: normalizes a plain nonconforming adapter failure as unknown and discards', () => {
  it('normalizes a plain nonconforming adapter failure as unknown and discards', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [] })

    vi.spyOn(postgresDialect.migration!, 'execute').mockRejectedValueOnce(
      new Error('plain adapter failure'),
    )

    const error = await db
      .migrate()
      .execute()
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({
      _tag: 'MigrationError',
      stage: 'ddl',
      outcome: 'unknown',
      retryable: false,
    })

    expect((error as Error).message).toMatch(/plain adapter failure/i)
    await db.close()
  })
})

describe('db.migrate() permissions and coordination: executes the complete plan with all required permissions', () => {
  it('executes the complete plan with all required permissions', async () => {
    const AuditEvents = defineTable(
      'audit_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const connector = createMockConnector({ tables: destructiveCatalog() })
    const db = createDatabase({
      connector,
      schemas: [Users, AuditEvents],
      migrationOwnership: [
        {
          kind: 'absentRelation',
          relation: {
            namespace: [{ role: 'schema', spelling: 'public' }],
            relation: 'orphan',
          },
        },
      ],
    })

    await db.migrate().allow('dropColumn', 'dropIndex', 'dropTable').execute()

    expect(
      connector.runSql.some((sql) => /create table .*"audit_events"/i.test(sql)),
    ).toBe(true)

    expect(
      connector.runSql.some((sql) => /drop index .*"users_legacy_idx"/i.test(sql)),
    ).toBe(true)

    expect(connector.runSql.some((sql) => /drop column "legacy"/i.test(sql))).toBe(true)
    expect(connector.runSql.some((sql) => /drop table .*"orphan"/i.test(sql))).toBe(true)

    await db.close()
  })
})

describe('db.migrate() permissions and coordination: executes the complete plan with all required permissions: locks before fresh introspection and always unlocks', () => {
  it('locks before fresh introspection and always unlocks', async () => {
    const connector = createMockConnector({ tables: [matchingUsers()] })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
    connector.prepared.length = 0
    connector.runSql.length = 0

    connector.liveTables[0]!.columns.push({
      name: 'legacy',
      dataType: 'text',
      isNullable: true,
    })

    await expect(db.migrate().execute()).rejects.toThrow(/allow\('dropColumn'\)/i)

    const lock = connector.prepared.findIndex((sql) =>
      /pg_try_advisory_lock\(/i.test(sql),
    )
    const introspection = connector.prepared.findIndex((sql) =>
      /c\.relkind as relation_kind/i.test(sql),
    )
    const transaction = connector.prepared.findIndex((sql) =>
      /^begin isolation level repeatable read$/i.test(sql),
    )
    const unlock = connector.prepared.findIndex((sql) =>
      /pg_advisory_unlock\(/i.test(sql),
    )
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(transaction).toBeGreaterThan(lock)
    expect(introspection).toBeGreaterThan(transaction)
    expect(unlock).toBeGreaterThan(introspection)
    expect(connector.runSql).toContain('begin isolation level repeatable read')

    await db.close()
  })
})

/**
 * Projects fixture primary, unique, and foreign keys into native constraint rows.
 *
 * @param liveTables - Observed table definitions supplied to reconciliation.
 *
 * @returns Fixture primary, unique, and foreign keys into native constraint rows.
 */
function constraintCatalogStatement(liveTables: LiveTable[]) {
  return createMockStatement(
    liveTables.flatMap((table) => [
      ...(table.primaryKey
        ? [
            {
              schema: table.schema,
              table_name: table.name,
              constraint_name: `${table.name}_pkey`,
              constraint_type: 'p',
              columns: table.primaryKey,
              is_valid: true,
              is_deferrable: false,
              initially_deferred: false,
              backing_index_is_valid: true,
              has_supported_backing_index_semantics: true,
              backing_index_nulls_not_distinct: false,
              native_definition: `primary key (${table.primaryKey.join(', ')})`,
            },
          ]
        : []),
      ...(table.uniqueConstraints ?? []).map((constraint) => ({
        schema: table.schema,
        table_name: table.name,
        constraint_name: constraint.name,
        constraint_type: 'u',
        columns: constraint.columns,
        is_valid: true,
        is_deferrable: false,
        initially_deferred: false,
        backing_index_is_valid: true,
        has_supported_backing_index_semantics: true,
        backing_index_nulls_not_distinct: false,
        native_definition: `unique (${constraint.columns.join(', ')})`,
      })),
      ...foreignKeyCatalogRows(table),
    ]),
  )
}

/**
 * Records prepared SQL and dispatches lifecycle, catalog, or DDL fixture behavior.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 * @param prepared - SQL strings recorded in preparation order.
 * @param runSql - SQL strings recorded in statement-execution order.
 * @param liveTables - Observed table definitions supplied to reconciliation.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns The statement supplying the configured lifecycle, catalog, or DDL outcome.
 */
function prepareMockQuery(
  sql: string,
  prepared: string[],
  runSql: string[],
  liveTables: LiveTable[],
  options: Parameters<typeof createMockConnector>[0],
) {
  prepared.push(sql)
  const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

  const control = prepareSessionControlQuery(normalized, runSql)

  if (control) return control

  const relationCatalog = relationCatalogStatement(normalized, liveTables)

  if (relationCatalog) return relationCatalog

  if (normalized.includes('con.contype as constraint_type'))
    return constraintCatalogStatement(liveTables)

  if (normalized.includes('c.relname as object_name')) {
    return createMockStatement(catalogReservationRows(liveTables, options))
  }

  if (normalized.includes('from pg_index i')) return indexCatalogStatement(liveTables)

  if (normalized.includes('count(*)') && normalized.includes(' is null')) {
    return createMockStatement([{ count: options?.nullCount ?? 0 }])
  }

  if (/^(?:create|alter|drop)\s/.test(normalized)) {
    runSql.push(sql)
    const error = options?.failRun?.test(normalized)
      ? new Error(`executor rejected: ${normalized}`)
      : undefined
    return createMockStatement([], error)
  }

  return createMockStatement()
}

/**
 * Projects fixture tables into native relation inventory observations.
 *
 * @param normalized - Portable catalog view used for normalized-evidence assertions.
 * @param liveTables - Observed table definitions supplied to reconciliation.
 *
 * @returns Fixture tables into native relation inventory observations.
 */
function relationInventoryStatement(
  normalized: string,
  liveTables: LiveTable[],
): Statement | undefined {
  if (normalized.includes('as relation_kind')) {
    return createMockStatement(
      liveTables.map((table) => ({
        object_id: `${table.schema}.${table.name}`,
        schema: table.schema,
        name: table.name,
        relation_kind: 'r',
        persistence: 'p',
        owner: 'app',
        can_inspect: true,
        native_definition: null,
        options: [],
        partition_key: null,
        row_level_security: false,
        force_row_level_security: false,
        replica_identity: 'd',
        access_method: 'heap',
        tablespace: null,
        is_partition: false,
        partition_bound: null,
      })),
    )
  }

  return undefined
}

/**
 * Supplies deterministic transaction and advisory-lock results while recording lifecycle
 * SQL.
 *
 * @param normalized - Portable catalog view used for normalized-evidence assertions.
 * @param runSql - SQL strings recorded in statement-execution order.
 *
 * @returns Deterministic transaction and advisory-lock results while recording lifecycle
 *   SQL.
 */
function prepareSessionControlQuery(
  normalized: string,
  runSql: string[],
): Statement | undefined {
  if (/^begin\b/.test(normalized) || ['commit', 'rollback'].includes(normalized)) {
    runSql.push(normalized)
    return createMockStatement()
  }

  if (normalized.includes('pg_advisory_unlock')) {
    runSql.push(normalized)
    return createMockStatement([{ unlocked: true }])
  }

  if (normalized.includes('pg_try_advisory_lock')) {
    runSql.push(normalized)
    return createMockStatement([{ locked: true }])
  }

  if (normalized.includes('pg_advisory_lock')) {
    runSql.push(normalized)
    return createMockStatement()
  }

  return undefined
}

/**
 * Projects fixture foreign keys into ordered native constraint rows.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 *
 * @returns Fixture foreign keys into ordered native constraint rows.
 */
function foreignKeyCatalogRows(table: LiveTable) {
  return (table.foreignKeys ?? []).map((constraint) => ({
    schema: table.schema,
    table_name: table.name,
    constraint_name: constraint.name,
    constraint_type: 'f',
    columns: constraint.columns,
    referenced_schema: constraint.referencedSchema ?? 'public',
    referenced_table: constraint.referencedTable,
    referenced_columns: constraint.referencedColumns,
    on_delete: constraint.onDelete ?? 'no action',
    on_update: constraint.onUpdate ?? 'no action',
    is_valid: true,
    is_deferrable: false,
    initially_deferred: false,
    match_type: 's',
    has_column_specific_delete_action: false,
    native_definition: `foreign key (${constraint.columns.join(', ')}) references ${constraint.referencedTable}`,
  }))
}

/** Projects one fixture column into native type, default, and generation evidence. */
function liveColumnCatalogRow(
  table: LiveTable,
  column: LiveTable['columns'][number],
  index: number,
) {
  return {
    schema: table.schema,
    table_name: table.name,
    column_name: column.name,
    ordinal_position: index + 1,
    data_type: column.dataType,
    udt_name: column.dataType,
    is_user_defined: false,
    character_maximum_length: null,
    numeric_precision: null,
    numeric_scale: null,
    is_nullable: column.isNullable ? 'YES' : 'NO',
    column_default: column.defaultExpression ?? null,
    is_identity: column.identityGeneration ? 'YES' : 'NO',
    identity_generation:
      column.identityGeneration === 'always'
        ? 'ALWAYS'
        : column.identityGeneration === 'byDefault'
          ? 'BY DEFAULT'
          : null,
    is_generated: 'NEVER',
    generation_expression: null,
  }
}

/**
 * Builds relation and index name reservations, including objects outside the desired
 * schema.
 *
 * @param liveTables - Observed table definitions supplied to reconciliation.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Relation and index name reservations, including objects outside the desired
 *   schema.
 */
function catalogReservationRows(
  liveTables: LiveTable[],
  options: Parameters<typeof createMockConnector>[0],
) {
  return [
    ...liveTables.flatMap((table) => [
      { schema: table.schema, object_name: table.name },
      ...(table.indexes ?? []).map((index) => ({
        schema: table.schema,
        object_name: index.name,
      })),
    ]),
    ...(options?.pgClassOnlyReservations ?? []).map((reservation) => ({
      schema: reservation.schema,
      object_name: reservation.name,
    })),
  ]
}
