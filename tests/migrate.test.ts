import type { Connector, Statement } from 'db0'
import { boolean, nullable, number, optional, pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  MigrationError,
  SchemaError,
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
  hasDefault?: boolean
  isIdentity?: boolean
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
  columns?: LiveColumn[]
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

function createMockStatement(rows: unknown[] = []): Statement {
  const statement: Statement = {
    bind() {
      return statement
    },
    async all() {
      return rows
    },
    async run() {
      return { success: true }
    },
    async get() {
      return rows[0]
    },
  }
  return statement
}

function createMockConnector(options?: {
  onPrepare?: (sql: string) => Statement
  tables?: LiveTable[]
}): Connector & {
  prepared: string[]
  runSql: string[]
  liveTables: LiveTable[]
} {
  const prepared: string[] = []
  const runSql: string[] = []
  const liveTables: LiveTable[] = (options?.tables ?? []).map((t) => ({
    ...t,
    columns: t.columns ? [...t.columns] : t.columns,
    indexes: t.indexes ? [...t.indexes] : t.indexes,
    primaryKey:
      t.primaryKey ??
      (t.columns?.some((column) => column.name === 'id') ? ['id'] : undefined),
    uniqueConstraints: t.uniqueConstraints ? [...t.uniqueConstraints] : undefined,
    foreignKeys: t.foreignKeys ? [...t.foreignKeys] : undefined,
  }))

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

      if (options?.onPrepare) {
        return options.onPrepare(sql)
      }

      if (
        normalized === 'begin' ||
        normalized === 'commit' ||
        normalized === 'rollback'
      ) {
        runSql.push(normalized)
        return createMockStatement()
      }

      // Advisory lock acquire/release (session lock; no-op in mock)
      if (
        normalized.includes('pg_advisory_lock') ||
        normalized.includes('pg_advisory_unlock')
      ) {
        runSql.push(normalized)
        return createMockStatement([{ pg_advisory_lock: true }])
      }

      if (normalized.startsWith('create schema')) {
        runSql.push(sql)
        return createMockStatement()
      }

      // Tables list
      if (
        normalized.includes('information_schema.tables') &&
        !normalized.includes('information_schema.columns')
      ) {
        return createMockStatement(
          liveTables.map((t) => ({ schema: t.schema, name: t.name })),
        )
      }

      // Expanded introspection: columns from information_schema
      if (
        normalized.includes('information_schema.columns') ||
        (normalized.includes('information_schema') && normalized.includes('column_name'))
      ) {
        const rows = liveTables.flatMap((t) =>
          (t.columns ?? []).map((c) => {
            const isDefaultIdentityColumn =
              c.isIdentity === undefined &&
              c.identityGeneration === undefined &&
              c.name === 'id' &&
              t.primaryKey?.includes('id')

            return {
              schema: t.schema,
              table_name: t.name,
              column_name: c.name,
              data_type: c.dataType,
              udt_name: c.dataType,
              character_maximum_length: null,
              numeric_precision: null,
              numeric_scale: null,
              is_nullable: c.isNullable ? 'YES' : 'NO',
              column_default: c.defaultExpression ?? (c.hasDefault ? 'true' : null),
              is_identity:
                c.isIdentity || c.identityGeneration != null || isDefaultIdentityColumn
                  ? 'YES'
                  : 'NO',
              identity_generation:
                c.identityGeneration === 'always'
                  ? 'ALWAYS'
                  : c.isIdentity ||
                      c.identityGeneration === 'byDefault' ||
                      isDefaultIdentityColumn
                    ? 'BY DEFAULT'
                    : null,
            }
          }),
        )

        return createMockStatement(rows)
      }

      if (normalized.includes('con.contype as constraint_type')) {
        const rows = liveTables.flatMap((t) => [
          ...(t.primaryKey
            ? [
                {
                  schema: t.schema,
                  table_name: t.name,
                  constraint_name: `${t.name}_pkey`,
                  constraint_type: 'p',
                  columns: t.primaryKey,
                },
              ]
            : []),
          ...(t.uniqueConstraints ?? []).map((constraint) => ({
            schema: t.schema,
            table_name: t.name,
            constraint_name: constraint.name,
            constraint_type: 'u',
            columns: constraint.columns,
          })),
          ...(t.foreignKeys ?? []).map((constraint) => ({
            schema: t.schema,
            table_name: t.name,
            constraint_name: constraint.name,
            constraint_type: 'f',
            columns: constraint.columns,
            referenced_schema: constraint.referencedSchema ?? 'public',
            referenced_table: constraint.referencedTable,
            referenced_columns: constraint.referencedColumns,
            on_delete: constraint.onDelete ?? 'no action',
            on_update: constraint.onUpdate ?? 'no action',
          })),
        ])
        return createMockStatement(rows)
      }

      // Index introspection from pg_catalog
      if (normalized.includes('pg_index') || normalized.includes('index_name')) {
        const rows = liveTables.flatMap((t) =>
          (t.indexes ?? []).map((idx) => ({
            schema: t.schema,
            table_name: t.name,
            index_name: idx.name,
            is_unique: idx.unique,
            columns: idx.columns,
          })),
        )

        return createMockStatement(rows)
      }

      if (normalized.startsWith('create table')) {
        runSql.push(sql)

        const match = sql.match(/create table\s+(?:"([^"]+)"\.)?"([^"]+)"/i)
        if (match) {
          const schema = match[1] ?? 'public'
          const name = match[2]!
          if (!liveTables.some((t) => t.schema === schema && t.name === name)) {
            const uniqueConstraints = [
              ...sql.matchAll(/"([^"]+)"\s+[^,]*\bunique\b/gi),
            ].map((match) => ({
              name: `${name}_${match[1]}_key`,
              columns: [match[1]!],
            }))
            const foreignKeys = [
              ...sql.matchAll(
                /"([^"]+)"\s+[^,]*references\s+"([^"]+)"\."([^"]+)"\s+\("([^"]+)"\)(?:\s+on delete\s+(cascade|restrict|no action|set null|set default))?(?:\s+on update\s+(cascade|restrict|no action|set null|set default))?/gi,
              ),
            ].map((match) => ({
              name: `${name}_${match[1]}_fkey`,
              columns: [match[1]!],
              referencedSchema: match[2]!,
              referencedTable: match[3]!,
              referencedColumns: [match[4]!],
              ...(match[5] ? { onDelete: match[5].toLowerCase() } : {}),
              ...(match[6] ? { onUpdate: match[6].toLowerCase() } : {}),
            }))
            liveTables.push({
              schema,
              name,
              columns: [],
              indexes: [],
              primaryKey: /primary key/i.test(sql) ? ['id'] : undefined,
              uniqueConstraints,
              foreignKeys,
            })
          }
        }

        return createMockStatement()
      }

      // Null-count check before set_not_null
      if (normalized.includes('count(*)') && normalized.includes(' is null')) {
        return createMockStatement([{ count: 0 }])
      }

      // Non-null data check before drop_column (without allow)
      if (normalized.includes('count(*)') && normalized.includes(' is not null')) {
        return createMockStatement([{ count: 0 }])
      }

      if (normalized.startsWith('drop table')) {
        runSql.push(sql)

        const match = sql.match(/drop table\s+(?:"([^"]+)"\.)?"([^"]+)"/i)
        if (match) {
          const schema = match[1] ?? 'public'
          const name = match[2]!
          const idx = liveTables.findIndex((t) => t.schema === schema && t.name === name)
          if (idx >= 0) liveTables.splice(idx, 1)
        }

        return createMockStatement()
      }

      if (normalized.startsWith('drop index')) {
        runSql.push(sql)

        const match = sql.match(/drop index\s+(?:"([^"]+)"\.)?"([^"]+)"/i)
        if (match) {
          const schema = match[1] ?? 'public'
          const indexName = match[2]!
          for (const t of liveTables) {
            if (t.schema !== schema || !t.indexes) continue
            t.indexes = t.indexes.filter((i) => i.name !== indexName)
          }
        }

        return createMockStatement()
      }

      if (normalized.startsWith('alter table')) {
        runSql.push(sql)

        // Best-effort: track add column for subsequent dryRun no-ops
        const addMatch = sql.match(
          /alter table\s+(?:"([^"]+)"\.)?"([^"]+)"\s+add column\s+"([^"]+)"\s+(\S+)/i,
        )

        if (addMatch) {
          const schema = addMatch[1] ?? 'public'
          const tableName = addMatch[2]!
          const colName = addMatch[3]!
          const dataType = addMatch[4]!

          let table = liveTables.find((t) => t.schema === schema && t.name === tableName)

          if (!table) {
            table = { schema, name: tableName, columns: [], indexes: [] }
            liveTables.push(table)
          }

          table.columns = table.columns ?? []
          if (!table.columns.some((c) => c.name === colName)) {
            table.columns.push({
              name: colName,
              dataType,
              isNullable: !/not null/i.test(sql),
            })
          }
        }

        const dropColMatch = sql.match(
          /alter table\s+(?:"([^"]+)"\.)?"([^"]+)"\s+drop column\s+"([^"]+)"/i,
        )

        if (dropColMatch) {
          const schema = dropColMatch[1] ?? 'public'
          const tableName = dropColMatch[2]!
          const colName = dropColMatch[3]!

          const table = liveTables.find(
            (t) => t.schema === schema && t.name === tableName,
          )

          if (table?.columns) {
            table.columns = table.columns.filter((c) => c.name !== colName)
          }
        }

        const addForeignKeyMatch = sql.match(
          /alter table\s+(?:"([^"]+)"\.)?"([^"]+)"\s+add foreign key\s+\("([^"]+)"\)\s+references\s+(?:"([^"]+)"\.)?"([^"]+)"\s+\("([^"]+)"\)(?:\s+on delete\s+(cascade|restrict|no action|set null|set default))?(?:\s+on update\s+(cascade|restrict|no action|set null|set default))?/i,
        )
        if (addForeignKeyMatch) {
          const schema = addForeignKeyMatch[1] ?? 'public'
          const tableName = addForeignKeyMatch[2]!
          const column = addForeignKeyMatch[3]!
          const table = liveTables.find(
            (candidate) => candidate.schema === schema && candidate.name === tableName,
          )
          if (table) {
            table.foreignKeys = table.foreignKeys ?? []
            table.foreignKeys.push({
              name: `${tableName}_${column}_fkey`,
              columns: [column],
              referencedSchema: addForeignKeyMatch[4] ?? 'public',
              referencedTable: addForeignKeyMatch[5]!,
              referencedColumns: [addForeignKeyMatch[6]!],
              onDelete: addForeignKeyMatch[7]?.toLowerCase() ?? 'no action',
              onUpdate: addForeignKeyMatch[8]?.toLowerCase() ?? 'no action',
            })
          }
        }

        return createMockStatement()
      }

      if (normalized.startsWith('create') && normalized.includes('index')) {
        runSql.push(sql)

        const match = sql.match(
          /create\s+(?:unique\s+)?index\s+if\s+not\s+exists\s+"([^"]+)"\s+on\s+(?:"([^"]+)"\.)?"([^"]+)"/i,
        )

        if (match) {
          const indexName = match[1]!
          const schema = match[2] ?? 'public'
          const tableName = match[3]!
          const unique = /create\s+unique\s+index/i.test(sql)
          const columnsMatch = sql.match(/\(([^)]+)\)\s*$/)
          const columns = columnsMatch
            ? [...columnsMatch[1]!.matchAll(/"([^"]+)"/g)].map((column) => column[1]!)
            : []

          let table = liveTables.find((t) => t.schema === schema && t.name === tableName)

          if (!table) {
            table = { schema, name: tableName, columns: [], indexes: [] }
            liveTables.push(table)
          }

          table.indexes = table.indexes ?? []
          if (!table.indexes.some((i) => i.name === indexName)) {
            table.indexes.push({
              name: indexName,
              columns,
              unique,
            })
          }
        }

        return createMockStatement()
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
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'varchar(255)', unique: true })),
    age: nullable(pipe(number(), column({ type: 'integer' }))),
    bio: optional(pipe(string(), column({ type: 'text', default: '' }))),
    active: pipe(boolean(), column({ type: 'boolean', default: true })),
  },
  { primaryKey: 'id', schema: 'public' },
)

const UsersWithIndex = defineTable(
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text' })),
    orgId: pipe(string(), column({ type: 'uuid' })),
  },
  {
    primaryKey: 'id',
    schema: 'public',
    indexes: [
      'email',
      {
        name: 'users_org_email_uidx',
        columns: ['orgId', 'email'],
        unique: true,
      },
    ],
  },
)

const UsersWithNickname = defineTable(
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text' })),
    nickname: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', schema: 'public' },
)

const Posts = defineTable(
  'posts',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    authorId: reference(Users, 'id', {
      onDelete: 'cascade',
      onUpdate: 'restrict',
    }),
    title: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', schema: 'public' },
)

const Memberships = defineTable(
  'memberships',
  {
    orgId: pipe(string(), column({ type: 'uuid' })),
    userId: pipe(string(), column({ type: 'uuid' })),
    role: pipe(string(), column({ type: 'text' })),
  },
  {
    primaryKey: ['orgId', 'userId'],
    schema: 'app',
  },
)

const AppUsers = defineTable(
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text' })),
  },
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

describe('postgresDialect.compile migration steps', () => {
  it('should emit create index if not exists', () => {
    const { sql } = postgresDialect.compile({
      kind: 'create_index',
      schema: 'public',
      table: 'users',
      name: 'users_email_idx',
      columns: ['email'],
      unique: false,
    })
    expect(sql.toLowerCase()).toContain('create index if not exists')
    expect(sql).toContain('"users_email_idx"')
    expect(sql).toContain('"public"."users"')
    expect(sql).toContain('"email"')
  })

  it('should emit alter table add column', () => {
    const { sql } = postgresDialect.compile({
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
    })
    expect(sql.toLowerCase()).toContain('alter table "public"."users" add column')
    expect(sql).toContain('"nickname"')
    expect(sql.toLowerCase()).toContain('text')
    expect(sql.toLowerCase()).toContain('not null')
  })

  it('should emit alter table add foreign key', () => {
    const { sql } = postgresDialect.compile({
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
    })

    expect(sql).toContain('alter table "public"."posts" add foreign key ("authorId")')
    expect(sql).toContain('references "public"."users" ("id")')
    expect(sql.toLowerCase()).toContain('on delete cascade')
    expect(sql.toLowerCase()).toContain('on update restrict')
  })
})

describe('db.migrate().execute()', () => {
  it('should create missing tables', async () => {
    const connector = createMockConnector()
    const db = createDatabase({
      connector,
      schemas: [Users, Posts],
    })

    await db.migrate().execute()
    const firstCreates = connector.runSql.filter((s) => /create table/i.test(s))
    expect(firstCreates.length).toBe(2)
    expect(firstCreates.some((s) => /"users"/i.test(s))).toBe(true)
    expect(firstCreates.some((s) => /"posts"/i.test(s))).toBe(true)

    await db.close()
  })

  it('should preserve schema-qualified references and composite keys', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Memberships, AppUsers, AppPosts] })
    await db.migrate().execute()

    expect(
      connector.runSql.some((s) => /create schema if not exists "app"/i.test(s)),
    ).toBe(true)

    const membershipsSql = connector.runSql.find((sql) =>
      /create table "app"\."memberships"/i.test(sql),
    )
    expect(membershipsSql).toContain('primary key ("orgId", "userId")')

    const referenceSql = connector.runSql.find((sql) =>
      /alter table "app"\."posts" add foreign key/i.test(sql),
    )
    expect(referenceSql).toContain('references "app"."users" ("id")')
    expect(referenceSql?.toLowerCase()).toContain('on delete cascade')

    await db.close()
  })

  it('should skip tables that already exist', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'varchar(255)', isNullable: false },
            { name: 'age', dataType: 'integer', isNullable: true },
            { name: 'bio', dataType: 'text', isNullable: false, defaultExpression: "''" },
            {
              name: 'active',
              dataType: 'boolean',
              isNullable: false,
              defaultExpression: 'true',
            },
          ],
          uniqueConstraints: [{ name: 'users_email_key', columns: ['email'] }],
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [Users, Posts] })
    await db.migrate().execute()

    const creates = connector.runSql.filter((s) => /create table/i.test(s))
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatch(/"posts"/i)

    await db.close()
  })

  it('should treat omitted schema and public as the same registry key', () => {
    const Bare = defineTable(
      'items',
      { id: pipe(string(), column({ type: 'text' })) },
      { primaryKey: 'id' },
    )

    const Public = defineTable(
      'items',
      { id: pipe(string(), column({ type: 'text' })) },
      { primaryKey: 'id', schema: 'public' },
    )

    const connector = createMockConnector()

    expect(() => createDatabase({ connector, schemas: [Bare, Public] })).toThrow(
      SchemaError,
    )

    expect(() => createDatabase({ connector, schemas: [Bare, Public] })).toThrow(
      /duplicate table registration/,
    )
  })

  it('should create indexes from handle metadata idempotently', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [UsersWithIndex] })

    await db.migrate().execute()

    const indexes = connector.runSql.filter((s) => /create .*index/i.test(s))
    expect(indexes.length).toBeGreaterThanOrEqual(2)
    expect(indexes.some((s) => /users_email_idx/i.test(s))).toBe(true)
    expect(indexes.some((s) => /users_org_email_uidx/i.test(s))).toBe(true)
    expect(indexes.some((s) => /if not exists/i.test(s))).toBe(true)
    expect(indexes.some((s) => /unique index/i.test(s))).toBe(true)

    connector.runSql.length = 0
    await db.migrate().execute()

    const second = connector.runSql.filter((s) => /create .*index/i.test(s))
    expect(second).toHaveLength(0)

    await db.close()
  })

  it('should add missing column on existing table', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
          ],
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [UsersWithNickname] })
    await db.migrate().execute()

    expect(
      connector.runSql.some((s) =>
        /alter table "public"\."users" add column "nickname"/i.test(s),
      ),
    ).toBe(true)

    await db.close()
  })

  it('should create foreign keys after all tables regardless of registration order', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Posts, Users] })

    const plan = await db.migrate().dryRun()
    const lastCreate = plan.steps
      .map((step) => step.kind === 'create_table')
      .lastIndexOf(true)
    const foreignKey = plan.steps.findIndex((step) => step.kind === 'add_foreign_key')
    expect(lastCreate).toBeGreaterThanOrEqual(0)
    expect(foreignKey).toBeGreaterThan(lastCreate)

    await db.migrate().execute()

    const createSql = connector.runSql.filter((sql) => /^create table/i.test(sql))
    expect(createSql).toHaveLength(2)
    expect(createSql.every((sql) => !/references/i.test(sql))).toBe(true)
    const lastCreateSql = connector.runSql
      .map((sql) => /^create table/i.test(sql))
      .lastIndexOf(true)
    const foreignKeySql = connector.runSql.findIndex((sql) =>
      /add foreign key/i.test(sql),
    )
    expect(foreignKeySql).toBeGreaterThan(lastCreateSql)

    await db.close()
  })

  it('should create cyclic foreign keys in a deferred second phase', async () => {
    const BTarget = defineTable(
      'cycle_b',
      { id: pipe(string(), column({ type: 'uuid' })) },
      { primaryKey: 'id', schema: 'public' },
    )
    const A = defineTable(
      'cycle_a',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        bId: reference(BTarget, 'id'),
      },
      { primaryKey: 'id', schema: 'public' },
    )
    const B = defineTable(
      'cycle_b',
      {
        id: pipe(string(), column({ type: 'uuid' })),
        aId: reference(A, 'id'),
      },
      { primaryKey: 'id', schema: 'public' },
    )
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [A, B] })

    const plan = await db.migrate().dryRun()
    expect(plan.steps.filter((step) => step.kind === 'add_foreign_key')).toHaveLength(2)

    await db.migrate().execute()

    const lastCreate = connector.runSql
      .map((sql) => /^create table/i.test(sql))
      .lastIndexOf(true)
    const foreignKeys = connector.runSql
      .map((sql, index) => ({ sql, index }))
      .filter(({ sql }) => /add foreign key/i.test(sql))
    expect(foreignKeys).toHaveLength(2)
    expect(foreignKeys.every(({ index }) => index > lastCreate)).toBe(true)

    await db.close()
  })
})

describe('db.migrate().dryRun()', () => {
  it('should return structured steps without applying DDL', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    const plan = await db.migrate().dryRun()
    expect(plan.steps.length).toBeGreaterThan(0)

    expect(plan.steps.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['create_table']),
    )

    expect(plan.steps.some((s) => s.kind === 'create_table' && s.table === 'users')).toBe(
      true,
    )

    expect(plan.steps.some((s) => s.kind === 'create_table' && s.table === 'posts')).toBe(
      true,
    )

    // dryRun must not apply
    expect(
      connector.runSql.filter((s) => /create table|begin|commit/i.test(s)),
    ).toHaveLength(0)

    await db.close()
  })

  it('should return empty plan when catalog already matches', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            {
              name: 'id',
              dataType: 'integer',
              isNullable: false,
              isIdentity: true,
              identityGeneration: 'byDefault',
            },
            { name: 'email', dataType: 'varchar(255)', isNullable: false },
            { name: 'age', dataType: 'integer', isNullable: true },
            { name: 'bio', dataType: 'text', isNullable: false, defaultExpression: "''" },
            {
              name: 'active',
              dataType: 'boolean',
              isNullable: false,
              hasDefault: true,
              defaultExpression: 'true',
            },
          ],
          uniqueConstraints: [{ name: 'users_email_key', columns: ['email'] }],
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [Users] })

    const plan = await db.migrate().dryRun()
    expect(plan.steps).toEqual([])

    await db.close()
  })

  it('should allow multi-schema create_schema + create_table on plan', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Memberships] })

    const plan = await db.migrate().dryRun()
    expect(plan.steps).toEqual(
      expect.arrayContaining([
        { kind: 'create_schema', schema: 'app' },
        expect.objectContaining({
          kind: 'create_table',
          table: 'memberships',
          schema: 'app',
        }),
      ]),
    )

    expect(connector.runSql).toHaveLength(0)

    await db.close()
  })

  it('should allow add_column and create_index for existing table on plan', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
          ],
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [UsersWithIndex] })

    const plan = await db.migrate().dryRun()

    expect(plan.steps.some((s) => s.kind === 'add_column' && s.column === 'orgId')).toBe(
      true,
    )

    expect(
      plan.steps.some((s) => s.kind === 'create_index' && s.index === 'users_email_idx'),
    ).toBe(true)

    expect(
      plan.steps.some(
        (s) =>
          s.kind === 'create_index' && s.index === 'users_org_email_uidx' && s.unique,
      ),
    ).toBe(true)

    expect(connector.runSql).toHaveLength(0)
    await db.close()
  })

  it('should expose type and nullability changes through dryRun', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'int4', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: true },
            { name: 'age', dataType: 'integer', isNullable: false },
            { name: 'bio', dataType: 'text', isNullable: false, defaultExpression: "''" },
            {
              name: 'active',
              dataType: 'boolean',
              isNullable: false,
              defaultExpression: 'true',
            },
          ],
          uniqueConstraints: [{ name: 'users_email_key', columns: ['email'] }],
        },
      ],
    })
    const db = createDatabase({ connector, schemas: [Users] })
    const plan = await db.migrate().dryRun()

    // email: desired varchar(255) not null vs live text nullable
    expect(
      plan.steps.some(
        (s) =>
          s.kind === 'alter_column_type' &&
          s.column === 'email' &&
          s.dataType === 'varchar(255)',
      ),
    ).toBe(true)

    expect(
      plan.steps.some((s) => s.kind === 'set_not_null' && s.column === 'email'),
    ).toBe(true)

    expect(plan.steps.some((s) => s.kind === 'drop_not_null' && s.column === 'age')).toBe(
      true,
    )

    await db.close()
  })

  it('should emit drop_column / drop_table / drop_index SQL', () => {
    expect(
      postgresDialect
        .compile({
          kind: 'drop_column',
          schema: 'public',
          table: 'users',
          column: 'bio',
        })
        .sql.toLowerCase(),
    ).toContain('alter table "public"."users" drop column "bio"')

    expect(
      postgresDialect
        .compile({
          kind: 'drop_table',
          schema: 'app',
          table: 'legacy',
        })
        .sql.toLowerCase(),
    ).toContain('drop table "app"."legacy"')

    expect(
      postgresDialect
        .compile({
          kind: 'drop_index',
          schema: 'public',
          table: 'users',
          index: 'users_email_idx',
        })
        .sql.toLowerCase(),
    ).toContain('drop index "public"."users_email_idx"')
  })

  it('should refuse set_not_null on execute when column has NULL rows', async () => {
    const NotNullEmail = defineTable(
      'users',
      {
        id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
        email: pipe(string(), column({ type: 'text' })),
      },
      { primaryKey: 'id', schema: 'public' },
    )

    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: true },
          ],
        },
      ],
      onPrepare: (sql) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
        if (
          normalized === 'begin' ||
          normalized === 'commit' ||
          normalized === 'rollback'
        ) {
          return createMockStatement()
        }
        if (
          normalized.includes('information_schema.tables') &&
          !normalized.includes('information_schema.columns')
        ) {
          return createMockStatement([{ schema: 'public', name: 'users' }])
        }
        if (
          normalized.includes('information_schema.columns') ||
          (normalized.includes('information_schema') &&
            normalized.includes('column_name'))
        ) {
          return createMockStatement([
            {
              schema: 'public',
              table_name: 'users',
              column_name: 'id',
              data_type: 'integer',
              udt_name: 'integer',
              character_maximum_length: null,
              numeric_precision: null,
              numeric_scale: null,
              is_nullable: 'NO',
              column_default: null,
              is_identity: 'YES',
              identity_generation: 'BY DEFAULT',
            },
            {
              schema: 'public',
              table_name: 'users',
              column_name: 'email',
              data_type: 'text',
              udt_name: 'text',
              character_maximum_length: null,
              numeric_precision: null,
              numeric_scale: null,
              is_nullable: 'YES',
              column_default: null,
              is_identity: 'NO',
            },
          ])
        }
        if (normalized.includes('con.contype as constraint_type')) {
          return createMockStatement([
            {
              schema: 'public',
              table_name: 'users',
              constraint_name: 'users_pkey',
              constraint_type: 'p',
              columns: ['id'],
            },
          ])
        }
        if (normalized.includes('pg_index') || normalized.includes('index_name')) {
          return createMockStatement([])
        }
        if (normalized.includes('count(*)') && normalized.includes(' is null')) {
          return createMockStatement([{ count: 3 }])
        }
        return createMockStatement()
      },
    })

    const db = createDatabase({ connector, schemas: [NotNullEmail] })

    const plan = await db.migrate().dryRun()

    expect(
      plan.steps.some((s) => s.kind === 'set_not_null' && s.column === 'email'),
    ).toBe(true)

    await expect(db.migrate().execute()).rejects.toThrow(MigrationError)
    await expect(db.migrate().execute()).rejects.toThrow(/NULL values/i)

    const setNotNullSql = connector.prepared.filter((s) => /set not null/i.test(s))
    expect(setNotNullSql).toHaveLength(0)

    await db.close()
  })
})

describe('managed migration drift detection', () => {
  function matchingUsersTables(): LiveTable[] {
    return [
      {
        schema: 'public',
        name: 'users',
        columns: [
          {
            name: 'id',
            dataType: 'integer',
            isNullable: false,
            defaultExpression: null,
            identityGeneration: 'byDefault',
          },
          {
            name: 'email',
            dataType: 'varchar(255)',
            isNullable: false,
            defaultExpression: null,
            identityGeneration: null,
          },
          {
            name: 'age',
            dataType: 'integer',
            isNullable: true,
            defaultExpression: null,
            identityGeneration: null,
          },
          {
            name: 'bio',
            dataType: 'text',
            isNullable: false,
            defaultExpression: "''",
            identityGeneration: null,
          },
          {
            name: 'active',
            dataType: 'boolean',
            isNullable: false,
            defaultExpression: 'true',
            identityGeneration: null,
          },
        ],
        indexes: [],
        primaryKey: ['id'],
        uniqueConstraints: [{ name: 'users_email_key', columns: ['email'] }],
        foreignKeys: [],
      },
    ]
  }

  it('should converge only when all managed properties match', async () => {
    const connector = createMockConnector({ tables: matchingUsersTables() })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().dryRun()).resolves.toMatchObject({ steps: [] })

    await db.close()
  })

  const driftCases: Array<[string, (tables: LiveTable[]) => void]> = [
    [
      'default',
      (tables) => {
        tables[0]!.columns!.find(
          (column) => column.name === 'active',
        )!.defaultExpression = 'false'
      },
    ],
    [
      'identity',
      (tables) => {
        tables[0]!.columns!.find((column) => column.name === 'id')!.identityGeneration =
          'always'
      },
    ],
    [
      'primary key',
      (tables) => {
        tables[0]!.primaryKey = ['email']
      },
    ],
    [
      'unique constraint',
      (tables) => {
        tables[0]!.uniqueConstraints = []
      },
    ],
    [
      'foreign key',
      (tables) => {
        tables[0]!.foreignKeys = [
          {
            name: 'users_email_fkey',
            columns: ['email'],
            referencedSchema: 'public',
            referencedTable: 'accounts',
            referencedColumns: ['email'],
            onDelete: 'no action',
            onUpdate: 'no action',
          },
        ]
      },
    ],
  ]

  it.each(driftCases)('should reject unsupported %s drift', async (property, mutate) => {
    const tables = matchingUsersTables()
    mutate(tables)
    const connector = createMockConnector({ tables })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.migrate().dryRun()).rejects.toThrow(new RegExp(property, 'i'))

    await db.close()
  })

  it('should compare same-named index columns and uniqueness', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
            { name: 'orgId', dataType: 'uuid', isNullable: false },
          ],
          indexes: [
            { name: 'users_email_idx', columns: ['orgId'], unique: false },
            {
              name: 'users_org_email_uidx',
              columns: ['orgId', 'email'],
              unique: false,
            },
          ],
        },
      ],
    })
    const db = createDatabase({ connector, schemas: [UsersWithIndex] })

    await expect(db.migrate().dryRun()).rejects.toThrow(/index definition change/i)

    await db.close()
  })

  it('should compare foreign-key targets and actions', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'posts',
          columns: [
            {
              name: 'id',
              dataType: 'uuid',
              isNullable: false,
              isIdentity: false,
              identityGeneration: null,
            },
            { name: 'authorId', dataType: 'integer', isNullable: false },
            { name: 'title', dataType: 'text', isNullable: false },
          ],
          primaryKey: ['id'],
          uniqueConstraints: [],
          foreignKeys: [
            {
              name: 'posts_authorId_fkey',
              columns: ['authorId'],
              referencedSchema: 'public',
              referencedTable: 'users',
              referencedColumns: ['id'],
              onDelete: 'restrict',
              onUpdate: 'restrict',
            },
          ],
        },
      ],
    })
    const db = createDatabase({ connector, schemas: [Posts] })

    await expect(db.migrate().dryRun()).rejects.toThrow(/foreign key change/i)

    await db.close()
  })
})

describe('db.migrate() allowlist + safety', () => {
  const UsersBase = defineTable(
    'users',
    {
      id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
      email: pipe(string(), column({ type: 'text' })),
    },
    { primaryKey: 'id', schema: 'public' },
  )

  const UsersWithExtraLive = {
    schema: 'public',
    name: 'users',
    columns: [
      { name: 'id', dataType: 'integer', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
      { name: 'legacy', dataType: 'text', isNullable: true },
    ],
    indexes: [{ name: 'users_legacy_idx', columns: ['legacy'], unique: false }],
  }

  it('should omit drop_column without allow and include it with allow on dryRun', async () => {
    const connector = createMockConnector({ tables: [UsersWithExtraLive] })
    const db = createDatabase({ connector, schemas: [UsersBase] })

    const denied = await db.migrate().dryRun()
    expect(denied.steps.some((s) => s.kind === 'drop_column')).toBe(false)

    const allowed = await db.migrate().allow('dropColumn').dryRun()
    expect(
      allowed.steps.some((s) => s.kind === 'drop_column' && s.column === 'legacy'),
    ).toBe(true)

    await db.close()
  })

  it('should not add hidden drop_column work during execute', async () => {
    const connector = createMockConnector({
      tables: [UsersWithExtraLive],
    })

    const db = createDatabase({ connector, schemas: [UsersBase] })

    const plan = await db.migrate().dryRun()
    expect(plan.steps.some((step) => step.kind === 'drop_column')).toBe(false)

    await expect(db.migrate().execute()).resolves.toBeUndefined()

    const drops = connector.prepared.filter((s) => /drop column/i.test(s))
    expect(drops).toHaveLength(0)

    await db.close()
  })

  it('should omit empty-column drop_column without allow on dryRun and execute', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
            { name: 'legacy', dataType: 'text', isNullable: true },
          ],
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [UsersBase] })

    const plan = await db.migrate().dryRun()
    expect(plan.steps.some((s) => s.kind === 'drop_column')).toBe(false)

    await expect(db.migrate().execute()).resolves.toBeUndefined()

    const drops = connector.prepared.filter((s) => /drop column/i.test(s))
    expect(drops).toHaveLength(0)

    await db.close()
  })

  it('should allow drop_column with non-null data when calling allow(dropColumn)', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
            { name: 'legacy', dataType: 'text', isNullable: true },
          ],
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [UsersBase] })
    await db.migrate().allow('dropColumn').execute()

    expect(connector.runSql.some((s) => /drop column "legacy"/i.test(s))).toBe(true)

    await db.close()
  })

  it('should not drop tables outside registry without allow(dropTable)', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
          ],
        },
        {
          schema: 'public',
          name: 'orphan',
          columns: [{ name: 'id', dataType: 'integer', isNullable: false }],
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [UsersBase] })
    const plan = await db.migrate().dryRun()
    expect(plan.steps.some((s) => s.kind === 'drop_table')).toBe(false)

    await db.migrate().execute()
    expect(connector.runSql.some((s) => /drop table/i.test(s))).toBe(false)

    const withAllow = await db.migrate().allow('dropTable').dryRun()
    expect(
      withAllow.steps.some((s) => s.kind === 'drop_table' && s.table === 'orphan'),
    ).toBe(true)

    await db.migrate().allow('dropTable').execute()

    expect(connector.runSql.some((s) => /drop table "public"\."orphan"/i.test(s))).toBe(
      true,
    )

    await db.close()
  })

  it('should not drop indexes outside metadata without allow(dropIndex)', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
          ],
          indexes: [{ name: 'users_stale_idx', columns: ['email'], unique: false }],
        },
      ],
    })

    const db = createDatabase({ connector, schemas: [UsersBase] })

    const plan = await db.migrate().dryRun()
    expect(plan.steps.some((s) => s.kind === 'drop_index')).toBe(false)

    await db.migrate().execute()

    expect(connector.runSql.some((s) => /drop index/i.test(s))).toBe(false)

    const withAllow = await db.migrate().allow('dropIndex').dryRun()
    expect(
      withAllow.steps.some(
        (s) => s.kind === 'drop_index' && s.index === 'users_stale_idx',
      ),
    ).toBe(true)

    await db.migrate().allow('dropIndex').execute()

    expect(
      connector.runSql.some((s) => /drop index "public"\."users_stale_idx"/i.test(s)),
    ).toBe(true)

    await db.close()
  })

  it('should acquire and release advisory lock on execute but not on dryRun', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [UsersBase] })

    await db.migrate().dryRun()
    expect(connector.runSql.some((s) => /pg_advisory_lock/i.test(s))).toBe(false)

    connector.runSql.length = 0
    await db.migrate().execute()
    const locks = connector.runSql.filter((s) => /pg_advisory_lock/i.test(s))
    expect(locks.length).toBeGreaterThanOrEqual(1)

    const unlocks = connector.runSql.filter((s) => /pg_advisory_unlock/i.test(s))
    expect(unlocks.length).toBeGreaterThanOrEqual(1)

    // lock before begin
    const lockIdx = connector.runSql.findIndex((s) => /pg_advisory_lock/i.test(s))
    expect(lockIdx).toBeGreaterThanOrEqual(0)

    const beginIdx = connector.runSql.findIndex((s) => s === 'begin')
    expect(beginIdx).toBeGreaterThan(lockIdx)

    const unlockIdx = connector.runSql.findIndex((s) => /pg_advisory_unlock/i.test(s))
    expect(unlockIdx).toBeGreaterThan(beginIdx)

    await db.close()
  })

  it('should include destructive steps only when allowed through the builder', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
            { name: 'legacy', dataType: 'text', isNullable: true },
          ],
          indexes: [{ name: 'users_stale_idx', columns: ['email'], unique: false }],
        },
        {
          schema: 'public',
          name: 'orphan',
          columns: [{ name: 'id', dataType: 'integer', isNullable: false }],
        },
      ],
    })
    const db = createDatabase({ connector, schemas: [UsersBase] })

    const safe = await db.migrate().dryRun()
    expect(safe.steps.some((s) => s.kind.startsWith('drop_'))).toBe(false)

    const all = await db
      .migrate()
      .allow('dropColumn')
      .allow('dropTable')
      .allow('dropIndex')
      .dryRun()

    expect(all.steps.some((s) => s.kind === 'drop_column' && s.column === 'legacy')).toBe(
      true,
    )

    expect(all.steps.some((s) => s.kind === 'drop_table' && s.table === 'orphan')).toBe(
      true,
    )

    expect(
      all.steps.some((s) => s.kind === 'drop_index' && s.index === 'users_stale_idx'),
    ).toBe(true)

    await db.close()
  })

  it('should only target orphans in schemas owned by registered handles', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
          ],
        },
        {
          schema: 'public',
          name: 'orphans',
          columns: [{ name: 'id', dataType: 'integer', isNullable: false }],
        },
        {
          schema: 'other_app',
          name: 'secrets',
          columns: [{ name: 'id', dataType: 'integer', isNullable: false }],
        },
      ],
    })
    const db = createDatabase({ connector, schemas: [UsersBase] })

    const plan = await db.migrate().allow('dropTable').dryRun()

    expect(
      plan.steps.some(
        (s) =>
          s.kind === 'drop_table' &&
          s.table === 'orphans' &&
          (s.schema === 'public' || s.schema === undefined),
      ),
    ).toBe(true)

    expect(
      plan.steps.some(
        (s) =>
          s.kind === 'drop_table' && s.table === 'secrets' && s.schema === 'other_app',
      ),
    ).toBe(false)

    await db.close()
  })
})
