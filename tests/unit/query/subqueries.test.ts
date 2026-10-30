import { nullable, number, string } from 'valibot'
import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import type { Dialect } from '@/dialects'
import {
  QueryError,
  alias,
  and,
  defineTable,
  eq,
  exists,
  inQuery,
  not,
  outer,
  postgresDialect,
  scalar,
  sqliteDialect,
} from '@/index'
import { createTableBuilder, createValueMapper } from '@/query'

const Users = defineTable(
  'sq_users',
  { id: number(), name: string(), managerId: nullable(number()) },
  { primaryKey: 'id' },
)

const Posts = defineTable(
  'sq_posts',
  { id: number(), userId: number(), title: string() },
  { primaryKey: 'id' },
)

function fixture(dialect: Dialect) {
  const executor = {
    execute: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    run: vi.fn<() => Promise<number>>().mockResolvedValue(0),
  }

  const query = dialect.query.resolve([Users, Posts])
  const from = <H extends Parameters<typeof createTableBuilder>[0]['handle']>(
    handle: H,
  ) => createTableBuilder({ handle, dialect, query, executor })

  return { from, executor, query }
}

for (const dialect of [postgresDialect, sqliteDialect]) {
  describe(`${dialect.id} subqueries`, () => {
    it('compiles correlated scalar, IN and EXISTS with ordered bindings and no execution', () => {
      const { from, executor } = fixture(dialect)

      const titles = from(Posts)
        .select([Posts.title])
        .where((b) =>
          b.and(b.eq(Posts.userId, b.outer(Users.id)), b.eq(Posts.title, 'inner')),
        )
        .limit(1)

      const ids = from(Posts)
        .select([Posts.userId])
        .where((b) => b.eq(Posts.title, 'ids'))

      const query = from(Users)
        .select((b) => [Users.id, b.as(b.scalar(titles), 'latest')])
        .where((b) =>
          b.and(
            b.inQuery(Users.id, ids),
            b.not(b.exists(ids)),
            b.eq(Users.name, 'outer'),
          ),
        )

      type Row = Awaited<ReturnType<typeof query.execute>>[number]
      expectTypeOf<Row>().toEqualTypeOf<{ id: number; latest: string | null }>()
      const compiled = query.compile()
      expect(compiled.params).toEqual(['inner', 1, 'ids', 'ids', 'outer'])
      expect(compiled.sql).toContain(' in (select ')
      expect(compiled.sql).toContain('exists (select ')
      expect(compiled.sql).toContain('"__stratom_q0"."id"')
      expect(query.compile()).toEqual(compiled)
      expect(executor.execute).not.toHaveBeenCalled()
      expect(Object.isFrozen(compiled)).toBe(true)
    })
  })

  describe(`${dialect.id} subquery validation`, () => {
    it('validates expanded projections and explicit scope lookup', () => {
      const { from } = fixture(dialect)
      const columns = [Posts.id, Posts.userId]
      const invalid = from(Posts).select(columns)

      expect(() =>
        from(Users)
          .where(exists(from(Posts).where(eq(Posts.userId, Users.id))))
          .compile(),
      ).toThrow(QueryError)

      expect(() =>
        from(Users)
          .select((b) => [b.as(scalar(invalid), 'bad')])
          .compile(),
      ).toThrow(/exactly one/)

      expect(() =>
        from(Posts)
          .where(eq(Posts.userId, outer(Users.id)))
          .compile(),
      ).toThrow(/Outer/)

      expect(() =>
        from(Users)
          .where(exists(from(Posts)))
          .compile(),
      ).not.toThrow()

      // @ts-expect-error implicit wildcard contains several projected values
      scalar(from(Posts))

      // @ts-expect-error explicit wildcard contains several projected values
      scalar(from(Posts).selectAll())

      // @ts-expect-error two statically selected values
      scalar(from(Posts).select([Posts.id, Posts.title]))

      // @ts-expect-error chained selections count both values
      scalar(from(Posts).select([Posts.id]).select([Posts.title]))

      // @ts-expect-error incompatible number/string scalar operands
      eq(Users.id, scalar(from(Posts).select([Posts.title])))

      // @ts-expect-error incompatible IN operands
      inQuery(Users.name, from(Posts).select([Posts.id]))

      // @ts-expect-error unknown aggregate results cannot compare with typed operands
      eq(Users.id, scalar(from(Posts).select((b) => [b.as(b.countAll(), 'count')])))
    })
  })

  describe(`${dialect.id} subquery scopes`, () => {
    it('supports aliases and multiple enclosing scopes without shadowing', () => {
      const { from } = fixture(dialect)
      const employee = alias(Users, 'employee')
      const manager = alias(Users, 'manager')

      const deep = from(Posts)
        .select([Posts.id])
        .where((b) => b.eq(Posts.userId, b.outer(employee.id)))

      const managers = from(manager).where((b) =>
        b.and(b.eq(manager.id, b.outer(employee.managerId)), b.exists(deep)),
      )

      expect(from(employee).where(exists(managers)).compile().sql).toContain(
        '"__stratom_q0"."managerId"',
      )

      expect(() =>
        from(employee)
          .innerJoin(alias(Users, 'employee'), eq(employee.id, employee.id))
          .select([employee.id])
          .compile(),
      ).toThrow(/Duplicate/)
    })

    it('supports scalar comparisons on either side and boolean composition', () => {
      const { from } = fixture(dialect)
      const id = scalar(from(Posts).select([Posts.id]).where(eq(Posts.title, 'x')))

      const compiled = from(Users)
        .where(
          and(
            eq(id, 3),
            eq(Users.id, id),
            eq(id, id),
            not(inQuery(Users.id, from(Posts).select([Posts.id]))),
          ),
        )
        .compile()

      expect(compiled.params).toEqual(['x', 3, 'x', 'x', 'x'])
    })

    it('rejects snapshots and different owners', () => {
      const { from } = fixture(dialect)
      const other = fixture(dialect)
      expect(() =>
        from(Users)
          .where(exists(other.from(Posts)))
          .compile(),
      ).toThrow(/client scope/)

      // @ts-expect-error snapshots are not builders
      expect(() => scalar(from(Posts).compile())).toThrow(/select builder/)
    })
  })
}

for (const dialect of [postgresDialect, sqliteDialect]) {
  describe(`${dialect.id} nested mapping`, () => {
    it('maps each reused predicate once and maps nested scalar results once while preserving NULL', async () => {
      const f = fixture(dialect)
      const mapParamValue = vi.fn<(type: string, value: unknown) => unknown>(
        (_, value) => `mapped:${String(value)}`,
      )

      const mapResultValue = vi.fn<(type: string, value: unknown) => unknown>(
        (_, value) => `result:${String(value)}`,
      )

      const mapper = createValueMapper(
        dialect,
        { mapParamValue, mapResultValue },
        [Users, Posts],
        f.query,
      )

      const from = mappedFrom(dialect, f, mapper)

      const inner = from(Posts).select([Posts.title]).where(eq(Posts.title, 'authored'))
      const middle = from(Users).select((b) => [b.as(scalar(inner), 'nested')])

      const query = from(Users)
        .select((b) => [b.as(scalar(middle), 'value')])
        .where(eq(scalar(inner), 'literal'))

      expect(query.compile().params).toEqual([
        'mapped:authored',
        'mapped:authored',
        'mapped:literal',
      ])

      expect(mapParamValue).toHaveBeenCalledTimes(3)
      mapParamValue.mockClear()

      expect(query.compile().params).toEqual([
        'mapped:authored',
        'mapped:authored',
        'mapped:literal',
      ])

      expect(mapParamValue).toHaveBeenCalledTimes(3)
      f.executor.execute.mockResolvedValueOnce([{ value: 'native' }, { value: null }])
      expect(await query.execute()).toEqual([{ value: 'result:native' }, { value: null }])
      expect(mapResultValue).toHaveBeenCalledTimes(1)
      const defect = new Error('mapping defect')
      mapResultValue.mockImplementation(() => {
        throw defect
      })

      f.executor.execute.mockResolvedValueOnce([{ value: 'native' }])
      await expect(query.execute()).rejects.toBe(defect)
    })
  })

  describe(`${dialect.id} subquery clause bindings`, () => {
    it('orders bindings across projections, JOIN ON, WHERE, HAVING and pagination', () => {
      const { from } = fixture(dialect)
      const employee = alias(Users, 'employee')
      const manager = alias(Users, 'manager')
      const id = (value: number) =>
        from(Posts).select([Posts.id]).where(eq(Posts.id, value)).limit(1)

      const query = from(employee)
        .select((b) => [b.as(scalar(id(1)), 'one')])
        .innerJoin(manager, (b) => b.eq(manager.id, b.scalar(id(2))))
        .where((b) => b.eq(employee.id, b.scalar(id(3))))
        .groupBy(employee.id)
        .having((b) => b.eq(employee.id, b.scalar(id(4))))
        .limit(5)
        .offset(6)

      const compiled = query.compile()
      expect(compiled.params).toEqual([1, 1, 2, 1, 3, 1, 4, 1, 5, 6])

      const positions = compiled.sql.match(/\$\d+|\?/g)
      expect(positions).toEqual(
        dialect.id === 'postgresql'
          ? ['$1', '$2', '$3', '$4', '$5', '$6', '$7', '$8', '$9', '$10']
          : Array(10).fill('?'),
      )

      const unavailable = from(Posts).where(eq(Posts.userId, outer(manager.id)))
      expect(() =>
        from(employee)
          .innerJoin(Posts, exists(unavailable))
          .innerJoin(manager, eq(manager.id, employee.id))
          .select([employee.id])
          .compile(),
      ).toThrow(/Outer/)
    })
  })
}

function mappedFrom(
  dialect: Dialect,
  f: ReturnType<typeof fixture>,
  mapper: ReturnType<typeof createValueMapper>,
) {
  return <H extends Parameters<typeof createTableBuilder>[0]['handle']>(handle: H) =>
    createTableBuilder({ handle, dialect, query: f.query, executor: f.executor, mapper })
}

it('retains inner-only PostgreSQL guards in immutable snapshots', () => {
  const Guarded = defineTable(
    'guarded',
    { id: number() },
    {
      primaryKey: 'id',
      namespace: [
        { role: 'database', spelling: 'required' },
        { role: 'schema', spelling: 'tenant' },
      ],
    },
  )

  const f = fixture(postgresDialect)
  const query = postgresDialect.query.resolve([Users, Guarded])

  const inner = createTableBuilder({
    handle: Guarded,
    dialect: postgresDialect,
    query,
    executor: f.executor,
  }).select([Guarded.id])

  const outer = createTableBuilder({
    handle: Users,
    dialect: postgresDialect,
    query,
    executor: f.executor,
  }).where(exists(inner))

  const compiled = outer.compile()
  expect(() => compiled.assertSession?.({ database: 'wrong' })).toThrow(/required/)
  expect(() => compiled.assertSession?.({ database: 'required' })).not.toThrow()
  outer.where(eq(Users.id, 5)).compile()
  expect(compiled.params).toEqual([])
  expect(() => compiled.assertSession?.({ database: 'wrong' })).toThrow(/required/)
})

it('infers aliases, scalar values and joined column nullability', () => {
  const { from } = fixture(postgresDialect)

  const named = from(Users).select((b) => [
    b.as(Users.name, 'renamed'),
    b.as(scalar(from(Posts).select([Posts.id])), 'postId'),
  ])

  type Named = Awaited<ReturnType<typeof named.execute>>[number]
  expectTypeOf<Named>().toEqualTypeOf<{ renamed: string; postId: number | null }>()

  const joined = from(Users)
    .leftJoin(Posts, eq(Users.id, Posts.userId))
    .select((b) => [b.as(Posts.title, 'title')])

  type Joined = Awaited<ReturnType<typeof joined.execute>>[number]
  expectTypeOf<Joined>().toEqualTypeOf<{ title: string | null }>()
})

it('validates dynamic projection counts without collapsing duplicate output names', () => {
  const { from } = fixture(postgresDialect)
  const columns: (typeof Posts.id | typeof Posts.userId)[] = [Posts.id]
  const dynamic = from(Posts).select(columns)
  expect(() =>
    from(Users)
      .where(eq(Users.id, scalar(dynamic)))
      .compile(),
  ).not.toThrow()

  const duplicate = [Posts.id, Posts.id]
  expect(() =>
    from(Users)
      .where(eq(Users.id, scalar(from(Posts).select(duplicate))))
      .compile(),
  ).toThrow(/exactly one/)

  expect(() =>
    from(Users)
      .where(exists(from(Posts).select(duplicate)))
      .compile(),
  ).not.toThrow()
})
