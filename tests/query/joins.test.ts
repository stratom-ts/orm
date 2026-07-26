import type { Connector, Statement } from 'db0'
import { number, pipe, string } from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { InferSelect, Prettify } from '@/index'
import { column, createDatabase, defineTable, eq } from '@/index'

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
        options?.onPrepare?.(sql) ?? createMockStatement(options?.rowsBySql?.(sql) ?? [])
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
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', schema: 'public' },
)

const Posts = defineTable(
  'posts',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    title: pipe(string(), column({ type: 'text' })),
    userId: pipe(number(), column({ type: 'integer' })),
    score: pipe(number(), column({ type: 'integer', default: 0 })),
  },
  { primaryKey: 'id', schema: 'public' },
)

describe('joins compile', () => {
  it('should compile innerJoin with column-ref on and selectAll(side)', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

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

  it('should compile leftJoin and rightJoin with on callback', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

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

  it('should compile joins with where/order/limit', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })
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

  it('should return flat mock rows after join on execute', async () => {
    const rows = [{ title: 'Hello', email: 'a@b.com' }]
    const connector = createMockConnector({ rowsBySql: () => rows })
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    await expect(
      db
        .from(Posts)
        .innerJoin(Users, eq(Posts.userId, Users.id))
        .select([Posts.title, Users.email])
        .execute(),
    ).resolves.toEqual(rows)

    await db.close()
  })

  it('should type cross-table selected columns from the ColumnRef', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    const query = db
      .from(Posts)
      .innerJoin(Users, eq(Posts.userId, Users.id))
      .select([Posts.title, Users.email])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ title: string; email: string }>()
  })

  it('should widen left-joined columns with | null', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    const query = db
      .from(Posts)
      .leftJoin(Users, eq(Posts.userId, Users.id))
      .select([Posts.title, Users.email])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{
      title: string
      email: string | null
    }>()
  })

  it('should widen root columns with | null after rightJoin', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    const query = db
      .from(Posts)
      .rightJoin(Users, eq(Posts.userId, Users.id))
      .select([Posts.title, Users.email])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{
      title: string | null
      email: string
    }>()
  })

  it('should merge chained selectAll(side) with a later column select', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    const query = db
      .from(Posts)
      .innerJoin(Users, eq(Posts.userId, Users.id))
      .selectAll(Posts)
      .select([Users.email])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<
      Prettify<InferSelect<typeof Posts> & { email: string }>
    >()
  })

  it('should nullify left-joined selectAll(side) fields', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    const query = db
      .from(Posts)
      .leftJoin(Users, eq(Posts.userId, Users.id))
      .select([Posts.title])
      .selectAll(Users)

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<
      Prettify<
        { title: string } & {
          id: number | null
          email: string | null
        }
      >
    >()
  })

  it('should merge all joined table columns for implicit select *', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })
    const inner = db.from(Posts).innerJoin(Users, eq(Posts.userId, Users.id))

    type InnerRow = Awaited<ReturnType<typeof inner.execute>>[number]
    expectTypeOf<InnerRow>().toEqualTypeOf<
      Prettify<InferSelect<typeof Posts> & InferSelect<typeof Users>>
    >()

    const left = db.from(Posts).leftJoin(Users, eq(Posts.userId, Users.id))
    type LeftRow = Awaited<ReturnType<typeof left.execute>>[number]
    expectTypeOf<LeftRow>().toEqualTypeOf<
      Prettify<
        InferSelect<typeof Posts> & {
          id: number | null
          email: string | null
        }
      >
    >()

    const right = db.from(Posts).rightJoin(Users, eq(Posts.userId, Users.id))
    type RightRow = Awaited<ReturnType<typeof right.execute>>[number]
    expectTypeOf<RightRow>().toEqualTypeOf<
      Prettify<
        {
          id: number | null
          title: string | null
          userId: number | null
          score: number | null
        } & InferSelect<typeof Users>
      >
    >()
  })
})
