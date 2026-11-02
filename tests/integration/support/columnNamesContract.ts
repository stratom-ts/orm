import { boolean, nullable, number, pipe, string } from 'valibot'
import { expect } from 'vitest'

import type { Db } from '@/index'
import { column, countAll, defineTable, eq, excluded, lower, reference } from '@/index'

const longProperty =
  '\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d\u540d'

const longAlias = `${longProperty}alias`
const Users = defineTable(
  'mapped_users',
  {
    id: pipe(number(), column({ name: 'user_id' })),
    fullName: nullable(pipe(string(), column({ name: 'displayName', unique: true }))),
    active: pipe(boolean(), column({ name: 'is_active' })),
    [longProperty]: pipe(string(), column({ name: 'short_value' })),
  },
  { primaryKey: 'id', indexes: [{ columns: ['fullName', 'active'] }] },
)

const Posts = defineTable(
  'mapped_posts',
  {
    postId: pipe(number(), column({ name: 'post_id' })),
    authorId: pipe(reference(Users, 'id'), column({ name: 'author_id' })),
  },
  { primaryKey: 'postId' },
)

const Swapped = defineTable(
  'mapped_swaps',
  {
    left: pipe(string(), column({ name: 'right' })),
    right: pipe(string(), column({ name: 'left' })),
  },
  { primaryKey: 'left' },
)

const RenamedUsers = defineTable(
  'mapped_users',
  {
    applicationId: pipe(number(), column({ name: 'user_id' })),
    display: nullable(pipe(string(), column({ name: 'displayName', unique: true }))),
    enabled: pipe(boolean(), column({ name: 'is_active' })),
    short: pipe(string(), column({ name: 'short_value' })),
  },
  { primaryKey: 'applicationId', indexes: [{ columns: ['display', 'enabled'] }] },
)

const RenamedPosts = defineTable(
  'mapped_posts',
  {
    id: pipe(number(), column({ name: 'post_id' })),
    owner: pipe(reference(RenamedUsers, 'applicationId'), column({ name: 'author_id' })),
  },
  { primaryKey: 'id' },
)

const Bare = defineTable(
  'bare_columns',
  { id: number(), label: string() },
  { primaryKey: 'id' },
)

const PhysicalOriginal = defineTable(
  'physical_changes',
  {
    id: pipe(number(), column({ name: 'row_id' })),
    value: nullable(pipe(string(), column({ name: 'old_value' }))),
  },
  { primaryKey: 'id' },
)

const PhysicalChanged = defineTable(
  'physical_changes',
  {
    id: pipe(number(), column({ name: 'row_id' })),
    value: nullable(pipe(string(), column({ name: 'new_value' }))),
  },
  { primaryKey: 'id' },
)

const CanonicalA = defineTable(
  'canonical_columns',
  {
    a: pipe(string(), column({ name: 'first', unique: true })),
    b: pipe(string(), column({ name: 'second' })),
  },
  { primaryKey: 'a', indexes: [{ columns: ['b', 'a'] }] },
)

const CanonicalB = defineTable(
  'canonical_columns',
  {
    renamedB: pipe(string(), column({ name: 'second' })),
    renamedA: pipe(string(), column({ name: 'first', unique: true })),
  },
  { primaryKey: 'renamedA', indexes: [{ columns: ['renamedB', 'renamedA'] }] },
)

const schemas = [Users, Posts, Swapped, Bare, PhysicalOriginal] as const
const renamedSchemas = [
  RenamedUsers,
  RenamedPosts,
  Swapped,
  Bare,
  PhysicalOriginal,
] as const

/** Exercises complete public query behavior against native storage in both dialects. */
async function exerciseColumnNames(
  db: Db,
  namespace: readonly string[] = [],
): Promise<void> {
  await db.migrate().execute()
  await db.insert(PhysicalOriginal).values({ id: 1, value: 'retained' }).execute()
  await assertWildcards(db, namespace)
  await assertReads(db)
  await assertJoins(db)
  await assertWrites(db)
  await assertSwaps(db)
  expect(await db.migrate().plan()).toEqual({ steps: [] })
}

async function assertWildcards(db: Db, namespace: readonly string[]): Promise<void> {
  await db.insert(Bare).values({ id: 1, label: 'declared' }).execute()
  await db.sql`alter table ${db.sql.id(...namespace, 'bare_columns')} add column hidden text`

  expect(await db.from(Bare).selectAll().execute()).toEqual([
    { id: 1, label: 'declared' },
  ])

  expect(
    await db.update(Bare).set({ label: 'changed' }).all().returningAll().execute(),
  ).toEqual([{ id: 1, label: 'changed' }])

  await db.sql`alter table ${db.sql.id(...namespace, 'bare_columns')} drop column hidden`
}

async function assertReads(db: Db): Promise<void> {
  const first = { id: 1, fullName: 'Ada', active: true, [longProperty]: 'long' }
  expect(await db.insert(Users).values(first).execute()).toEqual([first])
  expect(await db.from(Users).execute()).toEqual([first])

  expect(await db.execute(db.from(Users).compile())).toEqual([
    expect.objectContaining({ [longProperty]: 'long' }),
  ])

  expect(
    await db
      .from(Users)
      .select((b) => [b.as(Users.fullName, longAlias)])
      .execute(),
  ).toEqual([{ [longAlias]: 'Ada' }])

  expect(
    await db
      .from(Users)
      .select((b) => [b.as(lower(Users.fullName), 'lowered')])
      .where('fullName', 'eq', 'Ada')
      .execute(),
  ).toEqual([{ lowered: 'ada' }])

  expect(
    await db
      .from(Users)
      .select((b) => [b.as(countAll(), 'total')])
      .groupBy(Users.fullName)
      .having(eq(Users.fullName, 'Ada'))
      .execute(),
  ).toHaveLength(1)

  expect(() =>
    db
      .from(Users)
      .select(['displayName' as never])
      .compile(),
  ).toThrow(/not available|Unknown application/)

  expect(() =>
    db
      .from(Users)
      .select(['FULLNAME' as never])
      .compile(),
  ).toThrow(/not available|Unknown application/)
}

async function assertJoins(db: Db): Promise<void> {
  const first = { id: 1, fullName: 'Ada', active: true, [longProperty]: 'long' }
  await expect(
    db
      .insert(Users)
      .values({ ...first, id: 99 })
      .execute(),
  ).rejects.toMatchObject({ kind: 'uniqueViolation' })

  await expect(
    db.insert(Posts).values({ postId: 99, authorId: 999 }).execute(),
  ).rejects.toMatchObject({ kind: 'foreignKeyViolation' })

  expect(await db.insert(Posts).values({ postId: 10, authorId: 1 }).execute()).toEqual([
    { postId: 10, authorId: 1 },
  ])

  expect(
    await db
      .from(Posts)
      .leftJoin(Users, eq(Posts.authorId, Users.id))
      .select((b) => [Posts.postId, b.as(Users.fullName, 'author')])
      .orderBy(Posts.postId)
      .execute(),
  ).toEqual([{ postId: 10, author: 'Ada' }])

  expect(
    await db
      .from(Users)
      .leftJoin(Posts, eq(Users.id, Posts.authorId))
      .select((b) => [Users.id, b.as(Posts.postId, 'post')])
      .execute(),
  ).toEqual([{ id: 1, post: 10 }])

  await db
    .insert(Users)
    .values({ ...first, id: 2, fullName: null })
    .execute()

  expect(
    await db
      .from(Users)
      .leftJoin(Posts, eq(Users.id, Posts.authorId))
      .select((b) => [Users.id, b.as(Posts.postId, 'post')])
      .where(Users.id, 'eq', 2)
      .execute(),
  ).toEqual([{ id: 2, post: null }])
}

async function assertWrites(db: Db): Promise<void> {
  const first = { id: 1, fullName: 'Ada', active: true, [longProperty]: 'long' }
  expect(() => db.from(Users).select([Users.id, Users.id]).compile()).toThrow(/ambiguous/)

  expect(() =>
    db.insert(Users).values(first).returning([Users.id, Users.id]).compile(),
  ).toThrow(/ambiguous/)

  expect(
    await db
      .update(Users)
      .set({ fullName: 'Grace' })
      .where(Users.id, 'eq', 1)
      .returning([Users.fullName])
      .execute(),
  ).toEqual([{ fullName: 'Grace' }])

  expect(
    await db
      .insert(Users)
      .values({ ...first, fullName: 'New' })
      .onConflict([Users.id])
      .doUpdate({ fullName: excluded(Users.fullName) })
      .returningAll()
      .execute(),
  ).toEqual([{ ...first, fullName: 'New' }])

  expect(
    await db.delete(Users).where(Users.id, 'eq', 2).returning([Users.id]).execute(),
  ).toEqual([{ id: 2 }])
}

async function assertSwaps(db: Db): Promise<void> {
  const swap = { left: 'L', right: 'R' }
  expect(await db.insert(Swapped).values(swap).execute()).toEqual([swap])

  expect(
    await db.from(Swapped).where(Swapped.left, 'eq', 'L').selectAll().execute(),
  ).toEqual([swap])
}

/** Proves an application-only rename keeps data and generated physical object names. */
async function assertApplicationRename(db: Db): Promise<void> {
  expect(await db.migrate().plan()).toEqual({ steps: [] })

  expect(await db.from(RenamedUsers).execute()).toEqual([
    { applicationId: 1, display: 'New', enabled: true, short: 'long' },
  ])

  expect(await db.from(RenamedPosts).execute()).toEqual([{ id: 10, owner: 1 }])
}

/** A changed physical identifier remains an ownership-controlled storage change. */
async function assertPhysicalChanges(
  complete: Db,
  additive: Db,
  original: Db,
): Promise<void> {
  const completePlan = await complete.migrate().plan()
  expect(
    completePlan.steps.flatMap((step) =>
      step.kind === 'add_column' ? [step.target.column.spelling] : [],
    ),
  ).toEqual(['new_value'])

  expect(
    completePlan.steps.flatMap((step) =>
      step.kind === 'drop_column' ? [step.target.column.spelling] : [],
    ),
  ).toEqual(['old_value'])

  await expect(complete.migrate().execute()).rejects.toThrow(/drop/i)
  const additivePlan = await additive.migrate().plan()
  expect(additivePlan.steps.map((step) => step.kind)).toEqual(['add_column'])
  await additive.migrate().execute()
  expect(await additive.from(PhysicalChanged).execute()).toEqual([{ id: 1, value: null }])

  expect(await original.from(PhysicalOriginal).execute()).toEqual([
    { id: 1, value: 'retained' },
  ])
}

export {
  longProperty,
  longAlias,
  Users,
  Posts,
  Swapped,
  RenamedUsers,
  RenamedPosts,
  Bare,
  PhysicalOriginal,
  PhysicalChanged,
  CanonicalA,
  CanonicalB,
  schemas,
  renamedSchemas,
  exerciseColumnNames,
  assertApplicationRename,
  assertPhysicalChanges,
}
