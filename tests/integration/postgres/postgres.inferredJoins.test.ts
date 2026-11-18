import { nullable, number, pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { alias, column, defineTable, reference } from '@/index'

import { withPostgresDatabase } from './postgresIntegration'

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

it('should execute inferred inner, left and right joins with aliased physical columns', async () => {
  await withPostgresDatabase([Users, Posts], async ({ db }) => {
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
        .from(Posts)
        .rightJoin(author)
        .select([Posts.id, author.name])
        .orderBy(author.id)
        .execute(),
    ).toEqual([
      { id: 10, name: 'Ada' },
      { id: null, name: 'Grace' },
    ])
  })
})

it('should reject execution when inferred reference qualification differs from the physical session', async () => {
  const PublicUsers = defineTable(
    'inferred_users',
    { id: number() },
    { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
  )

  const Users = defineTable('inferred_users', { id: number() }, { primaryKey: 'id' })
  const Posts = defineTable(
    'inferred_posts',
    { id: number(), userId: reference(PublicUsers, 'id') },
    { primaryKey: 'id' },
  )

  await withPostgresDatabase(
    [Users, Posts],
    async ({ db }) => {
      await expect(
        db.from(Posts).innerJoin(alias(Users, 'author')).select([Posts.id]).execute(),
      ).rejects.toThrow(/schema.*public.*current schema/)
    },
    { useRegistrationDefault: false, sessionSchema: 'isolated' },
  )
})
