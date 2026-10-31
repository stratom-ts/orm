import { boolean, date, nullable, number, pipe } from 'valibot'
import { expect } from 'vitest'

import type { Db, KeysetOrderTerm } from '@/index'
import { column, defineTable, eq, keysetAfter, keysetBefore } from '@/index'

export const Entries = defineTable(
  'keyset.entries',
  {
    id: pipe(number(), column({ name: 'entry_id' })),
    score: nullable(pipe(number(), column({ name: 'sort_score' }))),
    active: boolean(),
    createdAt: date(),
  },
  { primaryKey: 'id' },
)

const rows = [
  { id: 1, score: null, active: true, createdAt: new Date('2026-01-01T00:00:00Z') },
  { id: 2, score: 10, active: true, createdAt: new Date('2026-01-01T00:00:00Z') },
  { id: 3, score: 10, active: true, createdAt: new Date('2026-01-02T00:00:00Z') },
  { id: 4, score: 20, active: true, createdAt: new Date('2026-01-03T00:00:00Z') },
  { id: 5, score: null, active: true, createdAt: new Date('2026-01-04T00:00:00Z') },
  { id: 6, score: 10, active: false, createdAt: new Date('2026-01-05T00:00:00Z') },
]

/** Exercises exclusive cursor boundaries through mapped public queries on each dialect. */
export async function assertKeyset(db: Db): Promise<void> {
  await db.migrate().execute()
  await db.insert(Entries).values(rows).execute()

  await assertTraversal(db)
  await assertBoundaries(db)
  await assertMappedCursor(db)
}

/** Checks all direction and null partitions against independently authored row sequences. */
async function assertTraversal(db: Db): Promise<void> {
  for (const scenario of [
    { direction: 'asc', nulls: 'first', ids: [1, 5, 2, 3, 4] },
    { direction: 'asc', nulls: 'last', ids: [3, 2, 4, 5, 1] },
    { direction: 'desc', nulls: 'first', ids: [1, 5, 4, 2, 3] },
    { direction: 'desc', nulls: 'last', ids: [4, 3, 2, 5, 1] },
  ] as const) {
    // Mixed directions expose bugs hidden by a uniform tuple comparison.
    const tieDirection = scenario.nulls === 'first' ? 'asc' : 'desc'
    const order: readonly KeysetOrderTerm[] = [
      { column: Entries.score, direction: scenario.direction, nulls: scenario.nulls },
      { column: Entries.id, direction: tieDirection, nulls: 'last' },
    ]

    const expectedIds = scenario.ids
    expect(await traverse(db, order, false)).toEqual(expectedIds)
    expect(await traverse(db, order, true)).toEqual([...expectedIds].reverse())
  }
}

/** Checks single-column boundaries, including empty null partitions. */
async function assertBoundaries(db: Db): Promise<void> {
  const unique = [{ column: Entries.id, direction: 'asc', nulls: 'last' }] as const
  expect(
    (
      await db
        .from(Entries)
        .where(keysetAfter(unique, [3]))
        .orderBy(Entries.id)
        .execute()
    ).map((row) => row.id),
  ).toEqual([4, 5, 6])

  expect(
    (
      await db
        .from(Entries)
        .where(keysetBefore(unique, [3]))
        .orderBy(Entries.id)
        .execute()
    ).map((row) => row.id),
  ).toEqual([1, 2])

  const nullOrder = [{ column: Entries.score, direction: 'asc', nulls: 'last' }] as const
  expect(
    await db
      .from(Entries)
      .where(keysetAfter(nullOrder, [null]))
      .execute(),
  ).toEqual([])

  expect(
    await db
      .from(Entries)
      .where(keysetBefore([{ ...nullOrder[0], nulls: 'first' }], [null]))
      .execute(),
  ).toEqual([])
}

/** Checks application Date and boolean cursor values through the ordinary mapper. */
async function assertMappedCursor(db: Db): Promise<void> {
  const mapped = [
    { column: Entries.active, direction: 'asc', nulls: 'last' },
    { column: Entries.createdAt, direction: 'asc', nulls: 'last' },
    { column: Entries.id, direction: 'asc', nulls: 'last' },
  ] as const

  expect(
    (
      await db
        .from(Entries)
        .where(keysetAfter(mapped, [true, rows[2]!.createdAt, 3]))
        .orderBy(Entries.active, 'asc', 'last')
        .orderBy(Entries.createdAt, 'asc', 'last')
        .orderBy(Entries.id, 'asc', 'last')
        .execute()
    ).map((row) => row.id),
  ).toEqual([4, 5])
}

/** Fetches bounded pages in either direction, retaining the original cursor order. */
async function traverse(
  db: Db,
  order: readonly KeysetOrderTerm[],
  backward: boolean,
): Promise<number[]> {
  const ids: number[] = []
  let cursor: readonly unknown[] | undefined

  for (let pageIndex = 0; pageIndex < rows.length; pageIndex++) {
    let query = db.from(Entries).where(eq(Entries.active, true)).limit(2)

    for (const term of order) {
      const direction = backward
        ? term.direction === 'asc'
          ? 'desc'
          : 'asc'
        : term.direction

      const nulls = backward ? (term.nulls === 'first' ? 'last' : 'first') : term.nulls
      query = query.orderBy(term.column, direction, nulls)
    }

    if (cursor)
      query = query.where((backward ? keysetBefore : keysetAfter)(order, cursor))

    const page = await query.execute()

    if (page.length === 0) break

    ids.push(...page.map((row) => row.id))
    const last = page.at(-1)!
    cursor = [last.score, last.id]
  }

  return ids
}
