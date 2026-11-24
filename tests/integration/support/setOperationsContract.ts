import { bigint, boolean, date, nullable, number, object, string } from 'valibot'
import { expect } from 'vitest'

import type { CompoundSelectBuilder, Db } from '@/index'
import {
  QueryError,
  alias,
  defineTable,
  eq,
  exists,
  inQuery,
  outer,
  scalar,
} from '@/index'

const fields = {
  id: number(),
  value: nullable(number()),
  label: string(),
  flag: boolean(),
  created: date(),
  big: bigint(),
  json: object({ value: string() }),
}

const SetLeft = defineTable('set_left', fields, { primaryKey: 'id' })
const SetRight = defineTable('set_right', fields, { primaryKey: 'id' })
const tables = [SetLeft, SetRight] as const
const created = new Date('2026-01-02T03:04:05Z')
const extra = {
  label: 'same',
  flag: true,
  created,
  big: 9007199254740993n,
  json: { value: 'native' },
}

/** Checks SQL set semantics and grouping on each native database. */
async function assertSetOperations(db: Db): Promise<void> {
  await db.migrate().execute()

  await db
    .insert(SetLeft)
    .values([1, 1, null, 2].map((value, index) => ({ id: index + 1, value, ...extra })))
    .execute()

  await db
    .insert(SetRight)
    .values([1, null, 3].map((value, index) => ({ id: index + 11, value, ...extra })))
    .execute()

  await assertNativeSets(db)
  await assertNativeGrouping(db)
  await assertNativePages(db)
  await assertNativeMapping(db)
  await assertNativeSubqueries(db)
  await assertNativeTransactions(db)
  await assertDistinctRows(db)
}

function operands(db: Db) {
  const a = db.from(SetLeft).select([SetLeft.value])
  const b = db.from(SetRight).select([SetRight.value])
  return {
    a,
    b,
    empty: b.where(SetRight.id, 'eq', -1),
    one: a.where(SetLeft.id, 'eq', 1),
    two: a.where(SetLeft.id, 'eq', 4),
  }
}

const sorted = (values: { value: number | null }[]) =>
  values
    .map((row) => row.value)
    .sort((a, b) => (a === null ? -1 : b === null ? 1 : a - b))

async function assertNativeSets(db: Db) {
  const { a, b, empty } = operands(db)
  expect(sorted(await a.union(b).execute())).toEqual([null, 1, 2, 3])
  expect(sorted(await a.unionAll(b).execute())).toEqual([null, null, 1, 1, 1, 2, 3])
  expect(sorted(await a.intersect(b).execute())).toEqual([null, 1])
  expect(await a.except(b).execute()).toEqual([{ value: 2 }])
  expect(sorted(await a.union(empty).execute())).toEqual([null, 1, 2])
  expect(await a.intersect(empty).execute()).toEqual([])
  expect(sorted(await a.except(empty).execute())).toEqual([null, 1, 2])
  expect(await empty.unionAll(empty).execute()).toEqual([])
}

async function assertNativeGrouping(db: Db) {
  const { one, two } = operands(db)
  expect(await one.union(two).intersect(two).execute()).toEqual([{ value: 2 }])
  expect(sorted(await one.union(two.intersect(two)).execute())).toEqual([1, 2])
  expect(await one.union(two).except(one).execute()).toEqual([{ value: 2 }])
  expect(sorted(await one.union(two.except(one)).execute())).toEqual([1, 2])
}

async function assertNativePages(db: Db) {
  const { a, b, one } = operands(db)
  const before = a.compile()

  expect(
    await a
      .orderBy(SetLeft.id)
      .limit(2)
      .offset(1)
      .unionAll(b.orderBy(SetRight.id).limit(1))
      .orderBy('value', 'asc', 'last')
      .execute(),
  ).toEqual([{ value: 1 }, { value: 1 }, { value: null }])

  expect(
    await a.union(b).orderBy('value', 'desc', 'last').limit(2).offset(1).execute(),
  ).toEqual([{ value: 2 }, { value: 1 }])

  expect(await a.union(b).orderBy('value', 'asc', 'last').offset(2).execute()).toEqual([
    { value: 3 },
    { value: null },
  ])

  const page = a.union(b).orderBy('value', 'desc', 'last').limit(1)
  expect(sorted(await page.unionAll(one).execute())).toEqual([1, 3])
  expect(sorted(await one.unionAll(page).execute())).toEqual([1, 3])
  expect(a.compile()).toEqual(before)
  expect(page.compile()).toEqual(page.compile())
}

async function assertNativeMapping(db: Db) {
  const values = [
    SetLeft.label,
    SetLeft.flag,
    SetLeft.created,
    SetLeft.big,
    SetLeft.json,
  ] as const

  const mapped = db
    .from(SetLeft)
    .select(values)
    .union(
      db
        .from(SetRight)
        .select([
          SetRight.label,
          SetRight.flag,
          SetRight.created,
          SetRight.big,
          SetRight.json,
        ]),
    )

  expect(await mapped.execute()).toEqual([extra])
  expect(await db.from(SetLeft).unionAll(db.from(SetRight)).execute()).toHaveLength(7)
  const other = alias(SetLeft, 'other')
  expect(
    await db.from(SetLeft).selectAll().intersect(db.from(other)).execute(),
  ).toHaveLength(4)
}

async function assertNativeSubqueries(db: Db) {
  const { a, b, empty } = operands(db)
  const ids = a.union(b)

  const scalarQuery = db
    .from(SetLeft)
    .select((e) => [e.as(scalar(empty.union(empty)), 'missing')])
    .limit(1)

  expect(await scalarQuery.execute()).toEqual([{ missing: null }])

  expect(
    await db
      .from(SetLeft)
      .select([SetLeft.id])
      .where(inQuery(SetLeft.value, ids))
      .orderBy(SetLeft.id)
      .execute(),
  ).toEqual([{ id: 1 }, { id: 2 }, { id: 4 }])

  const correlated = b.where(eq(SetRight.value, outer(SetLeft.value)))
  expect(
    await db
      .from(SetLeft)
      .select([SetLeft.id])
      .where(exists(correlated.union(correlated)))
      .orderBy(SetLeft.id)
      .execute(),
  ).toEqual([{ id: 1 }, { id: 2 }])

  await expect(empty.union(empty).executeTakeFirst()).resolves.toBeUndefined()
  await expect(empty.union(empty).executeTakeFirstOrThrow()).rejects.toThrow(QueryError)
}

async function assertNativeTransactions(db: Db) {
  await db.transaction(async (tx) => {
    const query = tx
      .from(SetLeft)
      .select([SetLeft.value])
      .union(tx.from(SetRight).select([SetRight.value]))

    expect(sorted(await query.execute())).toEqual([null, 1, 2, 3])
    expect(() => tx.from(SetLeft).union(db.from(SetLeft))).toThrow(/client scope/)
  })

  let expired: CompoundSelectBuilder<{ value: number | null }> | undefined

  await db.transaction(async (tx) => {
    expired = tx
      .from(SetLeft)
      .select([SetLeft.value])
      .union(tx.from(SetRight).select([SetRight.value]))
  })

  await expect(expired!.execute()).rejects.toThrow(QueryError)
}

/** Distinct operators compare complete rows, including the second selected output. */
async function assertDistinctRows(db: Db) {
  const caseOutputs = db
    .from(SetLeft)
    .select((e) => [e.as(SetLeft.id, 'x'), e.as(SetLeft.value, 'X')])

  const first = caseOutputs.where(SetLeft.id, 'eq', 1)
  const fourth = caseOutputs.where(SetLeft.id, 'eq', 4)
  expect(await first.unionAll(fourth).orderBy('X', 'desc').execute()).toEqual([
    { x: 4, X: 2 },
    { x: 1, X: 1 },
  ])

  await db
    .update(SetRight)
    .set({ label: 'different' })
    .where(SetRight.id, 'eq', 11)
    .execute()

  const a = db
    .from(SetLeft)
    .select([SetLeft.value, SetLeft.label])
    .where(SetLeft.value, 'eq', 1)

  const b = db
    .from(SetRight)
    .select([SetRight.value, SetRight.label])
    .where(SetRight.value, 'eq', 1)

  expect(await a.union(b).orderBy('label').execute()).toEqual([
    { value: 1, label: 'different' },
    { value: 1, label: 'same' },
  ])

  expect(await a.intersect(b).execute()).toEqual([])
  expect(await a.except(b).execute()).toEqual([{ value: 1, label: 'same' }])
}

/** Leaves cardinality behavior to the selected database, including its native error. */
function scalarCardinalityQuery(db: Db) {
  const { a, b } = operands(db)
  return db
    .from(SetLeft)
    .select((e) => [e.as(scalar(a.union(b).orderBy('value', 'desc', 'last')), 'value')])
    .limit(1)
}

export { tables, assertSetOperations, scalarCardinalityQuery }
