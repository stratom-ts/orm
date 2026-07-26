import type { Connector, Statement } from 'db0'
import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  MigrationError,
  column,
  createDatabase,
  defineTable,
  postgresDialect,
  reference,
} from '@/index'

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

  const connector = {
    name: 'mock',
    dialect: 'postgresql' as const,
    prepared,
    runSql,
    liveTables,
    getInstance: () => ({}),
    exec: async () => ({}),
    prepare: (sql: string) => {
      prepared.push(sql)
      const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()

      if (['begin', 'commit', 'rollback'].includes(normalized)) {
        runSql.push(normalized)
        return createMockStatement()
      }

      if (/pg_advisory_(?:un)?lock/.test(normalized)) {
        runSql.push(normalized)
        return createMockStatement()
      }

      if (normalized.includes('current_database()')) {
        return createMockStatement([{ database: 'test', schema: 'public' }])
      }

      if (
        normalized.includes('information_schema.tables') &&
        !normalized.includes('information_schema.columns')
      ) {
        return createMockStatement(
          liveTables.map((table) => ({ schema: table.schema, name: table.name })),
        )
      }

      if (normalized.includes('information_schema.columns')) {
        return createMockStatement(
          liveTables.flatMap((table) =>
            table.columns.map((column) => ({
              schema: table.schema,
              table_name: table.name,
              column_name: column.name,
              data_type: column.dataType,
              udt_name: column.dataType,
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
                  },
                ]
              : []),
            ...(table.uniqueConstraints ?? []).map((constraint) => ({
              schema: table.schema,
              table_name: table.name,
              constraint_name: constraint.name,
              constraint_type: 'u',
              columns: constraint.columns,
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
            })),
          ]),
        )
      }

      if (normalized.includes('pg_index')) {
        return createMockStatement(
          liveTables.flatMap((table) =>
            (table.indexes ?? []).map((index) => ({
              schema: table.schema,
              table_name: table.name,
              index_name: index.name,
              is_unique: index.unique,
              columns: index.columns,
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
    },
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
    ).toContain('create index if not exists "users_email_idx"')

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
      connector.runSql.find((sql) => /add foreign key \("authorId"\)/i.test(sql)),
    ).toContain('references "app"."users" ("id")')

    await db.close()
  })

  it('keeps dry-run free of locking, transactions, and DDL', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().dryRun()).resolves.toMatchObject({
      steps: [{ kind: 'create_table', schema: 'public', table: 'users' }],
    })
    expect(connector.runSql).toEqual([])

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
        { kind: 'create_schema', schema: 'tenant' },
        { kind: 'create_table', schema: 'tenant', table: 'items' },
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
    expect(plan.steps.map((step) => step.kind)).toEqual([
      'drop_index',
      'drop_column',
      'drop_table',
    ])

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
    const db = createDatabase({ connector, schemas: [Users, AuditEvents] })

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
    const introspection = connector.prepared.findIndex(
      (sql) =>
        /information_schema\.tables/i.test(sql) &&
        !/information_schema\.columns/i.test(sql),
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
