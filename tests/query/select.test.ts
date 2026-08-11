import { boolean, date, nullable, number, optional, pipe, string } from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  QueryError,
  and,
  column,
  count,
  countAll,
  createDatabase,
  dateTrunc,
  defineTable,
  eq,
  gt,
  gte,
  length,
  lower,
  lt,
  lte,
  max,
  min,
  neq,
  not,
  now,
  or,
  sum,
  upper,
} from '@/index'

import { createMockPostgresConnector as createMockConnector } from '../helpers/nativePostgresClient'

const Users = defineTable(
  'users',
  {
    id: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'byDefault' },
      }),
    ),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    displayName: optional(
      pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: '' },
        }),
      ),
    ),
    active: pipe(
      boolean(),
      column({
        physicalType: { postgresql: 'boolean' },
        databaseDefault: { kind: 'literal', value: true },
      }),
    ),
    score: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        databaseDefault: { kind: 'literal', value: 0 },
      }),
    ),
    deletedAt: nullable(pipe(string(), column({ physicalType: { postgresql: 'text' } }))),
    createdAt: pipe(date(), column({ physicalType: { postgresql: 'timestamptz' } })),
  },
  { primaryKey: 'id', schema: 'public' },
)

describe('select result types', () => {
  it('should narrow execute row type to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.from(Users).select([Users.id, Users.email])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
    expectTypeOf<Row>().not.toHaveProperty('score')
    expectTypeOf<Row>().not.toHaveProperty('displayName')
    expectTypeOf<Row>().not.toHaveProperty('active')
  })

  it('should keep selected optional columns required on the row (not Partial)', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.from(Users).select([Users.displayName])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ displayName: string }>()
    expectTypeOf<Row>().not.toEqualTypeOf<Partial<{ displayName: string }>>()
  })

  it('should narrow string column-name selects the same way as column refs', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.from(Users).select(['id', 'email'] as const)

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
  })

  it('should type expression-callback selects as Record<string, unknown>', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const query = db.from(Users).select((b) => [b.as(countAll(), 'total')])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<Record<string, unknown>>()
  })
})

describe('select compile', () => {
  it('should compile selectAll and column list', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const all = db.from(Users).selectAll().compile()
    expect(all.sql.toLowerCase()).toMatch(/select \* from/)
    expect(all.sql).toContain('"public"')
    expect(all.sql).toContain('"users"')

    const cols = db.from(Users).select([Users.id, Users.email]).compile()
    expect(cols.sql.toLowerCase()).toContain('select')
    expect(cols.sql).toContain('"id"')
    expect(cols.sql).toContain('"email"')
    expect(cols.sql.toLowerCase()).not.toContain('displayname')

    await db.close()
  })

  it('should reject empty select projections', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    expect(() => db.from(Users).select([])).toThrow(/requires at least one item/)
    expect(() => db.from(Users).select(() => [])).toThrow(/requires at least one item/)

    await db.close()
  })

  it('should compile where with column ref and and/or/not', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const simple = db.from(Users).where(Users.email, 'eq', 'a@b.com').compile()
    expect(simple.sql.toLowerCase()).toContain('where')
    expect(simple.params).toEqual(['a@b.com'])

    const composed = db
      .from(Users)
      .where(
        and(eq(Users.active, true), or(gt(Users.score, 10), not(eq(Users.email, 'x')))),
      )
      .compile()
    expect(composed.sql.toLowerCase()).toMatch(/and/)
    expect(composed.sql.toLowerCase()).toMatch(/or/)
    expect(composed.sql.toLowerCase()).toMatch(/not/)
    expect(composed.params).toEqual([true, 10, 'x'])

    await db.close()
  })

  it('should compile null equality without bound parameters', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const equal = db.from(Users).where(Users.deletedAt, 'eq', null).compile()
    expect(equal.sql).toContain('"public.users"."deletedAt" is null')
    expect(equal.params).toEqual([])

    const notEqual = db.from(Users).where(Users.deletedAt, 'neq', null).compile()
    expect(notEqual.sql).toContain('"public.users"."deletedAt" is not null')
    expect(notEqual.params).toEqual([])

    expect(() => db.from(Users).where(Users.deletedAt, 'gt', null).compile()).toThrow(
      /does not accept null/,
    )

    await db.close()
  })

  it('should compile multi-column orderBy and limit/offset', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .from(Users)
      .orderBy(Users.email, 'asc')
      .orderBy(Users.id, 'desc')
      .limit(10)
      .offset(20)
      .compile()
    expect(compiled.sql.toLowerCase()).toContain('order by')
    expect(compiled.sql.toLowerCase()).toContain('asc')
    expect(compiled.sql.toLowerCase()).toContain('desc')
    expect(compiled.sql.toLowerCase()).toContain('limit')
    expect(compiled.sql.toLowerCase()).toContain('offset')
    expect(compiled.params).toEqual([10, 20])

    await db.close()
  })

  it('should compile aggregates and groupBy/having', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .from(Users)
      .select((b) => [
        Users.active,
        b.as(countAll(), 'total'),
        b.as(sum(Users.score), 'scoreSum'),
        b.as(min(Users.score), 'scoreMin'),
        b.as(max(Users.score), 'scoreMax'),
        b.as(count(Users.id), 'idCount'),
      ])
      .groupBy(Users.active)
      .having(() => gt(Users.score, 0))
      .compile()
    expect(compiled.sql.toLowerCase()).toContain('count(*)')
    expect(compiled.sql.toLowerCase()).toContain('sum(')
    expect(compiled.sql.toLowerCase()).toContain('min(')
    expect(compiled.sql.toLowerCase()).toContain('max(')
    expect(compiled.sql.toLowerCase()).toContain('group by')
    expect(compiled.sql.toLowerCase()).toContain('having')
    expect(compiled.sql).toContain('"total"')

    await db.close()
  })

  it('should compile callback select with string helpers', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db
      .from(Users)
      .select((b) => [b.as(upper(Users.email), 'emailUpper')])
      .compile()
    expect(compiled.sql.toLowerCase()).toContain('upper(')
    expect(compiled.sql).toContain('"emailUpper"')

    await db.close()
  })

  it('should compile public expression helpers and chained clauses', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    try {
      const compiled = db
        .from(Users)
        .select((b) => [
          b.as(lower(Users.email), 'normalizedEmail'),
          b.as(length('email'), 'emailLength'),
          b.as(now(), 'queriedAt'),
          b.as(dateTrunc('day', Users.createdAt), 'day'),
        ])
        .where((b) =>
          b.and(
            neq('email', 'deleted@example.com'),
            gte(Users.score, 10),
            lt(Users.score, 100),
            lte(Users.id, 99),
          ),
        )
        .groupBy([Users.email, Users.score, Users.createdAt])
        .having((b) => b.gte(Users.score, 1))
        .orderBy(Users.email)
        .compile()

      expect(compiled.sql.toLowerCase()).toMatch(/lower\(/)
      expect(compiled.sql.toLowerCase()).toMatch(/length\(/)
      expect(compiled.sql.toLowerCase()).toMatch(/now\(\)/)
      expect(compiled.sql).toContain('date_trunc($1, "public.users"."createdAt")')
      expect(compiled.sql.toLowerCase()).toMatch(/<>|!=/)
      expect(compiled.sql).toContain('>=')
      expect(compiled.sql).toMatch(/"public\.users"\."score"\s*<\s*\$\d+/)
      expect(compiled.sql).toContain('<=')
      expect(compiled.sql).toContain(
        'group by "public.users"."email", "public.users"."score", "public.users"."createdAt"',
      )
      expect(compiled.sql).toContain('order by "public.users"."email" asc')
      expect(compiled.params).toEqual(['day', 'deleted@example.com', 10, 100, 99, 1])

      expect(and(eq(Users.id, 1))).toEqual(eq(Users.id, 1))
      expect(or(eq(Users.id, 1))).toEqual(eq(Users.id, 1))
      expect(() => and()).toThrow(/at least one predicate/)
      expect(() => or()).toThrow(/at least one predicate/)
    } finally {
      await db.close()
    }
  })
})

describe('select execute terminals', () => {
  it('should return mock rows on execute / executeTakeFirst', async () => {
    const rows = [{ id: 1, email: 'a@b.com' }]
    const connector = createMockConnector({ rowsBySql: () => rows })

    const db = createDatabase({ connector, schemas: [Users] })

    await expect(
      db.from(Users).select([Users.id, Users.email]).where({ id: 1 }).execute(),
    ).resolves.toEqual(rows)

    await expect(
      db.from(Users).where(Users.id, 'eq', 1).executeTakeFirst(),
    ).resolves.toEqual(rows[0])

    await db.close()
  })

  it('should allow executeTakeFirst and executeTakeFirstOrThrow on full-row select', async () => {
    const rows = [{ id: 1, email: 'a@b.com', displayName: 'Ada', active: true }]
    const connector = createMockConnector({ rowsBySql: () => rows })

    const db = createDatabase({ connector, schemas: [Users] })
    await expect(db.from(Users).executeTakeFirst()).resolves.toEqual(rows[0])
    await expect(db.from(Users).executeTakeFirstOrThrow()).resolves.toEqual(rows[0])

    await db.close()
  })

  it('should throw QueryError on executeTakeFirstOrThrow when empty', async () => {
    const connector = createMockConnector({ rowsBySql: () => [] })
    const db = createDatabase({ connector, schemas: [Users] })

    await expect(db.from(Users).executeTakeFirstOrThrow()).rejects.toBeInstanceOf(
      QueryError,
    )

    await db.close()
  })
})
