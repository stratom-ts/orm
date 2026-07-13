import { createDb } from '@/client'
import { defineTable } from '@/defineTable'
import { buildCreateTableAst, planMigration } from '@/ddl'
import { postgresDialect } from '@/dialects'
import type { CatalogSnapshot } from '@/dialects'
import { column, reference, table } from '@/schemas'
import { MigrationError, SchemaError } from '@/utils/error'
import type { Connector, Statement } from 'db0'
import {
  boolean,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
  title,
} from 'valibot'
import { describe, expect, it } from 'vitest'

type LiveColumn = {
  name: string
  dataType: string
  isNullable: boolean
  hasDefault?: boolean
  isIdentity?: boolean
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
        (normalized.includes('information_schema') &&
          normalized.includes('column_name'))
      ) {
        const rows = liveTables.flatMap((t) =>
          (t.columns ?? []).map((c) => ({
            schema: t.schema,
            table_name: t.name,
            column_name: c.name,
            data_type: c.dataType,
            udt_name: c.dataType,
            character_maximum_length: null,
            numeric_precision: null,
            numeric_scale: null,
            is_nullable: c.isNullable ? 'YES' : 'NO',
            column_default: c.hasDefault ? 'true' : null,
            is_identity: c.isIdentity ? 'YES' : 'NO',
          })),
        )
        return createMockStatement(rows)
      }

      // Index introspection from pg_catalog
      if (
        normalized.includes('pg_index') ||
        normalized.includes('index_name')
      ) {
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
            liveTables.push({
              schema,
              name,
              columns: [],
              indexes: [],
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
      if (
        normalized.includes('count(*)') &&
        normalized.includes(' is not null')
      ) {
        return createMockStatement([{ count: 0 }])
      }

      if (normalized.startsWith('drop table')) {
        runSql.push(sql)
        const match = sql.match(/drop table\s+(?:"([^"]+)"\.)?"([^"]+)"/i)
        if (match) {
          const schema = match[1] ?? 'public'
          const name = match[2]!
          const idx = liveTables.findIndex(
            (t) => t.schema === schema && t.name === name,
          )
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
          let table = liveTables.find(
            (t) => t.schema === schema && t.name === tableName,
          )
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
          let table = liveTables.find(
            (t) => t.schema === schema && t.name === tableName,
          )
          if (!table) {
            table = { schema, name: tableName, columns: [], indexes: [] }
            liveTables.push(table)
          }
          table.indexes = table.indexes ?? []
          if (!table.indexes.some((i) => i.name === indexName)) {
            table.indexes.push({
              name: indexName,
              columns: [],
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
  pipe(
    object({
      id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
      email: pipe(string(), column({ type: 'varchar(255)', unique: true })),
      age: nullable(pipe(number(), column({ type: 'integer' }))),
      bio: optional(pipe(string(), column({ type: 'text' }))),
      active: pipe(boolean(), column({ type: 'boolean', default: true })),
    }),
    title('users'),
    table({ name: 'users', primaryKey: 'id', schema: 'public' }),
  ),
)

const UsersWithIndex = defineTable(
  pipe(
    object({
      id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
      email: pipe(string(), column({ type: 'text' })),
      orgId: pipe(string(), column({ type: 'uuid' })),
    }),
    title('users'),
    table({
      name: 'users',
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
    }),
  ),
)

const UsersWithNickname = defineTable(
  pipe(
    object({
      id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
      email: pipe(string(), column({ type: 'text' })),
      nickname: pipe(string(), column({ type: 'text' })),
    }),
    title('users'),
    table({ name: 'users', primaryKey: 'id', schema: 'public' }),
  ),
)

const Posts = defineTable(
  pipe(
    object({
      id: pipe(string(), column({ type: 'uuid' })),
      authorId: reference(Users, 'id', {
        onDelete: 'cascade',
        onUpdate: 'restrict',
      }),
      title: pipe(string(), column({ type: 'text' })),
    }),
    title('posts'),
    table({ name: 'posts', primaryKey: 'id', schema: 'public' }),
  ),
)

const Memberships = defineTable(
  pipe(
    object({
      orgId: pipe(string(), column({ type: 'uuid' })),
      userId: pipe(string(), column({ type: 'uuid' })),
      role: pipe(string(), column({ type: 'text' })),
    }),
    title('memberships'),
    table({
      name: 'memberships',
      primaryKey: ['orgId', 'userId'],
      schema: 'app',
    }),
  ),
)

const AppUsers = defineTable(
  pipe(
    object({
      id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
      email: pipe(string(), column({ type: 'text' })),
    }),
    title('users'),
    table({ name: 'users', primaryKey: 'id', schema: 'app' }),
  ),
)

const AppPosts = defineTable(
  pipe(
    object({
      id: pipe(string(), column({ type: 'uuid' })),
      authorId: reference(AppUsers, 'id', { onDelete: 'cascade' }),
    }),
    title('posts'),
    table({ name: 'posts', primaryKey: 'id', schema: 'app' }),
  ),
)

describe('buildCreateTableAst', () => {
  it('builds columns, identity, unique, default, and nullability', () => {
    const ast = buildCreateTableAst(Users, postgresDialect)
    expect(ast.kind).toBe('create_table')
    expect(ast.table).toBe('users')
    expect(ast.schema).toBe('public')
    expect(ast.primaryKey).toEqual(['id'])
    expect(ast.columns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'id',
          dataType: 'integer',
          generated: 'byDefault',
          notNull: true,
        }),
        expect.objectContaining({
          name: 'email',
          dataType: 'varchar(255)',
          unique: true,
          notNull: true,
        }),
        expect.objectContaining({
          name: 'age',
          dataType: 'integer',
          notNull: false,
        }),
        // optional() is omit-on-insert, not SQL NULL
        expect.objectContaining({
          name: 'bio',
          dataType: 'text',
          notNull: true,
        }),
        expect.objectContaining({
          name: 'active',
          dataType: 'boolean',
          defaultValue: true,
          notNull: true,
        }),
      ]),
    )
  })

  it('includes FK actions, schema, and composite primary keys', () => {
    const posts = buildCreateTableAst(Posts, postgresDialect)
    const author = posts.columns.find((c) => c.name === 'authorId')
    expect(author?.references).toMatchObject({
      schema: 'public',
      table: 'users',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: 'restrict',
    })

    const memberships = buildCreateTableAst(Memberships, postgresDialect)
    expect(memberships.primaryKey).toEqual(['orgId', 'userId'])
    expect(memberships.schema).toBe('app')

    const appPosts = buildCreateTableAst(AppPosts, postgresDialect)
    const appAuthor = appPosts.columns.find((c) => c.name === 'authorId')
    expect(appAuthor?.references).toMatchObject({
      schema: 'app',
      table: 'users',
      column: 'id',
    })
  })
})

describe('postgresDialect.compile create_table', () => {
  it('emits qualified create table SQL with constraints', () => {
    const ast = buildCreateTableAst(Users, postgresDialect)
    const { sql, params } = postgresDialect.compile(ast)
    expect(params).toEqual([])
    expect(sql.toLowerCase()).toContain('create table "public"."users"')
    expect(sql.toLowerCase()).toContain('generated by default as identity')
    expect(sql.toLowerCase()).toContain('primary key')
    expect(sql.toLowerCase()).toContain('unique')
    expect(sql.toLowerCase()).toContain('default true')
  })

  it('emits composite primary key and schema-qualified foreign keys', () => {
    const postsSql = postgresDialect
      .compile(buildCreateTableAst(Posts, postgresDialect))
      .sql.toLowerCase()
    expect(postsSql).toContain('references "public"."users" ("id")')
    expect(postsSql).toContain('on delete cascade')
    expect(postsSql).toContain('on update restrict')

    const appPostsSql = postgresDialect
      .compile(buildCreateTableAst(AppPosts, postgresDialect))
      .sql.toLowerCase()
    expect(appPostsSql).toContain('references "app"."users" ("id")')

    const membershipsSql = postgresDialect
      .compile(buildCreateTableAst(Memberships, postgresDialect))
      .sql.toLowerCase()
    expect(membershipsSql).toContain('create table "app"."memberships"')
    expect(membershipsSql).toContain('primary key ("orgid", "userid")')
  })

  it('emits create index if not exists', () => {
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

  it('emits alter table add column', () => {
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
    expect(sql.toLowerCase()).toContain(
      'alter table "public"."users" add column',
    )
    expect(sql).toContain('"nickname"')
    expect(sql.toLowerCase()).toContain('text')
    expect(sql.toLowerCase()).toContain('not null')
  })
})

describe('db.migrate().execute()', () => {
  it('creates missing tables and is idempotent on re-run', async () => {
    const connector = createMockConnector()
    const db = createDb({
      connector,
      schemas: [Users, Posts],
    })

    await db.migrate().execute()
    const firstCreates = connector.runSql.filter((s) => /create table/i.test(s))
    expect(firstCreates.length).toBe(2)
    expect(firstCreates.some((s) => /"users"/i.test(s))).toBe(true)
    expect(firstCreates.some((s) => /"posts"/i.test(s))).toBe(true)

    connector.runSql.length = 0
    connector.prepared.length = 0
    await db.migrate().execute()
    const secondCreates = connector.runSql.filter((s) =>
      /create table/i.test(s),
    )
    expect(secondCreates).toHaveLength(0)

    await db.close()
  })

  it('creates schema-qualified tables and emits create schema if needed', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Memberships] })
    await db.migrate().execute()
    expect(
      connector.runSql.some((s) =>
        /create schema if not exists "app"/i.test(s),
      ),
    ).toBe(true)
    expect(
      connector.runSql.some((s) =>
        /create table "app"\."memberships"/i.test(s),
      ),
    ).toBe(true)
    await db.close()
  })

  it('skips tables that already exist', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'varchar(255)', isNullable: false },
            { name: 'age', dataType: 'integer', isNullable: true },
            { name: 'bio', dataType: 'text', isNullable: false },
            { name: 'active', dataType: 'boolean', isNullable: false },
          ],
        },
      ],
    })
    const db = createDb({ connector, schemas: [Users, Posts] })
    await db.migrate().execute()
    const creates = connector.runSql.filter((s) => /create table/i.test(s))
    expect(creates).toHaveLength(1)
    expect(creates[0]).toMatch(/"posts"/i)
    await db.close()
  })

  it('treats omitted schema and public as the same registry key', () => {
    const Bare = defineTable(
      pipe(
        object({ id: pipe(string(), column({ type: 'text' })) }),
        title('items'),
        table({ name: 'items', primaryKey: 'id' }),
      ),
    )
    const Public = defineTable(
      pipe(
        object({ id: pipe(string(), column({ type: 'text' })) }),
        title('items'),
        table({ name: 'items', primaryKey: 'id', schema: 'public' }),
      ),
    )
    const connector = createMockConnector()
    expect(() => createDb({ connector, schemas: [Bare, Public] })).toThrow(
      SchemaError,
    )
    expect(() => createDb({ connector, schemas: [Bare, Public] })).toThrow(
      /duplicate table registration/,
    )
  })

  it('creates indexes from handle metadata idempotently', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [UsersWithIndex] })
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

  it('adds missing column on existing table', async () => {
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
    const db = createDb({ connector, schemas: [UsersWithNickname] })
    await db.migrate().execute()
    expect(
      connector.runSql.some((s) =>
        /alter table "public"\."users" add column "nickname"/i.test(s),
      ),
    ).toBe(true)
    await db.close()
  })
})

describe('db.migrate().dryRun()', () => {
  it('returns structured steps without applying DDL', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users, Posts] })
    const plan = await db.migrate().dryRun()
    expect(plan.steps.length).toBeGreaterThan(0)
    expect(plan.steps.map((s) => s.kind)).toEqual(
      expect.arrayContaining(['create_table']),
    )
    expect(
      plan.steps.some((s) => s.kind === 'create_table' && s.table === 'users'),
    ).toBe(true)
    expect(
      plan.steps.some((s) => s.kind === 'create_table' && s.table === 'posts'),
    ).toBe(true)
    // dryRun must not apply
    expect(
      connector.runSql.filter((s) => /create table|begin|commit/i.test(s)),
    ).toHaveLength(0)
    await db.close()
  })

  it('returns empty plan when catalog already matches', async () => {
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
            },
            { name: 'email', dataType: 'varchar(255)', isNullable: false },
            { name: 'age', dataType: 'integer', isNullable: true },
            { name: 'bio', dataType: 'text', isNullable: false },
            {
              name: 'active',
              dataType: 'boolean',
              isNullable: false,
              hasDefault: true,
            },
          ],
        },
      ],
    })
    const db = createDb({ connector, schemas: [Users] })
    const plan = await db.migrate().dryRun()
    expect(plan.steps).toEqual([])
    await db.close()
  })

  it('plans multi-schema create_schema + create_table', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Memberships] })
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

  it('plans add_column and create_index for existing table', async () => {
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
    const db = createDb({ connector, schemas: [UsersWithIndex] })
    const plan = await db.migrate().dryRun()
    expect(
      plan.steps.some((s) => s.kind === 'add_column' && s.column === 'orgId'),
    ).toBe(true)
    expect(
      plan.steps.some(
        (s) => s.kind === 'create_index' && s.index === 'users_email_idx',
      ),
    ).toBe(true)
    expect(
      plan.steps.some(
        (s) =>
          s.kind === 'create_index' &&
          s.index === 'users_org_email_uidx' &&
          s.unique,
      ),
    ).toBe(true)
    expect(connector.runSql).toHaveLength(0)
    await db.close()
  })

  it('plans type and nullability alters when normalize differs', () => {
    const catalog: CatalogSnapshot = {
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'int4', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: true },
            { name: 'age', dataType: 'integer', isNullable: false },
            { name: 'bio', dataType: 'text', isNullable: false },
            { name: 'active', dataType: 'boolean', isNullable: false },
          ],
        },
      ],
    }
    const plan = planMigration([Users], catalog, postgresDialect)
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
    expect(
      plan.steps.some((s) => s.kind === 'drop_not_null' && s.column === 'age'),
    ).toBe(true)
  })

  it('emits drop_column / drop_table / drop_index SQL', () => {
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

  it('execute refuses set_not_null when column has NULL rows', async () => {
    const NotNullEmail = defineTable(
      pipe(
        object({
          id: pipe(
            number(),
            column({ type: 'integer', generated: 'byDefault' }),
          ),
          email: pipe(string(), column({ type: 'text' })),
        }),
        title('users'),
        table({ name: 'users', primaryKey: 'id', schema: 'public' }),
      ),
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
              is_identity: 'NO',
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
        if (
          normalized.includes('pg_index') ||
          normalized.includes('index_name')
        ) {
          return createMockStatement([])
        }
        if (
          normalized.includes('count(*)') &&
          normalized.includes(' is null')
        ) {
          return createMockStatement([{ count: 3 }])
        }
        return createMockStatement()
      },
    })
    const db = createDb({ connector, schemas: [NotNullEmail] })
    const plan = await db.migrate().dryRun()
    expect(
      plan.steps.some((s) => s.kind === 'set_not_null' && s.column === 'email'),
    ).toBe(true)
    await expect(db.migrate().execute()).rejects.toThrow(MigrationError)
    await expect(db.migrate().execute()).rejects.toThrow(/NULL values/i)
    const setNotNullSql = connector.prepared.filter((s) =>
      /set not null/i.test(s),
    )
    expect(setNotNullSql).toHaveLength(0)
    await db.close()
  })
})

describe('db.migrate() allowlist + safety', () => {
  const UsersBase = defineTable(
    pipe(
      object({
        id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
        email: pipe(string(), column({ type: 'text' })),
      }),
      title('users'),
      table({ name: 'users', primaryKey: 'id', schema: 'public' }),
    ),
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

  it('dryRun omits drop_column without allow; includes with allow', async () => {
    const connector = createMockConnector({ tables: [UsersWithExtraLive] })
    const db = createDb({ connector, schemas: [UsersBase] })

    const denied = await db.migrate().dryRun()
    expect(denied.steps.some((s) => s.kind === 'drop_column')).toBe(false)

    const allowed = await db.migrate().allow('dropColumn').dryRun()
    expect(
      allowed.steps.some(
        (s) => s.kind === 'drop_column' && s.column === 'legacy',
      ),
    ).toBe(true)
    await db.close()
  })

  it('execute refuses drop_column with non-null data without allow', async () => {
    const connector = createMockConnector({
      tables: [UsersWithExtraLive],
      onPrepare: (sql) => {
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase()
        if (
          normalized.includes('pg_advisory_lock') ||
          normalized.includes('pg_advisory_unlock')
        ) {
          return createMockStatement([{ ok: true }])
        }
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
          return createMockStatement(
            UsersWithExtraLive.columns.map((c) => ({
              schema: 'public',
              table_name: 'users',
              column_name: c.name,
              data_type: c.dataType,
              udt_name: c.dataType,
              character_maximum_length: null,
              numeric_precision: null,
              numeric_scale: null,
              is_nullable: c.isNullable ? 'YES' : 'NO',
              column_default: null,
              is_identity: 'NO',
            })),
          )
        }
        if (
          normalized.includes('pg_index') ||
          normalized.includes('index_name')
        ) {
          return createMockStatement([])
        }
        if (
          normalized.includes('count(*)') &&
          normalized.includes(' is not null')
        ) {
          return createMockStatement([{ count: 5 }])
        }
        return createMockStatement()
      },
    })
    const db = createDb({ connector, schemas: [UsersBase] })
    await expect(db.migrate().execute()).rejects.toThrow(MigrationError)
    await expect(db.migrate().execute()).rejects.toThrow(
      /drop column|non-null data/i,
    )
    const drops = connector.prepared.filter((s) => /drop column/i.test(s))
    expect(drops).toHaveLength(0)
    await db.close()
  })

  it('allow(dropColumn) drops column even when data exists', async () => {
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
    const db = createDb({ connector, schemas: [UsersBase] })
    await db.migrate().allow('dropColumn').execute()
    expect(connector.runSql.some((s) => /drop column "legacy"/i.test(s))).toBe(
      true,
    )
    await db.close()
  })

  it('does not drop tables outside registry without allow(dropTable)', async () => {
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
    const db = createDb({ connector, schemas: [UsersBase] })
    const plan = await db.migrate().dryRun()
    expect(plan.steps.some((s) => s.kind === 'drop_table')).toBe(false)
    await db.migrate().execute()
    expect(connector.runSql.some((s) => /drop table/i.test(s))).toBe(false)

    const withAllow = await db.migrate().allow('dropTable').dryRun()
    expect(
      withAllow.steps.some(
        (s) => s.kind === 'drop_table' && s.table === 'orphan',
      ),
    ).toBe(true)
    await db.migrate().allow('dropTable').execute()
    expect(
      connector.runSql.some((s) => /drop table "public"\."orphan"/i.test(s)),
    ).toBe(true)
    await db.close()
  })

  it('does not drop indexes outside metadata without allow(dropIndex)', async () => {
    const connector = createMockConnector({
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
          ],
          indexes: [
            { name: 'users_stale_idx', columns: ['email'], unique: false },
          ],
        },
      ],
    })
    const db = createDb({ connector, schemas: [UsersBase] })
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
      connector.runSql.some((s) =>
        /drop index "public"\."users_stale_idx"/i.test(s),
      ),
    ).toBe(true)
    await db.close()
  })

  it('execute acquires and releases advisory lock; dryRun does not', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [UsersBase] })

    await db.migrate().dryRun()
    expect(connector.runSql.some((s) => /pg_advisory_lock/i.test(s))).toBe(
      false,
    )

    connector.runSql.length = 0
    await db.migrate().execute()
    const locks = connector.runSql.filter((s) => /pg_advisory_lock/i.test(s))
    const unlocks = connector.runSql.filter((s) =>
      /pg_advisory_unlock/i.test(s),
    )
    expect(locks.length).toBeGreaterThanOrEqual(1)
    expect(unlocks.length).toBeGreaterThanOrEqual(1)
    // lock before begin
    const lockIdx = connector.runSql.findIndex((s) =>
      /pg_advisory_lock/i.test(s),
    )
    const beginIdx = connector.runSql.findIndex((s) => s === 'begin')
    const unlockIdx = connector.runSql.findIndex((s) =>
      /pg_advisory_unlock/i.test(s),
    )
    expect(lockIdx).toBeGreaterThanOrEqual(0)
    expect(beginIdx).toBeGreaterThan(lockIdx)
    expect(unlockIdx).toBeGreaterThan(beginIdx)
    await db.close()
  })

  it('planMigration includes destructive steps only when allowed', () => {
    const catalog: CatalogSnapshot = {
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
            { name: 'legacy', dataType: 'text', isNullable: true },
          ],
          indexes: [
            { name: 'users_stale_idx', columns: ['email'], unique: false },
          ],
        },
        {
          schema: 'public',
          name: 'orphan',
          columns: [{ name: 'id', dataType: 'integer', isNullable: false }],
        },
      ],
    }
    const safe = planMigration([UsersBase], catalog, postgresDialect)
    expect(safe.steps.some((s) => s.kind.startsWith('drop_'))).toBe(false)

    const all = planMigration(
      [UsersBase],
      catalog,
      postgresDialect,
      new Set(['dropColumn', 'dropTable', 'dropIndex']),
    )
    expect(
      all.steps.some((s) => s.kind === 'drop_column' && s.column === 'legacy'),
    ).toBe(true)
    expect(
      all.steps.some((s) => s.kind === 'drop_table' && s.table === 'orphan'),
    ).toBe(true)
    expect(
      all.steps.some(
        (s) => s.kind === 'drop_index' && s.index === 'users_stale_idx',
      ),
    ).toBe(true)
  })

  it('dropTable only targets orphans in schemas owned by registered handles', () => {
    const catalog: CatalogSnapshot = {
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
    }

    const plan = planMigration(
      [UsersBase],
      catalog,
      postgresDialect,
      new Set(['dropTable']),
    )

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
          s.kind === 'drop_table' &&
          s.table === 'secrets' &&
          s.schema === 'other_app',
      ),
    ).toBe(false)
  })
})

describe('db.migrate integration', () => {
  const url = process.env.DATABASE_URL

  it.skipIf(!url)(
    'creates tables on real Postgres including non-public schema without pre-create',
    async () => {
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const schemaName = `so_test_${suffix}`

      const UsersLive = defineTable(
        pipe(
          object({
            id: pipe(
              number(),
              column({ type: 'integer', generated: 'byDefault' }),
            ),
            email: pipe(string(), column({ type: 'text', unique: true })),
          }),
          title('users'),
          table({
            name: 'users',
            primaryKey: 'id',
            schema: schemaName,
            indexes: [
              {
                columns: ['email'],
                unique: true,
                name: `users_email_${suffix}`,
              },
            ],
          }),
        ),
      )

      const PostsLive = defineTable(
        pipe(
          object({
            id: pipe(string(), column({ type: 'uuid' })),
            authorId: reference(UsersLive, 'id', { onDelete: 'cascade' }),
          }),
          title('posts'),
          table({
            name: 'posts',
            primaryKey: 'id',
            schema: schemaName,
          }),
        ),
      )

      const { createDatabase } = await import('db0')
      const setup = createDatabase(postgresql({ url: url as string }))
      const db = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [UsersLive, PostsLive],
      })

      try {
        const emptyPlan = await db.migrate().dryRun()
        expect(emptyPlan.steps.some((s) => s.kind === 'create_schema')).toBe(
          true,
        )
        expect(emptyPlan.steps.some((s) => s.kind === 'create_table')).toBe(
          true,
        )

        await db.migrate().execute()
        const noOp = await db.migrate().dryRun()
        expect(noOp.steps).toEqual([])

        await db.migrate().execute()

        const rows = (await setup
          .prepare(
            `
          select table_name
          from information_schema.tables
          where table_schema = $1
          order by table_name
        `,
          )
          .bind(schemaName)
          .all()) as Array<{ table_name: string }>

        const names = rows.map((r) => r.table_name)
        expect(names).toEqual(expect.arrayContaining(['posts', 'users']))

        const indexes = (await setup
          .prepare(
            `
          select indexname
          from pg_indexes
          where schemaname = $1
        `,
          )
          .bind(schemaName)
          .all()) as Array<{ indexname: string }>
        expect(
          indexes.some((i) => i.indexname === `users_email_${suffix}`),
        ).toBe(true)
      } finally {
        await db.close()
        try {
          await setup.exec(`drop schema if exists "${schemaName}" cascade`)
        } finally {
          await setup.dispose()
        }
      }
    },
    60_000,
  )

  it.skipIf(!url)(
    'adds column and index on real Postgres via public migrate API',
    async () => {
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const { createDatabase } = await import('db0')
      const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
      const schemaName = `so_alt_${suffix}`

      const Base = defineTable(
        pipe(
          object({
            id: pipe(
              number(),
              column({ type: 'integer', generated: 'byDefault' }),
            ),
            email: pipe(string(), column({ type: 'text' })),
          }),
          title('people'),
          table({
            name: 'people',
            primaryKey: 'id',
            schema: schemaName,
          }),
        ),
      )

      const Expanded = defineTable(
        pipe(
          object({
            id: pipe(
              number(),
              column({ type: 'integer', generated: 'byDefault' }),
            ),
            email: pipe(string(), column({ type: 'text' })),
            nickname: pipe(string(), column({ type: 'text' })),
          }),
          title('people'),
          table({
            name: 'people',
            primaryKey: 'id',
            schema: schemaName,
            indexes: [
              {
                name: `people_email_${suffix}`,
                columns: ['email'],
              },
            ],
          }),
        ),
      )

      const setup = createDatabase(postgresql({ url: url as string }))
      const db1 = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [Base],
      })
      const db2 = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [Expanded],
      })

      try {
        await db1.migrate().execute()
        const plan = await db2.migrate().dryRun()
        expect(
          plan.steps.some(
            (s) => s.kind === 'add_column' && s.column === 'nickname',
          ),
        ).toBe(true)
        expect(
          plan.steps.some(
            (s) =>
              s.kind === 'create_index' && s.index === `people_email_${suffix}`,
          ),
        ).toBe(true)

        await db2.migrate().execute()
        const after = await db2.migrate().dryRun()
        expect(after.steps).toEqual([])

        const cols = (await setup
          .prepare(
            `
          select column_name
          from information_schema.columns
          where table_schema = $1 and table_name = 'people'
        `,
          )
          .bind(schemaName)
          .all()) as Array<{ column_name: string }>
        expect(cols.map((c) => c.column_name)).toEqual(
          expect.arrayContaining(['id', 'email', 'nickname']),
        )
      } finally {
        await db1.close()
        await db2.close()
        try {
          await setup.exec(`drop schema if exists "${schemaName}" cascade`)
        } finally {
          await setup.dispose()
        }
      }
    },
    60_000,
  )
})
