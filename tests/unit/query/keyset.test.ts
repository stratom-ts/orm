import { number } from 'valibot'
import { describe, expect, expectTypeOf, it } from 'vitest'

import { compilePostgresQuery } from '@/dialects/postgres/compile'
import { compileSqliteQuery } from '@/dialects/sqlite/compile'
import type { OrderTerm } from '@/index'
import { QueryError, after, before, createDatabase, defineTable } from '@/index'

import { createMockPostgresConnector } from '../dialects/postgresNativeClientFixtures'

const Entries = defineTable(
  'keyset.entries',
  { id: number(), score: number() },
  { primaryKey: 'id' },
)

const order = [{ column: Entries.id, direction: 'asc', nulls: 'last' }] as const

describe('keyset input validation', () => {
  it.each([after, before])(
    'should reject invalid cursor shape and descriptors',
    (helper) => {
      expect(() => helper([], [])).toThrow(QueryError)
      expect(() => helper(order, [])).toThrow(QueryError)
      expect(() => helper(order, [1, 2])).toThrow(QueryError)
      expect(() => helper(order, [undefined])).toThrow(QueryError)

      for (const term of [
        { column: '', direction: 'asc', nulls: 'last' },
        { column: Entries.id, direction: 'up', nulls: 'last' },
        { column: Entries.id, direction: 'asc', nulls: 'middle' },
        null,
      ])
        expect(() => helper([term] as unknown as OrderTerm[], [1])).toThrow(QueryError)
    },
  )
})

it('should compile explicit null placement without changing omitted defaults', async () => {
  const db = createDatabase({
    connector: createMockPostgresConnector(),
    schemas: [Entries],
  })

  try {
    const original = db.from(Entries).orderBy(Entries.id).compile().sql
    expect(original).not.toContain('nulls')

    const query = db
      .from(Entries)
      .orderBy(Entries.score, 'desc', 'first')
      .orderBy(Entries.id, 'asc', 'last')
      .where(after(order, [2]))
      .compile()

    expect(query.sql).toMatch(
      /order by .*"score" desc nulls first, .*"id" asc nulls last$/,
    )

    expect(query.params).toEqual([2])
  } finally {
    await db.close()
  }
})

it.each([compilePostgresQuery, compileSqliteQuery])(
  'should compile null placement in each dialect',
  (compile) => {
    const query = compile({
      kind: 'select',
      relation: { relation: 'entries' },
      selection: [{ kind: 'all' }],
      orderBy: [
        { column: 'score', direction: 'desc', nulls: 'first' },
        { column: 'id', direction: 'asc', nulls: 'last' },
      ],
    })

    expect(query.sql).toMatch(
      /order by .*"score" desc nulls first, .*"id" asc nulls last$/,
    )
  },
)

it('should add root cursor boundaries without changing the original builder', async () => {
  const db = createDatabase({
    connector: createMockPostgresConnector(),
    schemas: [Entries],
  })

  try {
    const base = db.from(Entries)
    const original = base.selectAll().compile()
    const following = base.after(order, [2]).compile()
    const preceding = base.before(order, [5]).compile()
    expect(following).toEqual(base.where(after(order, [2])).compile())
    expect(preceding).toEqual(base.where(before(order, [5])).compile())
    expect(base.selectAll().compile()).toEqual(original)
    expect(original.params).toEqual([])
    expect(following.params).toEqual([2])
    expect(preceding.params).toEqual([5])
    expect(following.sql).not.toContain('order by')
  } finally {
    await db.close()
  }
})

it('should combine boundaries with filters while retaining selected output and immutable branches', async () => {
  const db = createDatabase({
    connector: createMockPostgresConnector(),
    schemas: [Entries],
  })

  try {
    const base = db.from(Entries).select([Entries.id]).where(Entries.score, 'gt', 10)
    const original = base.compile()
    const bounded = base.after(order, [2]).before(order, [5])
    type Row = Awaited<ReturnType<typeof bounded.execute>>[number]
    expectTypeOf<Row>().toEqualTypeOf<{ id: number }>()

    expect(bounded.compile()).toEqual(
      base
        .where(after(order, [2]))
        .where(before(order, [5]))
        .compile(),
    )

    expect(bounded.compile().params).toEqual([10, 2, 5])
    expect(base.compile()).toEqual(original)
    expect(original.params).toEqual([10])
  } finally {
    await db.close()
  }
})

it('should validate cursor boundaries on root and selected builders', async () => {
  const db = createDatabase({
    connector: createMockPostgresConnector(),
    schemas: [Entries],
  })

  try {
    expect(() => db.from(Entries).after(order, [])).toThrow(QueryError)
    expect(() => db.from(Entries).before([], [])).toThrow(QueryError)

    expect(() => db.from(Entries).select([Entries.id]).after(order, [undefined])).toThrow(
      QueryError,
    )

    expect(() => db.from(Entries).where(Entries.id, 'gt', 1).before(order, [])).toThrow(
      QueryError,
    )
  } finally {
    await db.close()
  }
})
