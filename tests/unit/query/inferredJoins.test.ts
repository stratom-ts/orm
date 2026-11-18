import { nullable, number, pipe, string } from 'valibot'
import { expect, expectTypeOf, it } from 'vitest'

import type { ReferenceTarget } from '@/index'
import {
  QueryError,
  alias,
  column,
  createDatabase,
  defineTable,
  eq,
  exists,
  postgresDialect,
  reference,
  sqliteDialect,
} from '@/index'
import { createTableBuilder } from '@/query'

import { createMockPostgresConnector } from '../dialects/postgresNativeClientFixtures'

const Users = defineTable('users', { id: number(), name: string() }, { primaryKey: 'id' })
const Posts = defineTable(
  'posts',
  { id: number(), authorId: reference(Users, 'id') },
  { primaryKey: 'id' },
)

const Comments = defineTable(
  'comments',
  { id: number(), postId: reference(Posts, 'id') },
  { primaryKey: 'id' },
)

const executor = { execute: async () => [], run: async () => 0 }

for (const dialect of [postgresDialect, sqliteDialect]) {
  const from = <T extends Parameters<typeof createTableBuilder>[0]['handle']>(
    handle: T,
  ) => createTableBuilder({ handle, dialect, executor })

  it(`should infer forward and reverse joins with the same equality as explicit predicates for ${dialect.id}`, () => {
    expect(from(Posts).innerJoin(Users).select([Posts.id]).compile()).toEqual(
      from(Posts)
        .innerJoin(Users, eq(Posts.authorId, Users.id))
        .select([Posts.id])
        .compile(),
    )

    expect(from(Users).leftJoin(Posts).select([Users.id]).compile()).toEqual(
      from(Users)
        .leftJoin(Posts, eq(Posts.authorId, Users.id))
        .select([Users.id])
        .compile(),
    )
  })

  it(`should infer from a preceding join and preserve independent builder branches for ${dialect.id}`, () => {
    const root = from(Users)
    const joined = root.innerJoin(Posts)
    const chain = joined.innerJoin(Comments).select([Comments.postId]).compile()
    expect(chain).toEqual(
      joined
        .innerJoin(Comments, eq(Comments.postId, Posts.id))
        .select([Comments.postId])
        .compile(),
    )

    expect(root.compile().sql).not.toContain('join')
    expect(joined.select([Users.id]).compile().sql).not.toContain('comments')
    expect(() => root.innerJoin(Comments)).toThrow(/No direct reference.*explicit on/)
  })

  it(`should reject multiple references and let explicit on choose a path for ${dialect.id}`, () => {
    const Messages = defineTable(
      'messages',
      { sender: reference(Users, 'id'), recipient: reference(Users, 'id') },
      { primaryKey: 'sender' },
    )

    expect(() => from(Messages).innerJoin(Users)).toThrow(QueryError)

    expect(() => from(Messages).innerJoin(Users)).toThrow(
      /Ambiguous.*sender.*recipient.*explicit on/,
    )

    expect(
      from(Messages)
        .innerJoin(Users, eq(Messages.sender, Users.id))
        .select([Users.id])
        .compile().sql,
    ).toContain('sender')

    expect(
      from(Users)
        .innerJoin(Comments, (b) => b.eq(Users.id, Comments.id))
        .select([Users.id])
        .compile().sql,
    ).toContain('join')
  })

  it(`should reject competing edges to different visible tables for ${dialect.id}`, () => {
    const Reactions = defineTable(
      'reactions',
      { userId: reference(Users, 'id'), postId: reference(Posts, 'id') },
      { primaryKey: 'userId' },
    )

    expect(() => from(Users).innerJoin(Posts).innerJoin(Reactions)).toThrow(
      /Ambiguous.*explicit on/,
    )
  })

  it(`should bind aliases to their occurrences and require a self-join direction for ${dialect.id}`, () => {
    const author = alias(Users, 'author')
    const post = alias(Posts, 'post')
    const base = from(post).innerJoin(author).select([post.id, author.name]).compile()
    expect(base).toEqual(
      from(post)
        .innerJoin(author, eq(post.authorId, author.id))
        .select([post.id, author.name])
        .compile(),
    )

    expect(from(Posts).innerJoin(author).select([author.name]).compile().sql).toContain(
      'join',
    )

    const People = defineTable(
      'people',
      {
        id: number(),
        parentId: nullable(reference(number(), (): ReferenceTarget => People, 'id')),
      },
      { primaryKey: 'id' },
    )

    const parent = alias(People, 'parent')
    expect(() => from(People).leftJoin(parent)).toThrow(/Ambiguous.*explicit on/)

    expect(
      from(People)
        .leftJoin(parent, eq(People.parentId, parent.id))
        .select([parent.id])
        .compile().sql,
    ).toContain('left join')
  })

  it(`should infer wrapped lazy references and preserve defects from lazy targets for ${dialect.id}`, () => {
    const Deferred = defineTable(
      'deferred',
      { id: number(), authorId: nullable(reference(number(), () => Users, 'id')) },
      { primaryKey: 'id' },
    )

    expect(from(Deferred).innerJoin(Users).select([Deferred.id]).compile()).toEqual(
      from(Deferred)
        .innerJoin(Users, eq(Deferred.authorId, Users.id))
        .select([Deferred.id])
        .compile(),
    )

    const defect = new Error('target defect')
    const Broken = defineTable(
      'broken',
      {
        id: number(),
        authorId: reference(
          number(),
          (): ReferenceTarget => {
            throw defect
          },
          'id',
        ),
      },
      { primaryKey: 'id' },
    )

    expect(() => from(Broken).innerJoin(Users)).toThrow(defect)

    expect(
      from(Broken).innerJoin(Users, eq(Broken.id, Users.id)).select([Broken.id]).compile()
        .sql,
    ).toContain('join')
  })

  it(`should retain outer join projection types and dialect limitations for ${dialect.id}`, () => {
    const left = from(Posts).leftJoin(Users).select([Posts.id, Users.name])
    expectTypeOf<Awaited<ReturnType<typeof left.execute>>>().toEqualTypeOf<
      { id: number; name: string | null }[]
    >()

    const right = from(Posts).rightJoin(Users).select([Posts.id, Users.name])
    expectTypeOf<Awaited<ReturnType<typeof right.execute>>>().toEqualTypeOf<
      { id: number | null; name: string }[]
    >()
  })
}

it('should preserve dotted namespace identities and physical column names', async () => {
  const ns = [{ role: 'schema' as const, spelling: 'a.b' }]
  const Target = defineTable(
    'c',
    { id: pipe(number(), column({ name: 'stored_id' })) },
    { primaryKey: 'id', namespace: ns },
  )

  const Collision = defineTable(
    'b.c',
    { id: number() },
    { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a' }] },
  )

  const Source = defineTable(
    'source',
    {
      id: number(),
      targetId: pipe(reference(Target, 'id'), column({ name: 'target_id' })),
    },
    { primaryKey: 'id' },
  )

  const db = createDatabase({
    connector: createMockPostgresConnector(),
    schemas: [Target, Collision, Source],
  })

  try {
    const inferred = db.from(Source).innerJoin(Target).select([Source.id]).compile()
    expect(inferred.sql).toContain('target_id')
    expect(inferred.sql).toContain('stored_id')
    expect(() => db.from(Source).innerJoin(Collision)).toThrow(/No direct reference/)
  } finally {
    await db.close()
  }
})

it('should infer SQLite default namespace and case matches through the dialect', () => {
  const Declared = defineTable(
    'USERS',
    { id: number() },
    { primaryKey: 'id', namespace: [{ role: 'database', spelling: 'MAIN' }] },
  )

  const Source = defineTable(
    'source',
    { id: number(), userId: reference(Declared, 'id') },
    { primaryKey: 'id' },
  )

  const from = createTableBuilder({ handle: Source, dialect: sqliteDialect, executor })
  expect(from.innerJoin(Users).select([Source.id]).compile().sql).toContain('join')
})

it('should guard inferred PostgreSQL qualification without contaminating another query', () => {
  const Qualified = defineTable(
    'users',
    { id: number() },
    { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
  )

  const Source = defineTable(
    'source',
    { id: number(), userId: reference(Qualified, 'id') },
    { primaryKey: 'id' },
  )

  const query = postgresDialect.query.resolve([Users, Source])
  const from = () =>
    createTableBuilder({ handle: Source, dialect: postgresDialect, query, executor })

  const alternate = {
    database: 'test',
    namespaceContext: {
      writableDefault: [{ role: 'schema' as const, spelling: 'alternate' }],
    },
  }

  const inferred = from().innerJoin(alias(Users, 'author')).select([Source.id]).compile()
  expect(inferred.assertSession).toBeTypeOf('function')
  expect(() => inferred.assertSession?.(alternate)).toThrow(/schema.*public.*alternate/)

  expect(() =>
    inferred.assertSession?.({
      ...alternate,
      namespaceContext: { writableDefault: [{ role: 'schema', spelling: 'public' }] },
    }),
  ).not.toThrow()

  expect(() =>
    from().select([Source.id]).compile().assertSession?.(alternate),
  ).not.toThrow()

  expect(() =>
    from()
      .innerJoin(Users, eq(Source.userId, Users.id))
      .select([Source.id])
      .compile()
      .assertSession?.(alternate),
  ).not.toThrow()
})

it('should enforce an inferred reference guard inside a nested select', () => {
  const Qualified = defineTable(
    'users',
    { id: number() },
    {
      primaryKey: 'id',
      namespace: [{ role: 'schema', spelling: 'public' }],
    },
  )

  const Source = defineTable(
    'source',
    { id: number(), userId: reference(Qualified, 'id') },
    { primaryKey: 'id' },
  )

  const query = postgresDialect.query.resolve([Users, Source])

  const inner = createTableBuilder({
    handle: Source,
    dialect: postgresDialect,
    query,
    executor,
  })
    .innerJoin(alias(Users, 'author'))
    .select([Source.id])

  const outer = createTableBuilder({
    handle: Users,
    dialect: postgresDialect,
    query,
    executor,
  })
    .where(exists(inner))
    .select([Users.id])
    .compile()

  expect(outer.assertSession).toBeTypeOf('function')

  expect(() =>
    outer.assertSession?.({
      database: 'test',
      namespaceContext: { writableDefault: [{ role: 'schema', spelling: 'other' }] },
    }),
  ).toThrow(/schema.*public.*other/)
})
