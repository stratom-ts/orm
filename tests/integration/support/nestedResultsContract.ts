import { tracingChannel } from 'node:diagnostics_channel'
import { bigint, date, nullable, number, pipe, string } from 'valibot'
import { expect, expectTypeOf, onTestFinished } from 'vitest'

import type { Db, NestedProjection } from '@/index'
import {
  QUERY_CHANNEL,
  QueryError,
  alias,
  and,
  column,
  defineTable,
  eq,
  withTracing,
} from '@/index'

const Users = defineTable(
  'nested.users',
  { id: pipe(bigint(), column({ name: 'user_id' })), name: string() },
  { primaryKey: 'id' },
)

const Posts = defineTable(
  'nested.posts',
  { author: bigint(), sequence: number(), title: nullable(string()), published: date() },
  { primaryKey: ['author', 'sequence'] },
)

const Comments = defineTable(
  'nested.comments',
  { id: number(), author: bigint(), post: number(), body: string() },
  { primaryKey: 'id' },
)

const featured = alias(Posts, 'featured')
const reviewed = alias(Posts, 'reviewed')
const published = new Date('2026-08-01T12:00:00Z')
const ada = 9007199254740992n
const grace = 9007199254740993n

const nested = {
  key: [Users.id],
  select: { name: Users.name },
  one: {
    featured: {
      key: [featured.author, featured.sequence],
      select: { title: featured.title },
    },
  },
  many: {
    posts: {
      key: [Posts.author, Posts.sequence],
      select: { title: Posts.title, published: Posts.published },
      many: { comments: { key: [Comments.id], select: { body: Comments.body } } },
    },
    reviewed: {
      key: [reviewed.author, reviewed.sequence],
      select: { sequence: reviewed.sequence },
    },
  },
} satisfies NestedProjection

/** Inserts rows that produce duplicate posts, comments, and reviewed posts in a join. */
async function populateNestedResults(db: Db): Promise<void> {
  await db.migrate().execute()

  await db
    .insert(Users)
    .values([
      { id: ada, name: 'Ada' },
      { id: grace, name: 'Grace' },
    ])
    .execute()

  await db
    .insert(Posts)
    .values([
      { author: ada, sequence: 1, title: null, published },
      { author: ada, sequence: 2, title: 'Second', published },
    ])
    .execute()

  await db
    .insert(Comments)
    .values([
      { id: 10, author: ada, post: 1, body: 'First comment' },
      { id: 11, author: ada, post: 1, body: 'Second comment' },
    ])
    .execute()
}

/**
 * Exercises inferred result types, raw composite identity, nullability, and child
 * ordering.
 */
async function assertNestedResults(db: Db): Promise<void> {
  await populateNestedResults(db)
  let queryCount = 0
  const channel = tracingChannel(QUERY_CHANNEL)
  const subscribers = {
    /** Counts physical SQL statements issued by the traced client. */
    asyncEnd: () => {
      queryCount += 1
    },
  }

  channel.subscribe(subscribers)
  onTestFinished(() => channel.unsubscribe(subscribers))

  const rows = await queryNestedResults(withTracing(db))
  expect(queryCount).toBe(1)

  expectTypeOf(rows).toEqualTypeOf<
    {
      name: string
      featured: { title: string | null } | null
      posts: { title: string | null; published: Date; comments: { body: string }[] }[]
      reviewed: { sequence: number }[]
    }[]
  >()

  expect(rows).toEqual([
    {
      name: 'Ada',
      featured: { title: null },
      posts: [
        {
          title: null,
          published,
          comments: [{ body: 'First comment' }, { body: 'Second comment' }],
        },
        { title: 'Second', published, comments: [] },
      ],
      reviewed: [{ sequence: 2 }, { sequence: 1 }],
    },
    {
      name: 'Grace',
      featured: null,
      posts: [],
      reviewed: [{ sequence: 2 }, { sequence: 1 }],
    },
  ])
}

/** Loads the graph with enough sibling rows to gain a cross product in SQL. */
function queryNestedResults(db: Db) {
  return db
    .from(Users)
    .leftJoin(Posts, eq(Users.id, Posts.author))
    .leftJoin(
      Comments,
      and(eq(Comments.author, Posts.author), eq(Comments.post, Posts.sequence)),
    )
    .leftJoin(featured, and(eq(Users.id, featured.author), eq(featured.sequence, 1)))
    .leftJoin(reviewed, eq(reviewed.author, ada))
    .orderBy(Users.id)
    .orderBy(Posts.sequence)
    .orderBy(Comments.id)
    .orderBy(reviewed.sequence, 'desc')
    .executeNested(nested)
}

const nestedTables = [Users, Posts, Comments] as const

/** Checks that a to-one field rejects two distinct keys for the same parent. */
async function assertNestedCardinality(db: Db): Promise<void> {
  await populateNestedResults(db)

  await expect(
    db
      .from(Users)
      .innerJoin(featured, eq(Users.id, featured.author))
      .executeNested({
        key: [Users.id],
        select: {},
        one: nested.one,
      }),
  ).rejects.toMatchObject({
    name: QueryError.name,
    message: 'executeNested one relation "featured" matched multiple keys',
  })
}

export { nestedTables, assertNestedResults, assertNestedCardinality }
