import { number } from 'valibot'
import { describe, expect, it } from 'vitest'

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
  it.each([after, before])('rejects invalid cursor shape and descriptors', (helper) => {
    expect(() => helper([], [])).toThrow(QueryError)
    expect(() => helper(order, [])).toThrow(QueryError)
    expect(() => helper(order, [1, 2])).toThrow(QueryError)
    expect(() => helper(order, [undefined])).toThrow(QueryError)

    for (const term of [
      { column: '', direction: 'asc', nulls: 'last' },
      { column: Entries.id, direction: 'up', nulls: 'last' },
      { column: Entries.id, direction: 'asc', nulls: 'middle' },
      null,
    ]) {
      expect(() => helper([term] as unknown as OrderTerm[], [1])).toThrow(QueryError)
    }
  })
})

it('compiles explicit null placement without changing omitted defaults', async () => {
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
  'compiles null placement in each dialect',
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
