import {
  bigint,
  date,
  integer,
  nullable,
  number,
  pipe,
  safeInteger,
  string,
} from 'valibot'
import { expect } from 'vitest'

import type { Db } from '@/index'
import { alias, defineTable, eq, inQuery, outer, scalar } from '@/index'

const Users = defineTable(
  'expression_users',
  { id: pipe(number(), integer()), name: string() },
  { primaryKey: 'id' },
)

const Posts = defineTable(
  'expression_posts',
  {
    id: pipe(number(), integer()),
    userId: pipe(number(), integer()),
    whole: nullable(pipe(number(), integer())),
    amount: nullable(number()),
    big: bigint(),
    title: nullable(string()),
    created: date(),
  },
  { primaryKey: 'id' },
)

const NumericValues = defineTable(
  'expression_numeric_limits',
  {
    id: pipe(number(), integer()),
    whole: pipe(number(), safeInteger()),
    big: bigint(),
  },
  { primaryKey: 'id' },
)

const expressionTables = [Users, Posts, NumericValues] as const

const created = new Date('2026-06-15T03:04:05.000Z')

function aggregateQuery(db: Db) {
  return db
    .from(Posts)
    .select((b) => [
      b.as(b.countAll(), 'all'),
      b.as(b.count(Posts.title), 'titles'),
      b.as(b.min(Posts.id), 'min'),
      b.as(b.max(Posts.id), 'max'),
      b.as(b.sum(Posts.whole), 'whole'),
      b.as(b.sum(Posts.amount), 'amount'),
      b.as(b.sum(Posts.big), 'big'),
    ])
}

/** Exercises each result contract against native driver values and composed SQL. */
async function assertExpressionResults(db: Db): Promise<void> {
  await db.migrate().execute()
  await assertEmpty(db)
  await seedRows(db)
  await assertAggregates(db)
  await assertLimits(db)
  await assertAllnull(db)
  await assertScalar(db)
  await assertGroups(db)
  await assertJoins(db)
  await assertNames(db)
  await assertStrings(db)
  await assertCompound(db)
  await assertClock(db)
}

async function assertEmpty(db: Db): Promise<void> {
  expect(await aggregateQuery(db).execute()).toEqual([
    { all: 0, titles: 0, min: null, max: null, whole: null, amount: null, big: null },
  ])

  expect(await aggregateQuery(db).groupBy(Posts.userId).execute()).toEqual([])
}

async function seedRows(db: Db): Promise<void> {
  await db
    .insert(Users)
    .values([
      { id: 1, name: 'ALICE' },
      { id: 2, name: 'BOB' },
      { id: 3, name: 'EMPTY' },
    ])
    .execute()

  await db
    .insert(Posts)
    .values([
      {
        id: 1,
        userId: 1,
        whole: 2_147_483_647,
        amount: 0.1,
        big: 9_007_199_254_740_991n,
        title: 'ALICE',
        created,
      },
      { id: 2, userId: 1, whole: 1, amount: 0.2, big: 2n, title: null, created },
      { id: 3, userId: 2, whole: null, amount: null, big: 0n, title: 'BOB', created },
    ])
    .execute()
}

async function assertAggregates(db: Db): Promise<void> {
  const rows = await aggregateQuery(db).execute()
  expect(rows).toEqual([
    {
      all: 3,
      titles: 2,
      min: 1,
      max: 3,
      whole: 2_147_483_648,
      amount: rows[0].amount,
      big: 9_007_199_254_740_993n,
    },
  ])

  expect(rows[0].amount).toBeCloseTo(0.3)

  expect(typeof rows[0].whole).toBe('number')
  expect(typeof rows[0].big).toBe('bigint')

  expect(
    await db
      .from(Posts)
      .select((b) => [b.as(b.min(Posts.created), 'created')])
      .execute(),
  ).toEqual([{ created }])
}

async function assertLimits(db: Db): Promise<void> {
  await db
    .insert(NumericValues)
    .values([
      { id: 1, whole: Number.MAX_SAFE_INTEGER, big: 9_000_000_000_000_000_000n },
      { id: 2, whole: 2, big: 9_000_000_000_000_000_000n },
    ])
    .execute()

  expect(
    await db
      .from(NumericValues)
      .where(eq(NumericValues.id, 1))
      .select((b) => [b.as(b.sum(NumericValues.whole), 'sum')])
      .execute(),
  ).toEqual([{ sum: Number.MAX_SAFE_INTEGER }])

  const firstTotal = db.cte(
    'first_total',
    db
      .from(NumericValues)
      .where(eq(NumericValues.id, 1))
      .select((b) => [b.as(b.sum(NumericValues.whole), 'total')]),
  )

  const secondTotal = db.cte(
    'second_total',
    db.from(firstTotal).select((b) => [b.as(b.sum(firstTotal.total), 'total')]),
  )

  expect(await db.with(secondTotal).from(secondTotal).execute()).toEqual([
    { total: Number.MAX_SAFE_INTEGER },
  ])

  const subtotals = db.cte(
    'subtotals',
    db
      .from(NumericValues)
      .groupBy(NumericValues.id)
      .select((b) => [b.as(b.sum(NumericValues.whole), 'total')]),
  )

  await expect(
    db
      .with(subtotals)
      .from(subtotals)
      .select((b) => [b.as(b.sum(subtotals.total), 'total')])
      .execute(),
  ).rejects.toThrow(/safely/)

  await expect(
    db
      .from(NumericValues)
      .select((b) => [b.as(b.sum(NumericValues.whole), 'sum')])
      .execute(),
  ).rejects.toThrow(/safely/)
}

async function assertAllnull(db: Db): Promise<void> {
  expect(
    await db
      .from(Posts)
      .where(eq(Posts.id, 3))
      .select((b) => [b.as(b.sum(Posts.whole), 'value')])
      .execute(),
  ).toEqual([{ value: null }])
}

async function assertScalar(db: Db): Promise<void> {
  const highest = db.from(Posts).select((b) => [b.as(b.max(Posts.id), 'id')])
  expect(
    await db
      .from(Posts)
      .where(eq(Posts.id, scalar(highest)))
      .select([Posts.id])
      .execute(),
  ).toEqual([{ id: 3 }])

  expect(
    await db
      .from(Users)
      .where((b) =>
        b.gt(b.scalar(db.from(Posts).select((c) => [c.as(c.countAll(), 'n')])), 0),
      )
      .select([Users.id])
      .execute(),
  ).toHaveLength(3)

  expect(
    await db
      .from(Users)
      .where((b) => b.eq(b.scalar(highest), 3))
      .select([Users.id])
      .execute(),
  ).toHaveLength(3)
}

async function assertGroups(db: Db): Promise<void> {
  const grouped = db
    .from(Posts)
    .where(eq(Posts.userId, outer(Users.id)))
    .select((b) => [b.as(b.countAll(), 'n')])
    .groupBy(Posts.userId)

  const ungrouped = db
    .from(Posts)
    .where(eq(Posts.userId, outer(Users.id)))
    .select((b) => [b.as(b.countAll(), 'n')])

  const absent = db.from(Posts).where(eq(Posts.id, 99)).select([Posts.id])
  expect(
    await db
      .from(Users)
      .select((b) => [
        Users.id,
        b.as(b.scalar(grouped), 'grouped'),
        b.as(b.scalar(ungrouped), 'ungrouped'),
        b.as(b.scalar(absent), 'absent'),
      ])
      .orderBy(Users.id)
      .execute(),
  ).toEqual([
    { id: 1, grouped: 2, ungrouped: 2, absent: null },
    { id: 2, grouped: 1, ungrouped: 1, absent: null },
    { id: 3, grouped: null, ungrouped: 0, absent: null },
  ])
}

async function assertJoins(db: Db): Promise<void> {
  expect(
    await db
      .from(Users)
      .leftJoin(Posts, eq(Users.id, Posts.userId))
      .select((b) => [
        Users.id,
        b.as(b.count(Posts.id), 'matched'),
        b.as(b.countAll(), 'all'),
      ])
      .groupBy(Users.id)
      .orderBy(Users.id)
      .execute(),
  ).toEqual([
    { id: 1, matched: 2, all: 2 },
    { id: 2, matched: 1, all: 1 },
    { id: 3, matched: 0, all: 1 },
  ])
}

async function assertNames(db: Db): Promise<void> {
  const names = db.cte(
    'normalized_names',
    db.from(Users).select((b) => [b.as(b.lower(Users.name), 'name')]),
  )

  expect(
    await db.with(names).from(names).where(eq(names.name, 'alice')).execute(),
  ).toEqual([{ name: 'alice' }])

  expect(
    await db
      .with(names)
      .from(Users)
      .where(inQuery(Users.name, db.from(names).select([names.name])))
      .execute(),
  ).toEqual([])
}

async function assertStrings(db: Db): Promise<void> {
  expect(
    await db
      .from(Posts)
      .select((b) => [
        Posts.id,
        b.as(b.lower(Posts.title), 'lower'),
        b.as(b.upper(Posts.title), 'upper'),
        b.as(b.length(Posts.title), 'length'),
      ])
      .orderBy(Posts.id)
      .execute(),
  ).toEqual([
    { id: 1, lower: 'alice', upper: 'ALICE', length: 5 },
    { id: 2, lower: null, upper: null, length: null },
    { id: 3, lower: 'bob', upper: 'BOB', length: 3 },
  ])

  const named = alias(Posts, 'named')
  expect(
    await db
      .from(Users)
      .leftJoin(named, eq(Users.id, named.userId))
      .where(eq(Users.id, 3))
      .select((b) => [b.as(b.lower(named.title), 'title')])
      .execute(),
  ).toEqual([{ title: null }])
}

async function assertCompound(db: Db): Promise<void> {
  const counts = db.from(Posts).select((b) => [b.as(b.countAll(), 'n')])
  const combined = db.cte('combined_counts', counts.unionAll(counts))
  const inner = db.from(combined).select([combined.n]).limit(1)
  expect(
    await db
      .with(combined)
      .from(Users)
      .where(eq(Users.id, 1))
      .select((b) => [b.as(b.scalar(inner), 'n')])
      .where((b) => b.eq(b.scalar(inner), 3))
      .execute(),
  ).toEqual([{ n: 3 }])
}

async function assertClock(db: Db): Promise<void> {
  const clock = await db
    .from(Users)
    .where(eq(Users.id, 1))
    .select((b) => [b.as(b.now(), 'now')])
    .executeTakeFirstOrThrow()

  const clockCte = db.cte(
    'clock',
    db
      .from(Users)
      .where(eq(Users.id, 1))
      .select((b) => [b.as(b.now(), 'now')]),
  )

  expect(
    await db
      .with(clockCte)
      .from(clockCte)
      .where(eq(clockCte.now, scalar(db.from(clockCte).select([clockCte.now]))))
      .execute(),
  ).toHaveLength(1)

  expect(clock.now).toBeInstanceOf(Date)
  expect(Math.abs(clock.now.getTime() - Date.now())).toBeLessThan(60_000)
}

export { expressionTables, NumericValues, assertExpressionResults }
