import { createDb, eq } from '@/index'
import { defineTable } from '@/defineTable'
import { column, table } from '@/schemas'
import type { Connector, Statement } from 'db0'
import { number, object, pipe, string, title } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  onPrepare?: (sql: string, params?: unknown[]) => Statement
  rowsBySql?: (sql: string) => unknown[]
}): Connector & {
  disposed: boolean
  prepared: string[]
  binds: unknown[][]
} {
  const prepared: string[] = []
  const binds: unknown[][] = []
  const connector = {
    name: 'mock',
    dialect: 'postgresql' as const,
    disposed: false,
    prepared,
    binds,
    getInstance: () => ({}),
    exec: async () => ({}),
    prepare: (sql: string) => {
      prepared.push(sql)
      const base =
        options?.onPrepare?.(sql) ??
        createMockStatement(options?.rowsBySql?.(sql) ?? [])
      return {
        bind(...params: unknown[]) {
          binds.push(params)
          return base.bind(...(params as never[]))
        },
        all: () => base.all(),
        run: () => base.run(),
        get: () => base.get(),
      }
    },
    dispose: async () => {
      connector.disposed = true
    },
  }
  return connector
}

const Users = defineTable(
  pipe(
    object({
      id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
      email: pipe(string(), column({ type: 'text' })),
    }),
    title('users'),
    table({ name: 'users', primaryKey: 'id', schema: 'public' }),
  ),
)

const Posts = defineTable(
  pipe(
    object({
      id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
      title: pipe(string(), column({ type: 'text' })),
      userId: pipe(number(), column({ type: 'integer' })),
      score: pipe(number(), column({ type: 'integer', default: 0 })),
    }),
    title('posts'),
    table({ name: 'posts', primaryKey: 'id', schema: 'public' }),
  ),
)

describe('joins compile', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('compiles innerJoin with column-ref on and selectAll(side)', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users, Posts] })
    const compiled = db
      .from(Posts)
      .innerJoin(Users, eq(Posts.userId, Users.id))
      .selectAll(Posts)
      .select([Users.email])
      .compile()
    const sql = compiled.sql.toLowerCase()
    expect(sql).toContain('inner join')
    expect(compiled.sql).toContain('"posts"')
    expect(compiled.sql).toContain('"users"')
    expect(sql).toMatch(/on/)
    expect(compiled.sql).toMatch(/"posts"\."userId"/)
    expect(compiled.sql).toMatch(/"users"\."id"/)
    expect(compiled.sql).toMatch(/"posts"\.\*/)
    expect(compiled.sql).toContain('"email"')
    expect(compiled.params).toEqual([])
    await db.close()
  })

  it('compiles leftJoin and rightJoin with on callback', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users, Posts] })
    const left = db
      .from(Posts)
      .leftJoin(Users, (b) => b.eq(Posts.userId, Users.id))
      .select([Posts.title, Users.email])
      .compile()
    expect(left.sql.toLowerCase()).toContain('left join')
    expect(left.sql).toMatch(/"posts"\."title"/)
    expect(left.sql).toMatch(/"users"\."email"/)

    const right = db
      .from(Posts)
      .rightJoin(Users, eq(Posts.userId, Users.id))
      .select([Posts.id, Users.email])
      .compile()
    expect(right.sql.toLowerCase()).toContain('right join')
    await db.close()
  })

  it('where/order/limit work with joins', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users, Posts] })
    const compiled = db
      .from(Posts)
      .innerJoin(Users, eq(Posts.userId, Users.id))
      .select([Posts.title, Users.email, Posts.score])
      .where(Posts.score, 'gt', 10)
      .orderBy(Users.email, 'asc')
      .limit(5)
      .compile()
    const sql = compiled.sql.toLowerCase()
    expect(sql).toContain('inner join')
    expect(sql).toContain('where')
    expect(sql).toContain('order by')
    expect(sql).toContain('limit')
    expect(compiled.params).toEqual([10, 5])
    expect(compiled.sql).toMatch(/"users"\."email"/)
    await db.close()
  })

  it('execute returns flat mock rows after join', async () => {
    const rows = [{ title: 'Hello', email: 'a@b.com' }]
    const connector = createMockConnector({ rowsBySql: () => rows })
    const db = createDb({ connector, schemas: [Users, Posts] })
    await expect(
      db
        .from(Posts)
        .innerJoin(Users, eq(Posts.userId, Users.id))
        .select([Posts.title, Users.email])
        .execute(),
    ).resolves.toEqual(rows)
    await db.close()
  })
})

describe('joins integration (Postgres)', () => {
  const url = process.env.DATABASE_URL

  it.skipIf(!url)(
    'inner/left join across related tables',
    async () => {
      const { createDatabase } = await import('db0')
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const setup = createDatabase(postgresql({ url: url as string }))
      const db = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [Users, Posts],
      })
      try {
        await setup.exec(`drop table if exists "public"."posts"`)
        await setup.exec(`drop table if exists "public"."users"`)
        await setup.exec(`
          create table "public"."users" (
            "id" integer generated by default as identity primary key,
            "email" text not null
          )
        `)
        await setup.exec(`
          create table "public"."posts" (
            "id" integer generated by default as identity primary key,
            "title" text not null,
            "userId" integer not null references "public"."users"("id"),
            "score" integer not null default 0
          )
        `)

        const users = await db
          .from(Users)
          .insert([{ email: 'alice@test.com' }, { email: 'bob@test.com' }])
          .returningAll()
          .execute()
        const alice = users[0]!
        const bob = users[1]!

        await db
          .from(Posts)
          .insert([
            { title: 'A1', userId: alice.id, score: 5 },
            { title: 'A2', userId: alice.id, score: 15 },
            { title: 'B1', userId: bob.id, score: 20 },
          ])
          .execute()

        const inner = (await db
          .from(Posts)
          .innerJoin(Users, eq(Posts.userId, Users.id))
          .select([Posts.title, Users.email, Posts.score])
          .where(Posts.score, 'gt', 10)
          .orderBy(Posts.score, 'desc')
          .limit(2)
          .execute()) as {
          title: string
          email: string
          score: number
        }[]
        expect(inner).toHaveLength(2)
        expect(inner[0]?.score).toBe(20)
        expect(inner[0]?.email).toBe('bob@test.com')

        // left join: post without matching filter still projects post side
        const left = await db
          .from(Posts)
          .leftJoin(Users, eq(Posts.userId, Users.id))
          .selectAll(Posts)
          .where(Users.email, 'eq', 'alice@test.com')
          .orderBy(Posts.title, 'asc')
          .execute()
        expect(left.length).toBe(2)
        expect(left.map((r) => r.title).sort()).toEqual(['A1', 'A2'])
      } finally {
        await db.close()
        await setup.dispose()
      }
    },
    30_000,
  )
})
