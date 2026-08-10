import type { Connector, Statement } from 'db0'
import { pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MigrationError,
  column,
  createDatabase,
  defineTable,
  postgresDialect,
  reference,
} from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { POSTGRES_PHYSICAL_NAMING, generatedIndexName } from '@/migrations/physicalNaming'

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

function createMockStatement(rows: unknown[] = [], runError?: Error): Statement {
  const statement: Statement = {
    bind() {
      return statement
    },
    async all() {
      return rows
    },
    async run() {
      if (runError) throw runError
      return { success: true }
    },
    async get() {
      return rows[0]
    },
  }
  return statement
}

function createMockConnector(options?: {
  tables?: LiveTable[]
  pgClassOnlyReservations?: Array<{ schema: string; name: string }>
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

  const prepare = (sql: string) => {
    prepared.push(sql)
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

    if (['begin', 'commit', 'rollback'].includes(normalized)) {
      runSql.push(normalized)
      return createMockStatement()
    }

    if (/pg_advisory_unlock/.test(normalized)) {
      runSql.push(normalized)
      return createMockStatement([{ unlocked: true }])
    }

    if (/pg_advisory_lock/.test(normalized)) {
      runSql.push(normalized)
      return createMockStatement()
    }

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

    if (normalized.includes('-- catalog:column')) {
      return createMockStatement(
        liveTables.flatMap((table) =>
          table.columns.map((column, index) => ({
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
          })),
        ),
      )
    }

    if (normalized.includes('con.contype as constraint_type')) {
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
          ...(table.foreignKeys ?? []).map((constraint) => ({
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
          })),
        ]),
      )
    }

    if (normalized.includes('c.relname as object_name')) {
      return createMockStatement([
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
      ])
    }

    if (normalized.includes('from pg_index i')) {
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
  const nativeClient = createNativePostgresClient(prepare)
  const connector = {
    name: 'postgresql',
    dialect: 'postgresql' as const,
    prepared,
    runSql,
    liveTables,
    getInstance: () => nativeClient,
    exec: async () => ({}),
    prepare,
    dispose: async () => {},
  }
  return connector
}

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    email: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', schema: 'public' },
)

const AppUsers = defineTable(
  'users',
  { id: pipe(string(), column({ type: 'uuid' })) },
  { primaryKey: 'id', schema: 'app' },
)

const AppPosts = defineTable(
  'posts',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    authorId: reference(AppUsers, 'id', { onDelete: 'cascade' }),
  },
  { primaryKey: 'id', schema: 'app' },
)

const Memberships = defineTable(
  'memberships',
  {
    orgId: pipe(string(), column({ type: 'uuid' })),
    userId: pipe(string(), column({ type: 'uuid' })),
  },
  { primaryKey: ['orgId', 'userId'], schema: 'app' },
)

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

describe('postgresDialect.compile migration steps', () => {
  it('compiles constructive descriptive steps', () => {
    expect(
      postgresDialect.compile({
        kind: 'create_index',
        schema: 'public',
        table: 'users',
        name: 'users_email_idx',
        columns: ['email'],
        unique: false,
      }).sql,
    ).toContain('create index "users_email_idx"')

    expect(
      postgresDialect.compile({
        kind: 'add_column',
        schema: 'public',
        table: 'users',
        column: {
          name: 'nickname',
          dataType: 'text',
          notNull: true,
          unique: false,
          autoIncrement: false,
        },
      }).sql,
    ).toContain('alter table "public"."users" add column "nickname" text not null')

    expect(
      postgresDialect.compile({
        kind: 'add_unique_constraint',
        schema: 'public',
        table: 'users',
        column: 'email',
        name: 'users_email_key',
      }).sql,
    ).toContain(
      'alter table "public"."users" add constraint "users_email_key" unique ("email")',
    )

    const foreignKey = postgresDialect.compile({
      kind: 'add_foreign_key',
      schema: 'public',
      table: 'posts',
      column: 'authorId',
      references: {
        schema: 'public',
        table: 'users',
        column: 'id',
        onDelete: 'cascade',
        onUpdate: 'restrict',
      },
    }).sql
    expect(foreignKey).toContain('references "public"."users" ("id")')
    expect(foreignKey.toLowerCase()).toContain('on delete cascade on update restrict')
  })

  it('compiles destructive descriptive steps', () => {
    expect(
      postgresDialect.compile({
        kind: 'drop_column',
        schema: 'public',
        table: 'users',
        column: 'legacy',
      }).sql,
    ).toContain('alter table "public"."users" drop column "legacy"')
    expect(
      postgresDialect.compile({
        kind: 'drop_index',
        schema: 'public',
        table: 'users',
        index: 'users_legacy_idx',
      }).sql,
    ).toContain('drop index "public"."users_legacy_idx"')
    expect(
      postgresDialect.compile({
        kind: 'drop_table',
        schema: 'public',
        table: 'orphan',
      }).sql,
    ).toContain('drop table "public"."orphan"')
  })
})

describe('db.migrate() adapters and execution', () => {
  it('lowers the desired schema once per migration operation', async () => {
    const connector = createMockConnector()
    const lower = vi.spyOn(postgresDialect, 'lowerDesiredSchema')
    const db = createDatabase({ connector, schemas: [Users] })

    try {
      await db.migrate().dryRun()
      expect(lower).toHaveBeenCalledTimes(1)

      lower.mockClear()
      await db.migrate().execute()
      expect(lower).toHaveBeenCalledTimes(1)
    } finally {
      lower.mockRestore()
      await db.close()
    }
  })

  it('treats omitted and public schemas as the same resolved registry target', async () => {
    const BareItems = defineTable(
      'items',
      { id: pipe(string(), column({ type: 'uuid' })) },
      { primaryKey: 'id' },
    )
    const PublicItems = defineTable(
      'items',
      { id: pipe(string(), column({ type: 'uuid' })) },
      { primaryKey: 'id', schema: 'public' },
    )

    const db = createDatabase({
      connector: createMockConnector(),
      schemas: [BareItems, PublicItems],
    })

    await expect(db.migrate().dryRun()).rejects.toBeInstanceOf(MigrationError)
    await expect(db.migrate().dryRun()).rejects.toThrow(/duplicate registered table/i)
    await db.close()
  })

  it('resolves target-only table steps, compiles dependencies, and commits', async () => {
    const connector = createMockConnector()
    const db = createDatabase({
      connector,
      schemas: [AppPosts, Memberships, AppUsers],
    })

    await db.migrate().execute()

    expect(connector.runSql).toContain('begin')
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

  it('keeps dry-run free of locking, transactions, and DDL', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().dryRun()).resolves.toMatchObject({
      steps: [{ kind: 'create_table', target: relationTarget('public', 'users') }],
    })
    expect(connector.runSql).toEqual([])

    await db.close()
  })

  it('reuses planned generated index names during AST lowering', async () => {
    const IndexedEvents = defineTable(
      'indexed_events',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        createdAt: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', indexes: [{ columns: ['createdAt'] }] },
    )
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [IndexedEvents] })

    const plan = await db.migrate().dryRun()
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

  it('preflights generated names against pg_class reservations', async () => {
    const ReservedEvents = defineTable(
      'reserved_events',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        payload: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', indexes: [{ columns: ['payload'] }] },
    )
    const identities = createCanonicalRelationIdentityModule({
      adapter: 'postgresql',
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

    await expect(db.migrate().dryRun()).rejects.toThrow(/physical name collision/i)
    expect(connector.prepared.some((sql) => /c\.relname as object_name/i.test(sql))).toBe(
      true,
    )

    await db.close()
  })

  it('lowers additive unique-constraint steps with the planned naming profile', async () => {
    const UniqueUsers = defineTable(
      'users',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        email: pipe(string(), column({ type: 'text', unique: true })),
      },
      { primaryKey: 'id', schema: 'public' },
    )
    const connector = createMockConnector({ tables: [matchingUsers()] })
    const db = createDatabase({
      connector,
      schemas: [UniqueUsers],
      migrationOwnership: [
        { kind: 'relation', relation: UniqueUsers, shape: 'additive' },
      ],
    })

    await expect(db.migrate().dryRun()).resolves.toMatchObject({
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

  it('executes an explicit registration default through canonical handle lookup', async () => {
    const TenantItems = defineTable(
      'items',
      { id: pipe(string(), column({ type: 'uuid' })) },
      { primaryKey: 'id' },
    )
    const connector = createMockConnector()
    const db = createDatabase({
      connector,
      schemas: [TenantItems],
      defaultNamespace: [{ role: 'schema', spelling: 'tenant' }],
    })

    await expect(db.migrate().dryRun()).resolves.toEqual({
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

  it('executes dotted relation tuples through distinct canonical handle lookups', async () => {
    const DottedSchema = defineTable(
      'c',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        schemaMarker: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', schema: 'a.b' },
    )
    const DottedRelation = defineTable(
      'b.c',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        relationMarker: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', schema: 'a' },
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

  it('checks runtime data and rolls back before setting NOT NULL', async () => {
    const RequiredUsers = defineTable(
      'users',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        email: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', schema: 'public' },
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

    await expect(db.migrate().execute()).rejects.toBeInstanceOf(MigrationError)
    await expect(db.migrate().execute()).rejects.toThrow(/NULL values/i)
    expect(connector.runSql).toContain('begin')
    expect(connector.runSql).toContain('rollback')
    expect(connector.runSql).not.toContain('commit')
    expect(connector.runSql.some((sql) => /set not null/i.test(sql))).toBe(false)

    await db.close()
  })

  it('wraps executor errors, rolls back, and releases the lock', async () => {
    const connector = createMockConnector({ failRun: /^create table/ })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().execute()).rejects.toBeInstanceOf(MigrationError)
    await expect(db.migrate().execute()).rejects.toThrow(/executor rejected/i)
    expect(connector.runSql).toContain('begin')
    expect(connector.runSql).toContain('rollback')
    expect(connector.runSql).not.toContain('commit')
    expect(connector.runSql.some((sql) => /pg_advisory_unlock/i.test(sql))).toBe(true)

    await db.close()
  })
})

describe('db.migrate() policy and coordination', () => {
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

  it('keeps allow permissions out of planning', async () => {
    const connector = createMockConnector({ tables: destructiveCatalog() })
    const db = createDatabase({ connector, schemas: [Users] })

    const plan = await db.migrate().dryRun()
    const allowed = await db
      .migrate()
      .allow('dropColumn', 'dropIndex', 'dropTable')
      .dryRun()

    expect(allowed).toEqual(plan)
    expect(plan.steps.map((step) => step.kind)).toEqual(['drop_index', 'drop_column'])

    await db.close()
  })

  it('rejects missing destructive permission before transaction or DDL', async () => {
    const connector = createMockConnector({ tables: destructiveCatalog() })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().execute()).rejects.toThrow(/allow\('dropIndex'\)/i)
    expect(connector.runSql).not.toContain('begin')
    expect(connector.runSql.some((sql) => /^(?:alter|drop)\s/i.test(sql))).toBe(false)

    await db.close()
  })

  it('executes the complete plan with all required permissions', async () => {
    const AuditEvents = defineTable(
      'audit_events',
      { id: pipe(string(), column({ type: 'uuid' })) },
      { primaryKey: 'id', schema: 'public' },
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

  it('locks before fresh introspection and always unlocks', async () => {
    const connector = createMockConnector({ tables: [matchingUsers()] })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().dryRun()).resolves.toEqual({ steps: [] })
    connector.prepared.length = 0
    connector.runSql.length = 0
    connector.liveTables[0]!.columns.push({
      name: 'legacy',
      dataType: 'text',
      isNullable: true,
    })

    await expect(db.migrate().execute()).rejects.toThrow(/allow\('dropColumn'\)/i)

    const lock = connector.prepared.findIndex((sql) => /pg_advisory_lock\(/i.test(sql))
    const introspection = connector.prepared.findIndex((sql) =>
      /c\.relkind as relation_kind/i.test(sql),
    )
    const unlock = connector.prepared.findIndex((sql) =>
      /pg_advisory_unlock\(/i.test(sql),
    )
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(introspection).toBeGreaterThan(lock)
    expect(unlock).toBeGreaterThan(introspection)
    expect(connector.runSql).not.toContain('begin')

    await db.close()
  })
})
