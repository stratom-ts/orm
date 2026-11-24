import {
  any,
  bigint,
  boolean,
  brand,
  date,
  exactOptional,
  integer,
  isoTime,
  isoTimeSecond,
  literal,
  maxValue,
  minValue,
  nullable,
  nullish,
  number,
  object,
  optional,
  picklist,
  pipe,
  string,
  transform,
  undefinedable,
} from 'valibot'
import { expect, expectTypeOf, it, vi } from 'vitest'

import type { Dialect, TableHandle } from '@/index'
import {
  QueryError,
  alias,
  column,
  defineTable,
  eq,
  exists,
  inQuery,
  outer,
  postgresDialect,
  reference,
  scalar,
  sqliteDialect,
} from '@/index'
import { createTableBuilder, createValueMapper } from '@/query'
import type { ValueMapConfig } from '@/query'

const A = defineTable(
  'set_a',
  {
    id: number(),
    text: string(),
    email: string(),
    flag: boolean(),
    created: date(),
    big: bigint(),
    json: object({ value: string() }),
  },
  { primaryKey: 'id' },
)

const B = defineTable(
  'set_b',
  {
    id: number(),
    text: string(),
    email: nullable(string()),
    flag: boolean(),
    created: date(),
    big: bigint(),
    json: object({ value: string() }),
  },
  { primaryKey: 'id' },
)

const Integer = defineTable(
  'set_integer',
  { id: pipe(number(), integer()) },
  { primaryKey: 'id' },
)

const Hook = defineTable(
  'set_hook',
  { id: pipe(number(), column({ mapResult: (value) => value })) },
  { primaryKey: 'id' },
)

const Mapped = defineTable(
  'set_mapped',
  { id: pipe(number(), column({ mapParam: (value) => Number(value) + 10 })) },
  { primaryKey: 'id' },
)

const Renamed = defineTable(
  'set_renamed',
  { id: pipe(number(), column({ name: 'physical_id' })) },
  { primaryKey: 'id' },
)

const Omitted = defineTable(
  'set_omitted',
  {
    id: number(),
    text: pipe(
      optional(string()),
      column({ databaseDefault: { kind: 'literal', value: '' } }),
    ),
    exact: pipe(
      exactOptional(string()),
      column({ databaseDefault: { kind: 'literal', value: '' } }),
    ),
    undefinedable: pipe(
      undefinedable(string()),
      column({ databaseDefault: { kind: 'literal', value: '' } }),
    ),
    nullish: nullish(string()),
  },
  { primaryKey: 'id' },
)

const tables = [A, B, Integer, Hook, Mapped, Renamed, Omitted]

function fixture(dialect: Dialect, map?: ValueMapConfig) {
  const query = dialect.query.resolve(tables)
  const executor = {
    execute: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    run: vi.fn<() => Promise<number>>().mockResolvedValue(0),
  }

  const mapper = createValueMapper(dialect, map, tables, query)
  const from = <H extends TableHandle>(handle: H) =>
    createTableBuilder({ handle, dialect, query, executor, mapper })

  return { from, executor, mapper }
}

// Models a JavaScript caller with no compile-time selection evidence.
function dynamic(query: object) {
  return query as {
    union(other: object): { compile(): unknown }
    orderBy(name: unknown): { compile(): unknown }
  }
}

for (const dialect of [postgresDialect, sqliteDialect]) {
  it('should compare SQL result types independently of write omission', () => {
    const { from } = fixture(dialect)
    const required = from(A).select([A.text])
    const omitted = from(Omitted).select([Omitted.text])
    expect(() => required.unionAll(omitted).compile()).not.toThrow()
    expect(() => omitted.unionAll(required).compile()).not.toThrow()

    expectTypeOf(required.unionAll(omitted).execute()).toEqualTypeOf<
      Promise<{ text: string }[]>
    >()

    for (const column of [Omitted.exact, Omitted.undefinedable, Omitted.nullish]) {
      const other = from(Omitted).select((e) => [e.as(column, 'text')])
      expect(() => required.unionAll(other).compile()).not.toThrow()
    }
  })

  it('should preserve case-distinct outputs and avoid reserved SQL alias collisions', async () => {
    const { from, executor } = fixture(dialect)
    const longName = 'x'.repeat(80)

    const a = from(A).select((e) => [
      e.as(A.id, 'x'),
      e.as(A.text, 'X'),
      e.as(A.email, '__STRATOM_C0'),
      e.as(A.id, longName),
    ])

    const query = a.unionAll(a).orderBy('X')
    expect(query.compile().sql).toContain('order by "__stratom_c1" asc')

    executor.execute.mockResolvedValue([
      { x: 1, __stratom_c1: 'text', __STRATOM_C0: 'email', __stratom_c2: 1 },
    ])

    expect(await query.execute()).toEqual([
      { x: 1, X: 'text', __STRATOM_C0: 'email', [longName]: 1 },
    ])
  })

  it('should preserve operand clauses, nested trees, bindings and immutable snapshots', () => {
    const { from, executor } = fixture(dialect)

    const a = from(A).select([A.id]).where(A.id, 'eq', 1).orderBy(A.id).limit(2).offset(3)

    const b = from(B).select([B.id]).where(B.id, 'eq', 4)
    const before = a.compile()
    const compound = a.unionAll(b).orderBy('id', 'desc', 'last').limit(5).offset(6)
    const compiled = compound.except(b.limit(7)).compile()
    expect(compiled.params).toEqual([1, 2, 3, 4, 5, 6, 4, 7])
    expect(compiled.sql).toContain(' union all ')
    expect(compiled.sql).toContain(' except ')
    expect(compiled.sql).toContain('order by "id" desc nulls last')
    expect(compound.compile()).toEqual(compound.compile())
    expect(a.compile()).toEqual(before)
    expect(Object.isFrozen(compiled)).toBe(true)
    expect(Object.isFrozen(compiled.params)).toBe(true)
    expect(executor.execute).not.toHaveBeenCalled()

    expect(compiled.sql.match(/\$\d+/g) ?? []).toEqual(
      dialect === postgresDialect ? Array.from({ length: 8 }, (_, i) => `$${i + 1}`) : [],
    )

    expect(Object.keys(compound).sort()).toEqual(
      [
        'union',
        'unionAll',
        'intersect',
        'except',
        'orderBy',
        'limit',
        'offset',
        'compile',
        'execute',
        'executeTakeFirst',
        'executeTakeFirstOrThrow',
      ].sort(),
    )
  })

  it('should validate runtime shapes, storage, mappings and output ordering before SQL', () => {
    const { from, executor } = fixture(dialect)
    const a = from(A).select([A.id])
    for (const other of [
      from(A).select([A.id, A.text]),
      from(A).select([A.text]),
      from(Integer),
      from(Hook),
    ]) {
      expect(() => dynamic(a).union(other).compile()).toThrow(QueryError)
    }

    expect(() =>
      dynamic(from(A).select([A.id, A.text]))
        .union(from(B).select([B.text, B.id]))
        .compile(),
    ).toThrow(/name and order/)

    expect(() => dynamic(a.union(a)).orderBy(A.id).compile()).toThrow(
      /selected output name/,
    )

    expect(() => dynamic(a.union(a)).orderBy('missing').compile()).toThrow(
      /selected output name/,
    )

    expect(() =>
      dynamic(from(A).select([A.id, A.id]))
        .union(from(B).select([B.id, B.id]))
        .compile(),
    ).toThrow(/ambiguous/)

    expect(() =>
      fixture(dialect, { mapResultValue: (_type, value) => value })
        .from(A)
        .union(fixture(dialect).from(A)),
    ).toThrow(/client scope/)

    const custom = fixture(dialect, { mapResultValue: (_type, value) => value })
    expect(() => custom.from(A).union(custom.from(A)).compile()).toThrow(
      /custom result mappings/,
    )

    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('should compile scalar, IN, EXISTS and explicit outer correlations with sibling scopes', () => {
    const { from } = fixture(dialect)

    const ids = from(B)
      .select([B.id])
      .where((b) => b.eq(B.id, b.outer(A.id)))

    const compound = ids.unionAll(ids).limit(1)

    const compiled = from(A)
      .select((b) => [b.as(scalar(compound), 'value')])
      .where(inQuery(A.id, compound))
      .where(exists(compound))
      .compile()

    expect(compiled.sql).toContain(' union all ')
    expect(compiled.params).toEqual([1, 1, 1])

    expect(() =>
      from(A)
        .select([A.id])
        .union(from(B).select([B.id]).where(eq(B.id, A.id)))
        .compile(),
    ).toThrow(QueryError)

    expect(() =>
      from(A)
        .select([A.id])
        .union(
          from(B)
            .select([B.id])
            .where(eq(B.id, outer(A.id))),
        )
        .compile(),
    ).toThrow(/enclosing scope/)

    expect(() => from(A).where(exists(from(A).union(fixture(dialect).from(A))))).toThrow(
      /client scope/,
    )
  })

  it('should map predicate parameters once per occurrence and preserve SQL nulls', async () => {
    const hooks = vi.fn<(type: string, value: unknown) => number>(
      (_type, value) => Number(value) + 1,
    )

    const { from, executor, mapper } = fixture(dialect, { mapParamValue: hooks })
    const resultMapping = vi.spyOn(mapper, 'mapResultValue')
    const branch = from(Mapped).where(Mapped.id, 'eq', 1)
    const compound = branch.unionAll(from(A).select([A.id]).where(A.id, 'eq', 3))
    expect(compound.compile().params).toEqual([11, 4])
    expect(hooks).toHaveBeenCalledTimes(1)
    executor.execute.mockResolvedValue([{ id: null }, { id: 2 }])
    expect(await compound.execute()).toEqual([{ id: null }, { id: 2 }])
    expect(resultMapping.mock.calls).toEqual([[Mapped, 'id', 2]])
    expect(executor.execute).toHaveBeenCalledTimes(1)
  })

  it('should retain bounded aliases, physical column names and empty-result conventions', async () => {
    const { from, executor } = fixture(dialect)
    const name = 'quoted"' + 'x'.repeat(80)
    const a = from(A).select((b) => [b.as(A.id, name)])
    const b = from(Renamed).select((b) => [b.as(Renamed.id, name)])
    const query = a.unionAll(b).orderBy(name)
    const compiled = query.compile()
    expect(compiled.sql).toContain('"physical_id"')
    expect(compiled.sql).toContain('order by "__stratom_c0" asc')
    executor.execute.mockResolvedValue([{ __stratom_c0: 1 }])
    expect(await query.execute()).toEqual([{ [name]: 1 }])
    executor.execute.mockResolvedValue([])
    expect(await query.executeTakeFirst()).toBeUndefined()
    await expect(query.executeTakeFirstOrThrow()).rejects.toThrow(/No rows/)

    for (const count of [
      -1,
      1.5,
      NaN,
      Infinity,
      ...(dialect === sqliteDialect ? [Number.MAX_SAFE_INTEGER + 1] : []),
    ]) {
      expect(() => query.limit(count).compile()).toThrow(QueryError)
      expect(() => query.offset(count).compile()).toThrow(QueryError)
    }

    expect(query.limit(1).limit(2).offset(3).offset(4).compile().params).toEqual([2, 4])
  })
}

it('should widen only SQL nullability and preserve EXCEPT left types', () => {
  const { from } = fixture(postgresDialect)
  const a = from(A).select([A.email])
  const b = from(B).select([B.email])
  expectTypeOf(a.union(b).execute()).toEqualTypeOf<Promise<{ email: string | null }[]>>()
  expectTypeOf(b.union(a).execute()).toEqualTypeOf<Promise<{ email: string | null }[]>>()

  expectTypeOf(a.unionAll(b).execute()).toEqualTypeOf<
    Promise<{ email: string | null }[]>
  >()

  expectTypeOf(a.intersect(b).execute()).toEqualTypeOf<
    Promise<{ email: string | null }[]>
  >()

  expectTypeOf(a.except(b).execute()).toEqualTypeOf<Promise<{ email: string }[]>>()
  expectTypeOf(b.except(a).execute()).toEqualTypeOf<Promise<{ email: string | null }[]>>()
  const text = from(A).select([A.text])
  const joined = from(A).leftJoin(B, eq(A.id, B.id)).select([B.text])
  expectTypeOf(text.union(joined).execute()).toEqualTypeOf<
    Promise<{ text: string | null }[]>
  >()

  expectTypeOf(joined.union(text).execute()).toEqualTypeOf<
    Promise<{ text: string | null }[]>
  >()

  expectTypeOf(text.except(joined).execute()).toEqualTypeOf<Promise<{ text: string }[]>>()

  const scalarText = from(A).select((e) => [
    e.as(e.scalar(from(B).select([B.text])), 'text'),
  ])

  expectTypeOf(text.union(scalarText).execute()).toEqualTypeOf<
    Promise<{ text: string | null }[]>
  >()

  expectTypeOf(scalarText.union(text).execute()).toEqualTypeOf<
    Promise<{ text: string | null }[]>
  >()

  expectTypeOf(text.except(scalarText).execute()).toEqualTypeOf<
    Promise<{ text: string }[]>
  >()

  const aliased = alias(A, 'other')
  expectTypeOf(from(A).union(from(aliased)).execute()).toEqualTypeOf<
    ReturnType<ReturnType<typeof from<typeof A>>['execute']>
  >()
})

it('should reject known type and shape mismatches statically', () => {
  const { from } = fixture(postgresDialect)
  const a = from(A).select([A.email])
  const b = from(B).select([B.email])
  const Literal = defineTable('set_literal', { id: literal(1) }, { primaryKey: 'id' })
  const Branded = defineTable(
    'set_branded',
    { id: pipe(number(), brand('id')) },
    { primaryKey: 'id' },
  )

  const Unknown = defineTable('set_unknown', { id: any() }, { primaryKey: 'id' })
  const Json = defineTable(
    'set_json',
    { json: object({ other: number() }) },
    { primaryKey: 'json' },
  )

  expectTypeOf(() => {
    // @ts-expect-error literal and broad non-null types differ
    from(A).select([A.id]).union(from(Literal))

    // @ts-expect-error branded and broad non-null types differ
    from(A).select([A.id]).union(from(Branded))

    // @ts-expect-error any is no type evidence
    from(A).select([A.id]).union(from(Unknown))

    // @ts-expect-error structured JSON types differ
    from(A).select([A.json]).union(from(Json))

    // @ts-expect-error different non-null types
    a.union(from(B).select([B.id]))

    // @ts-expect-error same name but different type
    a.union(from(B).select((e) => [e.as(B.id, 'email')]))

    from(A)
      .select([A.id, A.text])
      // @ts-expect-error known projection order differs
      .union(from(B).select([B.text, B.id]))

    // @ts-expect-error compound ordering accepts output names only
    a.union(b).orderBy(A.email)

    // @ts-expect-error unknown output name
    a.union(b).orderBy('id')

    // @ts-expect-error compound has no where
    void a.union(b).where

    // @ts-expect-error unknown expression is no type evidence
    a.union(from(A).select((e) => [e.as(e.countAll(), 'email')]))
  }).toBeFunction()
})

it('should reject same-storage temporal formats with different result contracts', () => {
  const Minutes = defineTable(
    'set_minutes',
    { value: pipe(string(), isoTime()) },
    { primaryKey: 'value' },
  )

  const Seconds = defineTable(
    'set_seconds',
    { value: pipe(string(), isoTimeSecond()) },
    { primaryKey: 'value' },
  )

  const handles = [Minutes, Seconds]
  const dialect = postgresDialect
  const query = dialect.query.resolve(handles)
  const mapper = createValueMapper(dialect, undefined, handles, query)
  const executor = { execute: async () => [], run: async () => 0 }
  const a = createTableBuilder({ handle: Minutes, dialect, query, mapper, executor })
  const b = createTableBuilder({ handle: Seconds, dialect, query, mapper, executor })
  expect(() => a.union(b).compile()).toThrow(/value.*representation/)
})

it('should accept compatible accumulated and direct projection tuples', () => {
  const { from } = fixture(postgresDialect)
  const a = from(A).select([A.id, A.text])
  const b = from(B).select([B.id]).select([B.text])
  expectTypeOf(a.union(b).execute()).toEqualTypeOf<
    Promise<{ id: number; text: string }[]>
  >()

  expectTypeOf(b.union(a).execute()).toEqualTypeOf<
    Promise<{ id: number; text: string }[]>
  >()
})

it('should reject inherited TIME storage with different authored reference output formats', () => {
  const Parent = defineTable(
    'set_time_parent',
    { value: pipe(string(), isoTime()) },
    { primaryKey: 'value' },
  )

  const Child = defineTable(
    'set_time_child',
    {
      value: pipe(
        reference(Parent, 'value'),
        transform((value) => `${value}:00`),
        string(),
        isoTimeSecond(),
      ),
    },
    { primaryKey: 'value' },
  )

  const handles = [Parent, Child]
  const dialect = postgresDialect
  const query = dialect.query.resolve(handles)
  const mapper = createValueMapper(dialect, undefined, handles, query)
  const executor = { execute: async () => [], run: async () => 0 }
  const a = createTableBuilder({ handle: Parent, dialect, query, mapper, executor })
  const b = createTableBuilder({ handle: Child, dialect, query, mapper, executor })
  expect(() => a.union(b).compile()).toThrow(/value.*representation/)
  expect(() => b.union(a).compile()).toThrow(/value.*representation/)
})

it('should order nested scalar predicate bindings before branch and compound pagination', () => {
  const { from } = fixture(postgresDialect)
  const nested = from(B).select([B.id]).where(B.id, 'eq', 7).limit(1)

  const a = from(A)
    .select([A.id])
    .where((e) => e.eq(A.id, e.scalar(nested)))
    .limit(2)

  const b = from(B).select([B.id]).where(B.id, 'eq', 8).offset(3)
  expect(a.unionAll(b).limit(4).compile().params).toEqual([7, 1, 2, 8, 3, 4])
})

it('should accept equivalent finite choices and numeric constraints in either authoring order', () => {
  const One = defineTable(
    'set_choices_one',
    { value: picklist(['first', 'second']) },
    { primaryKey: 'value' },
  )

  const Two = defineTable(
    'set_choices_two',
    { value: picklist(['second', 'first']) },
    { primaryKey: 'value' },
  )

  const MinMax = defineTable(
    'set_min_max',
    { value: pipe(number(), minValue(0), maxValue(10)) },
    { primaryKey: 'value' },
  )

  const MaxMin = defineTable(
    'set_max_min',
    { value: pipe(number(), maxValue(10), minValue(0)) },
    { primaryKey: 'value' },
  )

  const Literal = defineTable(
    'set_nullable_literal',
    { id: number(), value: literal('first') },
    { primaryKey: 'id' },
  )

  const Nullable = defineTable(
    'set_nullable_choice',
    { id: number(), value: nullable(literal('first')) },
    { primaryKey: 'id' },
  )

  const handles = [One, Two, MinMax, MaxMin, Literal, Nullable]
  for (const dialect of [postgresDialect, sqliteDialect]) {
    const query = dialect.query.resolve(handles)
    const mapper = createValueMapper(dialect, undefined, handles, query)
    const executor = { execute: async () => [], run: async () => 0 }
    const from = <H extends TableHandle>(handle: H) =>
      createTableBuilder({ handle, dialect, query, mapper, executor })

    expect(() => from(One).union(from(Two)).compile()).not.toThrow()
    expect(() => from(Two).union(from(One)).compile()).not.toThrow()
    expect(() => from(MinMax).union(from(MaxMin)).compile()).not.toThrow()
    expect(() => from(Literal).union(from(Nullable)).compile()).not.toThrow()
    expect(() => from(Nullable).union(from(Literal)).compile()).not.toThrow()
  }
})
