import { nullable, number, pipe, string } from 'valibot'
import { expect, it, onTestFinished } from 'vitest'

import { QueryError, column, createDatabase, defineTable, eq } from '@/index'

import { createMockPostgresConnector } from '../dialects/postgresNativeClientFixtures'

const Users = defineTable(
  'nested_users',
  {
    id: number(),
    name: string(),
    email: nullable(pipe(string(), column({ unique: true }))),
  },
  { primaryKey: 'id' },
)

const Posts = defineTable(
  'nested_posts',
  { id: number(), author: number() },
  { primaryKey: 'id' },
)

const projection = {
  key: [Users.id],
  select: { id: Users.id },
} as const

/** Creates a database that records physical statements prepared by the client. */
function fixture() {
  const connector = createMockPostgresConnector()
  const db = createDatabase({ connector, schemas: [Users, Posts] })
  onTestFinished(() => db.close())
  return { connector, db }
}

it('should execute one select without joins and return no roots when it has no rows', async () => {
  const { connector, db } = fixture()

  await expect(db.from(Users).executeNested(projection)).resolves.toEqual([])

  expect(
    connector.prepared.filter((statement) => statement.includes('"nested_users"')),
  ).toHaveLength(1)
})

it('should reject incompatible select clauses before sending SQL', async () => {
  const { connector, db } = fixture()
  const query = db.from(Users)
  const order = [{ column: Users.id, direction: 'asc', nulls: 'last' }] as const

  for (const builder of [
    query.select([Users.id]),
    query.selectAll(),
    query.rightJoin(Posts, eq(Users.id, Posts.author)),
    query.groupBy(Users.id),
    query.limit(0),
    query.offset(0),
    query.after(order, [1]),
    query.before(order, [1]),
  ]) {
    await expect(builder.executeNested(projection)).rejects.toBeInstanceOf(QueryError)
  }

  expect(connector.prepared).toEqual([])
})

it('should reject keys that are nullable, non-unique, or from the wrong table occurrence', async () => {
  const { connector, db } = fixture()
  const query = db.from(Users).leftJoin(Posts, eq(Users.id, Posts.author))
  for (const key of [
    [Users.name],
    [Users.id, Posts.id],
    [Users.email],
    [Posts.id],
  ] as const) {
    await expect(query.executeNested({ ...projection, key })).rejects.toBeInstanceOf(
      QueryError,
    )
  }

  expect(connector.prepared).toEqual([])
})

it('should reject a field from another occurrence or with a duplicate name', async () => {
  const { connector, db } = fixture()
  const query = db.from(Users).leftJoin(Posts, eq(Users.id, Posts.author))

  await expect(
    query.executeNested({
      ...projection,
      select: { author: Posts.author },
    }),
  ).rejects.toThrow('same table occurrence')

  await expect(
    query.executeNested({
      ...projection,
      many: { id: { key: [Posts.id], select: {} } },
    }),
  ).rejects.toThrow('output field names must be unique')

  expect(connector.prepared).toEqual([])
})
