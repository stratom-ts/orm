import { defineTable } from '@/defineTable'
import {
  and,
  count,
  countAll,
  createDb,
  eq,
  gt,
  max,
  min,
  not,
  or,
  sum,
  upper,
} from '@/index'
import { column } from '@/schemas'
import { QueryError } from '@/utils/error'
import type { Connector, Statement } from 'db0'
import { boolean, number, optional, pipe, string } from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

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
  'users',
  {
    id: pipe(number(), column({ type: 'integer', generated: 'byDefault' })),
    email: pipe(string(), column({ type: 'text' })),
    displayName: optional(pipe(string(), column({ type: 'text' }))),
    active: pipe(boolean(), column({ type: 'boolean', default: true })),
    score: pipe(number(), column({ type: 'integer', default: 0 })),
  },
  { primaryKey: 'id', schema: 'public' },
)

describe('select result types', () => {
  it('should narrow execute row type to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    const query = db.from(Users).select([Users.id, Users.email])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
    expectTypeOf<Row>().not.toHaveProperty('score')
    expectTypeOf<Row>().not.toHaveProperty('displayName')
    expectTypeOf<Row>().not.toHaveProperty('active')
  })

  it('should keep selected optional columns required on the row (not Partial)', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    const query = db.from(Users).select([Users.displayName])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ displayName: string }>()
    expectTypeOf<Row>().not.toEqualTypeOf<Partial<{ displayName: string }>>()
  })

  it('should narrow string column-name selects the same way as column refs', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    const query = db.from(Users).select(['id', 'email'] as const)

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
  })

  it('should type expression-callback selects as Record<string, unknown>', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    const query = db.from(Users).select((b) => [b.as(countAll(), 'total')])

    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<Record<string, unknown>>()
  })
})

describe('select compile', () => {
  it('should compile selectAll and column list', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

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

  it('should compile where with column ref and and/or/not', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    const simple = db.from(Users).where(Users.email, 'eq', 'a@b.com').compile()
    expect(simple.sql.toLowerCase()).toContain('where')
    expect(simple.params).toEqual(['a@b.com'])

    const composed = db
      .from(Users)
      .where(
        and(
          eq(Users.active, true),
          or(gt(Users.score, 10), not(eq(Users.email, 'x'))),
        ),
      )
      .compile()
    expect(composed.sql.toLowerCase()).toMatch(/and/)
    expect(composed.sql.toLowerCase()).toMatch(/or/)
    expect(composed.sql.toLowerCase()).toMatch(/not/)
    expect(composed.params).toEqual([true, 10, 'x'])

    await db.close()
  })

  it('should compile multi-column orderBy and limit/offset', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

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
    const db = createDb({ connector, schemas: [Users] })

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
    const db = createDb({ connector, schemas: [Users] })

    const compiled = db
      .from(Users)
      .select((b) => [b.as(upper(Users.email), 'emailUpper')])
      .compile()
    expect(compiled.sql.toLowerCase()).toContain('upper(')
    expect(compiled.sql).toContain('"emailUpper"')

    await db.close()
  })
})

describe('select execute terminals', () => {
  it('should return mock rows on execute / executeTakeFirst', async () => {
    const rows = [{ id: 1, email: 'a@b.com' }]
    const connector = createMockConnector({ rowsBySql: () => rows })

    const db = createDb({ connector, schemas: [Users] })

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

    const db = createDb({ connector, schemas: [Users] })
    await expect(db.from(Users).executeTakeFirst()).resolves.toEqual(rows[0])
    await expect(db.from(Users).executeTakeFirstOrThrow()).resolves.toEqual(
      rows[0],
    )

    await db.close()
  })

  it('should throw QueryError on executeTakeFirstOrThrow when empty', async () => {
    const connector = createMockConnector({ rowsBySql: () => [] })
    const db = createDb({ connector, schemas: [Users] })

    await expect(
      db.from(Users).executeTakeFirstOrThrow(),
    ).rejects.toBeInstanceOf(QueryError)

    await db.close()
  })
})
