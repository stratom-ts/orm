import { date, number, pipe, string } from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import type { InferSelect, Prettify } from '@/index'
import { column, createDatabase, defineTable, eq, postgresDialect } from '@/index'

import { createMockPostgresConnector as createMockConnector } from '../helpers/nativePostgresClient'

const Users = defineTable(
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text' })),
    createdAt: pipe(date(), column({ type: 'timestamptz' })),
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

const AppUsers = defineTable(
  'users',
  {
    id: pipe(number(), column({ type: 'integer' })),
    email: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', schema: 'app' },
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

    expect(compiled.sql).toMatch(/"public\.posts"\."userId"/)
    expect(compiled.sql).toMatch(/"public\.users"\."id"/)
    expect(compiled.sql).toMatch(/"public\.posts"\.\*/)
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
    expect(left.sql).toMatch(/"public\.posts"\."title"/)
    expect(left.sql).toMatch(/"public\.users"\."email"/)

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
    expect(compiled.sql).toMatch(/"public\.users"\."email"/)

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

  it('should map joined-table parameters and results with the owning schema', async () => {
    const when = new Date('2026-01-02T03:04:05.000Z')
    const connector = createMockConnector({
      rowsBySql: () => [{ title: 'Hello', createdAt: when.toISOString() }],
    })
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    const query = db
      .from(Posts)
      .innerJoin(Users, eq(Posts.userId, Users.id))
      .select([Posts.title, Users.createdAt])
      .where(Users.createdAt, 'eq', when)

    expect(query.compile().params).toEqual([when.toISOString()])
    const rows = await query.execute()
    expect(rows[0]!.createdAt).toBeInstanceOf(Date)
    expect(rows[0]!.createdAt.toISOString()).toBe(when.toISOString())

    await db.close()
  })

  it('should qualify same-named tables by schema', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, AppUsers] })

    const compiled = db
      .from(Users)
      .innerJoin(AppUsers, eq(Users.id, AppUsers.id))
      .select((builder) => [
        builder.as(builder.ref(Users.id), 'publicId'),
        builder.as(builder.ref(AppUsers.id), 'appId'),
      ])
      .compile()

    expect(compiled.sql).toContain('"public"."users" as "public.users"')
    expect(compiled.sql).toContain('"app"."users" as "app.users"')
    expect(compiled.sql).toContain('"public.users"."id" = "app.users"."id"')

    await db.close()
  })

  it('should resolve schema-less AST references against a custom-schema query', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [AppUsers] })

    const compiled = db
      .from(AppUsers)
      .select(() => [{ kind: 'column', table: 'users', column: 'email' } as const])
      .where({
        kind: 'cmp',
        table: 'users',
        column: 'email',
        op: 'eq',
        value: 'a@b.com',
      })
      .compile()

    expect(compiled.sql).toContain('select "app.users"."email"')
    expect(compiled.sql).toContain('where "app.users"."email" = $1')
    expect(compiled.params).toEqual(['a@b.com'])

    await db.close()
  })

  it('should generate distinct aliases when schema-table concatenations collide', () => {
    const compiled = postgresDialect.compile({
      kind: 'select',
      table: 'c',
      schema: 'a.b',
      selection: [
        {
          kind: 'column',
          table: 'c',
          schema: 'a.b',
          column: 'id',
          alias: 'schemaId',
        },
        {
          kind: 'column',
          table: 'b.c',
          schema: 'a',
          column: 'id',
          alias: 'tableId',
        },
      ],
      joins: [
        {
          type: 'inner',
          table: 'b.c',
          schema: 'a',
          on: {
            kind: 'cmp',
            table: 'c',
            schema: 'a.b',
            column: 'id',
            op: 'eq',
            right: { table: 'b.c', schema: 'a', column: 'id' },
          },
        },
      ],
    })

    expect(compiled.sql).toContain('"a.b"."c" as "__stratom_0"')
    expect(compiled.sql).toContain('"a"."b.c" as "__stratom_1"')
    expect(compiled.sql).toContain('"__stratom_0"."id" = "__stratom_1"."id"')
  })

  it('should keep aliases within the PostgreSQL identifier length limit', async () => {
    const longSchema = `schema_${'x'.repeat(64)}`
    const LongSchemaTable = defineTable(
      'events',
      { id: pipe(number(), column({ type: 'integer' })) },
      { primaryKey: 'id', schema: longSchema },
    )
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [LongSchemaTable] })

    const compiled = db.from(LongSchemaTable).select([LongSchemaTable.id]).compile()

    expect(compiled.sql).toContain(`"${longSchema}"."events" as "__stratom_0"`)
    expect(compiled.sql).toContain('select "__stratom_0"."id"')

    await db.close()
  })

  it('should reject duplicate flat output names', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, Posts] })

    expect(() =>
      db.from(Posts).innerJoin(Users, eq(Posts.userId, Users.id)).compile(),
    ).toThrow(/output column "id" is ambiguous/)

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

  it('should distinguish outer-join nullability for same-named cross-schema tables', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users, AppUsers] })

    const publicQuery = db
      .from(Users)
      .leftJoin(AppUsers, eq(Users.id, AppUsers.id))
      .select([Users.email])
    type PublicRow = Awaited<ReturnType<typeof publicQuery.execute>>[number]
    expectTypeOf<PublicRow>().toEqualTypeOf<{ email: string }>()

    const appQuery = db
      .from(Users)
      .leftJoin(AppUsers, eq(Users.id, AppUsers.id))
      .select([AppUsers.email])
    type AppRow = Awaited<ReturnType<typeof appQuery.execute>>[number]
    expectTypeOf<AppRow>().toEqualTypeOf<{ email: string | null }>()
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
          createdAt: Date | null
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
          createdAt: Date | null
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
