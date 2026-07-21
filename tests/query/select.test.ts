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
import { defineTable } from '@/defineTable'
import { column } from '@/schemas'
import type { Connector, Statement } from 'db0'
import { boolean, number, optional, pipe, string } from 'valibot'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

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
  it('narrows execute row type to selected columns only', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    const query = db.from(Users).select([Users.id, Users.email])
    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ id: number; email: string }>()
    expectTypeOf<Row>().not.toHaveProperty('score')
    expectTypeOf<Row>().not.toHaveProperty('displayName')
    expectTypeOf<Row>().not.toHaveProperty('active')
  })

  it('keeps selected keys required (not Partial)', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    const query = db.from(Users).select([Users.displayName])
    type Row = Awaited<ReturnType<typeof query.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ displayName: string }>()
  })
})

describe('select compile', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('compiles selectAll and column list', async () => {
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

  it('compiles where with column ref and and/or/not', async () => {
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

  it('compiles multi-column orderBy and limit/offset', async () => {
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

  it('compiles aggregates and groupBy/having', async () => {
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

  it('compiles callback select with string helpers', async () => {
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

  it('execute terminals work with mock rows', async () => {
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
})

describe('select integration (Postgres)', () => {
  const url = process.env.DATABASE_URL

  it.skipIf(!url)(
    'where/order/limit/aggregates against real Postgres',
    async () => {
      const { createDatabase } = await import('db0')
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const setup = createDatabase(postgresql({ url: url as string }))
      const db = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [Users],
      })
      try {
        await setup.exec(`drop table if exists "public"."users"`)
        await setup.exec(`
          create table "public"."users" (
            "id" integer generated by default as identity primary key,
            "email" text not null,
            "displayName" text,
            "active" boolean not null default true,
            "score" integer not null default 0
          )
        `)

        await db
          .insert(Users)
          .values([
            { email: 'a@test.com', displayName: 'A', score: 5 },
            { email: 'b@test.com', displayName: 'B', score: 15, active: true },
            { email: 'c@test.com', displayName: 'C', score: 25, active: false },
          ])
          .execute()

        const filtered = await db
          .from(Users)
          .select([Users.email, Users.score])
          .where(Users.score, 'gt', 10)
          .orderBy(Users.score, 'desc')
          .limit(2)
          .execute()
        expect(filtered).toHaveLength(2)
        expect(filtered[0]?.score).toBe(25)

        const agg = await db
          .from(Users)
          .select((b) => [
            Users.active,
            b.as(countAll(), 'total'),
            b.as(sum(Users.score), 'scoreSum'),
          ])
          .groupBy(Users.active)
          .orderBy(Users.active, 'asc')
          .execute()
        expect(agg.length).toBeGreaterThanOrEqual(1)
        const totals = agg.map((r) => Number((r as { total: unknown }).total))
        expect(totals.reduce((a, b) => a + b, 0)).toBe(3)
      } finally {
        await db.close()
        await setup.dispose()
      }
    },
    30_000,
  )
})
