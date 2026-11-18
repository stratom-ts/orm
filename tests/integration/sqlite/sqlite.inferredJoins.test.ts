import { nullable, number, pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { alias, column, defineTable, reference } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

const Users = defineTable(
  'inferred_users',
  { id: number(), name: string() },
  { primaryKey: 'id' },
)

const Posts = defineTable(
  'inferred_posts',
  {
    id: number(),
    authorId: nullable(pipe(reference(Users, 'id'), column({ name: 'author_id' }))),
  },
  { primaryKey: 'id' },
)

it('should execute inferred inner and outer joins with aliased physical columns', async () => {
  await withSqliteDatabase([Users, Posts], async ({ db }) => {
    await db.migrate().execute()

    await db
      .insert(Users)
      .values([
        { id: 1, name: 'Ada' },
        { id: 2, name: 'Grace' },
      ])
      .execute()

    await db
      .insert(Posts)
      .values([
        { id: 10, authorId: 1 },
        { id: 20, authorId: null },
      ])
      .execute()

    const author = alias(Users, 'author')
    expect(
      await db.from(Posts).innerJoin(author).select([Posts.id, author.name]).execute(),
    ).toEqual([{ id: 10, name: 'Ada' }])

    expect(
      await db
        .from(Posts)
        .leftJoin(author)
        .select([Posts.id, author.name])
        .orderBy(Posts.id)
        .execute(),
    ).toEqual([
      { id: 10, name: 'Ada' },
      { id: 20, name: null },
    ])

    expect(
      await db
        .from(Users)
        .leftJoin(Posts)
        .select([Users.name, Posts.authorId])
        .orderBy(Users.id)
        .execute(),
    ).toEqual([
      { name: 'Ada', authorId: 1 },
      { name: 'Grace', authorId: null },
    ])

    expect(() => db.from(Posts).rightJoin(Users).select([Users.name]).compile()).toThrow(
      /right joins/,
    )
  })
})
