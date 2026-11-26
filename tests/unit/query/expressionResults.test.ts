import {
  any,
  bigint,
  boolean,
  brand,
  date,
  integer,
  literal,
  nullable,
  number,
  pipe,
  string,
  union,
  unknown,
} from 'valibot'
import { expect, expectTypeOf, it, vi } from 'vitest'

import type { Dialect } from '@/index'
import {
  alias,
  column,
  createDatabase,
  defineTable,
  eq,
  inQuery,
  max,
  postgresDialect,
  scalar,
  sqliteDialect,
  sum,
} from '@/index'
import { createTableBuilder, createValueMapper } from '@/query'

import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

const Rows = defineTable(
  'expression_rows',
  {
    id: number(),
    integer: pipe(number(), integer()),
    big: bigint(),
    label: string(),
    maybe: nullable(string()),
    created: date(),
    one: literal(1),
  },
  { primaryKey: 'id' },
)

const Branded = defineTable(
  'branded_expression',
  { token: pipe(string(), brand('Token')) },
  { primaryKey: 'token' },
)

function setup(dialect: 'postgresql' | 'sqlite', rows: () => unknown[] = () => []) {
  const controls = createControllableProvider({ queryRows: rows })
  const db = createDatabase({
    connector: customConnector(dialect),
    schemas: [Rows],
    operationSessionProvider: controls.provider,
  })

  return { db, controls }
}

it('should infer helper results, aliases, refinements, nullable operands and scalar nullability', () => {
  const { db } = setup('postgresql')

  const query = db
    .from(Rows)
    .select((b) => [
      b.as(b.countAll(), 'all'),
      b.as(b.count(Rows.maybe), 'n'),
      b.as(b.min(Rows.one), 'min'),
      b.as(b.max(Branded.token), 'token'),
      b.as(b.sum(Rows.one), 'sum'),
      b.as(b.sum(Rows.big), 'big'),
      b.as(b.lower(Branded.token), 'lower'),
      b.as(b.upper(Rows.maybe), 'upper'),
      b.as(b.length(Rows.label), 'length'),
      b.as(b.now(), 'now'),
      b.as(b.dateTrunc('day', Rows.created), 'day'),
    ])

  expectTypeOf<ReturnType<typeof query.execute>>().toEqualTypeOf<
    Promise<
      {
        all: number
        n: number
        min: 1 | null
        token: typeof Branded.token.__type | null
        sum: number | null
        big: bigint | null
        lower: string
        upper: string | null
        length: number
        now: Date
        day: Date
      }[]
    >
  >()

  const counts = db.from(Rows).select((b) => [b.as(b.countAll(), 'n')])
  const wrapped = scalar(counts)
  expectTypeOf<typeof wrapped.__value>().toEqualTypeOf<number | null | undefined>()
  eq(Rows.id, scalar(counts))
  eq(scalar(counts), 0)
  inQuery(Rows.id, counts)
})

it('should reject invalid operand families and incompatible compositions statically', () => {
  const { db } = setup('postgresql')
  const counts = db.from(Rows).select((b) => [b.as(b.countAll(), 'n')])
  expectTypeOf(() => {
    // @ts-expect-error numeric columns are not string operands
    db.from(Rows).select((b) => [b.as(b.lower(Rows.id), 'lower')])

    // @ts-expect-error bigint columns are not string operands
    db.from(Rows).select((b) => [b.as(b.length(Rows.big), 'length')])

    // @ts-expect-error dates cannot be summed
    sum(Rows.created)

    // @ts-expect-error strings cannot be summed
    sum(Rows.label)

    // @ts-expect-error string/date scalar incompatibility
    eq(Rows.label, scalar(db.from(Rows).select((b) => [b.as(b.now(), 'date')])))

    // @ts-expect-error incompatible IN output
    inQuery(Rows.label, counts)

    // @ts-expect-error arbitrary text is not a Date operand
    db.from(Rows).select((b) => [b.as(b.dateTrunc('day', Rows.label), 'day')])
    const Other = defineTable(
      'unknown_operands',
      {
        mixed: union([number(), bigint()]),
        unknown: unknown(),
        any: any(),
        flag: boolean(),
      },
      { primaryKey: 'mixed' },
    )

    // @ts-expect-error mixed numeric families have no single sum contract
    sum(Other.mixed)

    // @ts-expect-error unknown output cannot promise a numeric sum
    sum(Other.unknown)

    // @ts-expect-error any output cannot promise a numeric sum
    sum(Other.any)

    // @ts-expect-error booleans are not ordered scalar operands
    max(Other.flag)
    const mixed = Math.random() ? Rows.id : Rows.big

    // @ts-expect-error a union of references still needs one numeric family
    sum(mixed)
    const invalid = Math.random() ? Rows.id : Rows.label

    // @ts-expect-error every possible operand must be numeric
    sum(invalid)

    // @ts-expect-error every possible operand must be text
    db.from(Rows).select((b) => [b.as(b.lower(invalid), 'lower')])
  }).toBeFunction()
})

it('should keep string-name and untyped AST results unknown', () => {
  const { db } = setup('postgresql')

  const query = db
    .from(Rows)
    .select((b) => [
      b.as(b.lower('label'), 'lower'),
      b.as({ kind: 'sum', arg: { kind: 'column', column: 'id' } }, 'raw'),
      b.as(b.count('id'), 'n'),
    ])

  expectTypeOf<ReturnType<typeof query.execute>>().toEqualTypeOf<
    Promise<{ lower: unknown; raw: unknown; n: number }[]>
  >()
})

it('should track nullable outer-join operands before and after selection, including CTE columns', () => {
  const { db } = setup('postgresql')
  const other = alias(Rows, 'other')

  const before = db
    .from(Rows)
    .leftJoin(other, eq(Rows.id, other.id))
    .select((b) => [b.as(b.lower(other.label), 'label'), b.as(b.count(other.id), 'n')])

  const after = db
    .from(Rows)
    .select((b) => [b.as(b.lower(Rows.label), 'label'), b.as(b.countAll(), 'n')])
    .rightJoin(other, eq(Rows.id, other.id))

  expectTypeOf<ReturnType<typeof before.execute>>().toEqualTypeOf<
    Promise<{ label: string | null; n: number }[]>
  >()

  expectTypeOf<
    Awaited<ReturnType<typeof after.execute>>[number]['label']
  >().toEqualTypeOf<string | null>()

  expectTypeOf<
    Awaited<ReturnType<typeof after.execute>>[number]['n']
  >().toEqualTypeOf<number>()

  const cte = db.cte('names', db.from(Rows).select([Rows.id, Rows.label]))

  const joined = db
    .with(cte)
    .from(Rows)
    .leftJoin(cte, eq(Rows.id, cte.id))
    .select((b) => [b.as(b.length(cte.label), 'length')])

  expectTypeOf<ReturnType<typeof joined.execute>>().toEqualTypeOf<
    Promise<{ length: number | null }[]>
  >()
})

it('should preserve computed nullability after wildcard selections and a later right join', () => {
  const { db } = setup('postgresql')
  const other = alias(Rows, 'wildcard_other')

  const query = db
    .from(Rows)
    .selectAll()
    .select((b) => [b.as(b.lower(Rows.label), 'normalized')])
    .rightJoin(other, eq(Rows.id, other.id))

  expectTypeOf<
    Awaited<ReturnType<typeof query.execute>>[number]['normalized']
  >().toEqualTypeOf<string | null>()
})

for (const dialect of ['postgresql', 'sqlite'] as const) {
  it(`should ${dialect}: adapts built-in driver values once through set, CTE, alias and scalar composition`, async () => {
    const { db, controls } = setup(dialect, () => [
      { n: dialect === 'postgresql' ? '2' : 2n },
    ])

    const branch = db.from(Rows).select((b) => [b.as(b.countAll(), 'n')])
    const cte = db.cte('counts', branch.unionAll(branch))
    const named = alias(cte, 'named')

    const selected = db
      .with(cte)
      .from(named)
      .select((b) => [b.as(b.scalar(db.from(named).select([named.n]).limit(1)), 'n')])
      .where((b) => b.gt(b.scalar(branch), 0))

    expectTypeOf<ReturnType<typeof selected.execute>>().toEqualTypeOf<
      Promise<{ n: number | null }[]>
    >()

    for (const compiled of [selected.compile(), selected.compile()]) {
      expect(compiled.params).toEqual([1, 0])
      expect(compiled.sql).toContain('union all')
      expect(compiled.sql).toContain('count(*)')
    }

    expect(controls.calls).toEqual([])
    expect(await selected.execute()).toEqual([{ n: 2 }])
    expect(await selected.execute()).toEqual([{ n: 2 }])
    expect(controls.calls).toHaveLength(2)
    await db.close()
  })

  it(`should ${dialect}: maps computed CTE parameters using text rather than source refinements`, () => {
    const { db } = setup(dialect)
    const names = db.cte(
      'names',
      db.from(Rows).select((b) => [b.as(b.lower(Rows.label), 'normalizedName')]),
    )

    const query = db.with(names).from(names).where(eq(names.normalizedName, 'abc'))
    expect(query.compile().params).toEqual(['abc'])

    expect(() =>
      db
        .with(names)
        .from(Rows)
        .where(inQuery(Rows.label, db.from(names).select([names.normalizedName])))
        .compile(),
    ).not.toThrow()

    const lower = db.from(Rows).select((b) => [b.as(b.lower(Rows.label), 'label')])
    const upper = db.from(Rows).select((b) => [b.as(b.upper(Rows.label), 'label')])
    expect(() => lower.unionAll(upper).compile()).not.toThrow()
  })

  it(`should ${dialect}: rejects unsafe integers, preserves bigint widening, and bypasses aggregate NULL`, async () => {
    let native: unknown = '9007199254740993'
    const { db } = setup(dialect, () => [{ value: native }])
    const counts = db.from(Rows).select((b) => [b.as(b.countAll(), 'value')])
    await expect(counts.execute()).rejects.toThrow(/safely/)
    const sums = db.from(Rows).select((b) => [b.as(b.sum(Rows.integer), 'value')])
    await expect(sums.execute()).rejects.toThrow(/safely/)
    const big = db.from(Rows).select((b) => [b.as(b.sum(Rows.big), 'value')])
    expect(await big.execute()).toEqual([{ value: 9007199254740993n }])
    native = null
    expect(await sums.execute()).toEqual([{ value: null }])
    native = 1e20

    await expect(
      db
        .from(Rows)
        .select((b) => [b.as(b.sum(Rows.id), 'value')])
        .execute(),
    ).rejects.toThrow(/safely/)

    native = Number.POSITIVE_INFINITY

    await expect(
      db
        .from(Rows)
        .select((b) => [b.as(b.sum(Rows.id), 'value')])
        .execute(),
    ).rejects.toThrow(/safely/)

    await db.close()
  })

  it(`should ${dialect}: preserves extrema source hooks, null bypass, and decoder defect identity`, async () => {
    const decode = vi.fn<(value: unknown) => number>((value) => Number(value) - 10)
    const encode = vi.fn<(value: unknown) => number>((value) => Number(value) + 10)
    const Mapped = defineTable(
      'mapped_extrema',
      { id: pipe(number(), column({ mapResult: decode, mapParam: encode })) },
      { primaryKey: 'id' },
    )

    let value: unknown = 12
    const controls = createControllableProvider({ queryRows: () => [{ value }] })
    const db = createDatabase({
      connector: customConnector(dialect),
      schemas: [Mapped],
      operationSessionProvider: controls.provider,
    })

    const maximum = db.from(Mapped).select((b) => [b.as(b.max(Mapped.id), 'value')])
    maximum.compile()
    maximum.compile()

    expect(
      await db
        .from(Mapped)
        .select((b) => [b.as(b.count(Mapped.id), 'value')])
        .execute(),
    ).toEqual([{ value: 12 }])

    expect(decode).not.toHaveBeenCalled()
    const compared = db.from(Mapped).where((b) => b.eq(b.scalar(maximum), 2))
    expect(compared.compile().params).toEqual([12])
    expect(encode).toHaveBeenCalledTimes(1)
    expect(await maximum.execute()).toEqual([{ value: 2 }])
    expect(decode).toHaveBeenCalledExactlyOnceWith(12)
    const cte = db.cte('max_value', maximum)

    const nested = db
      .with(cte)
      .from(Mapped)
      .select((b) => [b.as(b.scalar(db.from(cte).select([cte.value])), 'value')])

    expect(await nested.execute()).toEqual([{ value: 2 }])
    expect(await nested.execute()).toEqual([{ value: 2 }])
    expect(decode.mock.calls).toEqual([[12], [12], [12]])
    value = null
    expect(await maximum.execute()).toEqual([{ value: null }])
    expect(decode).toHaveBeenCalledTimes(3)

    const failure = new Error('decoder defect')
    decode.mockImplementation(() => {
      throw failure
    })

    value = 12
    await expect(maximum.execute()).rejects.toBe(failure)
    await db.close()
  })

  it(`should ${dialect}: reject transformed custom encodings without invoking hooks`, () => {
    const hook = vi.fn<(value: unknown) => unknown>((value) => value)
    const Encoded = defineTable(
      'encoded_expressions',
      {
        id: pipe(number(), column({ mapParam: hook, mapResult: hook })),
        text: pipe(string(), column({ mapParam: hook, mapResult: hook })),
      },
      { primaryKey: 'id' },
    )

    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(dialect),
      schemas: [Encoded],
      operationSessionProvider: controls.provider,
    })

    expect(() =>
      db
        .from(Encoded)
        .select((b) => [b.as(b.sum(Encoded.id), 'sum')])
        .compile(),
    ).toThrow(/standard mappings/)

    expect(() =>
      db
        .from(Encoded)
        .select((b) => [b.as(b.lower(Encoded.text), 'text')])
        .compile(),
    ).toThrow(/standard mappings/)

    const maximum = db.from(Encoded).select((b) => [b.as(b.max(Encoded.id), 'id')])
    expect(() => maximum.unionAll(maximum).compile()).toThrow(/custom result mappings/)
    expect(hook).not.toHaveBeenCalled()
    expect(controls.calls).toEqual([])
  })

  it(`should allow discarded custom-mapped expression outputs in ${dialect} EXISTS`, () => {
    const hook = vi.fn<(value: unknown) => unknown>((value) => value)
    const Encoded = defineTable(
      'discarded_expressions',
      { id: pipe(number(), column({ mapParam: hook, mapResult: hook })) },
      { primaryKey: 'id' },
    )

    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(dialect),
      schemas: [Encoded],
      operationSessionProvider: controls.provider,
    })

    const inner = db.from(Encoded).select((b) => [b.as(b.sum(Encoded.id), 'sum')])
    expect(() => inner.compile()).toThrow(/standard mappings/)

    const compiled = db
      .from(Encoded)
      .where((b) => b.exists(inner))
      .compile()

    expect(compiled.sql).toContain('exists (select sum(')
    expect(compiled.params).toEqual([])
    expect(hook).not.toHaveBeenCalled()
    expect(controls.calls).toEqual([])
  })
}

for (const dialect of ['postgresql', 'sqlite'] as const) {
  it.each(['parameter', 'result'] as const)(
    `should reject ${dialect} transformed client %s mappings while counts bypass hooks`,
    async (direction) => {
      const hook = vi.fn<(type: string, value: unknown) => unknown>(
        (_type, value) => value,
      )

      const controls = createControllableProvider({
        queryRows: () => [{ n: dialect === 'postgresql' ? '2' : 2n }],
      })

      const db = createDatabase({
        connector: customConnector(dialect),
        schemas: [Rows],
        operationSessionProvider: controls.provider,
        map:
          direction === 'parameter' ? { mapParamValue: hook } : { mapResultValue: hook },
      })

      expect(() =>
        db
          .from(Rows)
          .select((b) => [b.as(b.sum(Rows.id), 'sum')])
          .compile(),
      ).toThrow(/standard mappings/)

      expect(() =>
        db
          .from(Rows)
          .select((b) => [b.as(b.lower(Rows.label), 'name')])
          .compile(),
      ).toThrow(/standard mappings/)

      expect(hook).not.toHaveBeenCalled()
      expect(controls.calls).toEqual([])

      const counts = db.from(Rows).select((b) => [b.as(b.countAll(), 'n')])
      counts.compile()
      expect(await counts.execute()).toEqual([{ n: 2 }])
      expect(hook).not.toHaveBeenCalled()
      await db.close()
    },
  )
}

it('should require a selected dialect proof even when an extension copies a built-in dialect id', () => {
  const extension: Dialect = {
    ...postgresDialect,
    query: { ...postgresDialect.query, expressionResult: undefined },
  }

  const query = extension.query.resolve([Rows])
  const mapper = createValueMapper(extension, undefined, [Rows], query)
  const from = createTableBuilder({
    handle: Rows,
    dialect: extension,
    query,
    mapper,
    executor: { execute: async () => [], run: async () => 0 },
  })

  expect(() => from.select((b) => [b.as(b.countAll(), 'n')]).compile()).toThrow(
    /Selected dialect/,
  )

  expect(sqliteDialect.query.expressionResult).toBeDefined()
})

it('should encode SQLite current timestamp literals in its native UTC spelling', () => {
  const { db } = setup('sqlite')
  const clock = db.cte(
    'clock',
    db.from(Rows).select((b) => [b.as(b.now(), 'now')]),
  )

  expect(
    db
      .with(clock)
      .from(clock)
      .where(eq(clock.now, new Date('2026-06-15T03:04:05Z')))
      .compile().params,
  ).toEqual(['2026-06-15 03:04:05'])

  expect(
    db
      .with(clock)
      .from(clock)
      .where(eq(clock.now, new Date('2026-06-15T03:04:05.123Z')))
      .compile().params,
  ).toEqual(['2026-06-15 03:04:05.123'])
})

it('should reject unsupported PostgreSQL native extrema before execution', () => {
  const Uuids = defineTable(
    'uuid_extrema',
    { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
    { primaryKey: 'id' },
  )

  const controls = createControllableProvider()
  const db = createDatabase({
    connector: customConnector('postgresql'),
    schemas: [Uuids],
    operationSessionProvider: controls.provider,
  })

  expect(() =>
    db
      .from(Uuids)
      .select((b) => [b.as(b.max(Uuids.id), 'max')])
      .compile(),
  ).toThrow(/operand storage/)

  expect(controls.calls).toEqual([])
})

it('should make earlier joined computed operands nullable after a later right join', () => {
  const { db } = setup('postgresql')
  const side = alias(Rows, 'side')
  const final = alias(Rows, 'final')

  const before = db
    .from(Rows)
    .innerJoin(side, eq(Rows.id, side.id))
    .select((b) => [b.as(b.lower(side.label), 'label')])
    .rightJoin(final, eq(Rows.id, final.id))

  const after = db
    .from(Rows)
    .innerJoin(side, eq(Rows.id, side.id))
    .rightJoin(final, eq(Rows.id, final.id))
    .select((b) => [b.as(b.lower(side.label), 'label')])

  expectTypeOf<
    Awaited<ReturnType<typeof before.execute>>[number]['label']
  >().toEqualTypeOf<string | null>()

  expectTypeOf<
    Awaited<ReturnType<typeof after.execute>>[number]['label']
  >().toEqualTypeOf<string | null>()
})
