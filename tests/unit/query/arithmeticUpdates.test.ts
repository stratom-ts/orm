import {
  bigint,
  integer,
  minValue,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
  toUpperCase,
  transform,
} from 'valibot'
import { expect, it } from 'vitest'

import { compileSqliteQuery } from '@/dialects/sqlite/compile'
import {
  QueryError,
  ValidationError,
  add,
  column,
  createDatabase,
  defineTable,
} from '@/index'

import { createMockPostgresConnector } from '../dialects/postgresNativeClientFixtures'

const Counters = defineTable(
  'count"ers',
  {
    id: pipe(number(), integer()),
    count: pipe(number(), integer(), minValue(10)),
    other: pipe(number(), integer()),
    optional: nullable(pipe(number(), integer())),
    float: number(),
    label: pipe(string(), toUpperCase(), string()),
    json: object({ kind: string() }),
    locked: pipe(number(), column({ readonly: true })),
  },
  { primaryKey: 'id' },
)

const makeDb = () =>
  createDatabase({ connector: createMockPostgresConnector(), schemas: [Counters] })

it('binds mixed assignments before predicates and preserves immutable builders', async () => {
  const db = makeDb()
  try {
    const builder = db
      .update(Counters)
      .set({ count: add(Counters.other, 1), label: 'hello', json: { kind: 'add' } })

    const compiled = builder.where(Counters.id, 'eq', 7).compile()
    expect(compiled.sql).toContain('"count" = "count""ers"."other" + cast($1 as numeric)')
    expect(compiled.params).toEqual([1, 'HELLO', '{"kind":"add"}', 7])
    expect(builder.where(Counters.id, 'eq', 8).compile().params.at(-1)).toBe(8)
    expect(() => builder.compile()).toThrow(QueryError)
    const sqlite = compileSqliteQuery({
      kind: 'update',
      relation: Counters.getTableMetadata().relation,
      set: [
        { column: 'count', addition: { source: 'other', delta: -2 } },
        { column: 'json', value: { kind: 'add' } },
      ],
      allowAll: true,
    })

    expect(sqlite.sql).toContain('"count" = "main.count""ers"."other" + ?')
    expect(sqlite.params).toEqual([-2, { kind: 'add' }])
  } finally {
    await db.close()
  }
})

it('rejects invalid finite operands at the public boundary', () => {
  for (const value of [
    NaN,
    Infinity,
    -Infinity,
    '1',
    1n,
    Counters.id,
    add(Counters.id, 1),
  ]) {
    // @ts-expect-error unchecked JavaScript operand
    expect(() => add(Counters.id, value)).toThrow(QueryError)
  }
})

it('rejects incompatible sources and targets synchronously', async () => {
  const db = makeDb()
  const Other = defineTable(
    'count"ers',
    { id: number(), count: number() },
    { primaryKey: 'id' },
  )

  try {
    expect(() => db.update(Counters).set({ count: add(Other.count, 1) })).toThrow(
      QueryError,
    )

    // @ts-expect-error nullable results cannot target nonnullable columns
    expect(() => db.update(Counters).set({ count: add(Counters.optional, 1) })).toThrow(
      QueryError,
    )

    expect(() => db.update(Counters).set({ count: add(Counters.float, 1) })).toThrow(
      QueryError,
    )

    expect(() => db.update(Counters).set({ count: add(Counters.count, 0.5) })).toThrow(
      QueryError,
    )

    // @ts-expect-error string source
    expect(() => db.update(Counters).set({ float: add(Counters.label, 1) })).toThrow(
      QueryError,
    )

    // @ts-expect-error string target
    expect(() => db.update(Counters).set({ label: add(Counters.count, 1) })).toThrow(
      QueryError,
    )
  } finally {
    await db.close()
  }
})

it('keeps writable keys and literal schema validation', async () => {
  const db = makeDb()
  try {
    // @ts-expect-error readonly target
    expect(() => db.update(Counters).set({ locked: add(Counters.count, 1) })).toThrow(
      ValidationError,
    )

    expect(() => db.update(Counters).set({})).toThrow(ValidationError)
    expect(() => db.update(Counters).set({ count: 1 })).toThrow(ValidationError)

    expect(() =>
      // @ts-expect-error forged object is not an addition
      db.update(Counters).set({ count: { column: Counters.count, delta: 1 } }),
    ).toThrow(ValidationError)

    expect(() =>
      // @ts-expect-error addition is update-only
      db.insert(Counters).values({ id: 1, count: add(Counters.count, 1) }),
    ).toThrow(ValidationError)
  } finally {
    await db.close()
  }
})

it('rejects participating custom mappings without calling them', async () => {
  let calls = 0
  const T = defineTable(
    'mapped',
    {
      id: number(),
      n: pipe(
        number(),
        column({
          mapParam: (x) => {
            calls++
            return x
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  const db = createDatabase({ connector: createMockPostgresConnector(), schemas: [T] })
  try {
    expect(() => db.update(T).set({ n: add(T.n, 1) })).toThrow(QueryError)
    expect(calls).toBe(0)
  } finally {
    await db.close()
  }
})

it.each(['parameter', 'result'] as const)(
  'rejects client %s overrides without invoking them',
  async (direction) => {
    let calls = 0
    const hook = (value: unknown) => {
      calls++
      return value
    }

    const connector = createMockPostgresConnector()
    const db = createDatabase({
      connector,
      schemas: [Counters],
      map:
        direction === 'parameter'
          ? { mapParamValue: (_type, value) => hook(value) }
          : { mapResultValue: (_type, value) => hook(value) },
    })

    try {
      expect(() => db.update(Counters).set({ count: add(Counters.count, 1) })).toThrow(
        QueryError,
      )

      expect(calls).toBe(0)
      expect(connector.prepared).toEqual([])
    } finally {
      await db.close()
    }
  },
)

it('allows unrelated column hooks and does not parse computed refinements or transforms', async () => {
  let transformed = 0
  const T = defineTable(
    'transformed',
    {
      id: number(),
      n: pipe(
        number(),
        minValue(10),
        transform((value) => {
          transformed++
          return value + 10
        }),
        number(),
        integer(),
      ),
      unrelated: pipe(string(), column({ mapParam: (value) => value })),
    },
    { primaryKey: 'id' },
  )

  const db = createDatabase({ connector: createMockPostgresConnector(), schemas: [T] })
  try {
    expect(
      db
        .update(T)
        .set({ n: add(T.n, 1) })
        .all()
        .compile().params,
    ).toEqual([1])

    expect(transformed).toBe(0)
    expect(db.update(T).set({ n: 20 }).all().compile().params).toEqual([30])
    expect(transformed).toBe(1)
  } finally {
    await db.close()
  }
})

it('rejects encoded numeric storage even with paired identity hooks', async () => {
  const T = defineTable(
    'encoded',
    {
      id: number(),
      n: pipe(
        number(),
        column({
          physicalType: { postgresql: 'text' },
          mapParam: (x) => x,
          mapResult: (x) => x,
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  const db = createDatabase({ connector: createMockPostgresConnector(), schemas: [T] })
  try {
    expect(() => db.update(T).set({ n: add(T.n, 1) })).toThrow(QueryError)
  } finally {
    await db.close()
  }
})

it('does not run optional default transforms for computed assignments', async () => {
  let transformed = 0
  const T = defineTable(
    'default_transform',
    {
      id: number(),
      n: optional(
        pipe(
          number(),
          transform((value) => {
            transformed++
            return value + 10
          }),
          number(),
        ),
        20,
      ),
    },
    { primaryKey: 'id' },
  )

  const db = createDatabase({ connector: createMockPostgresConnector(), schemas: [T] })
  try {
    expect(
      db
        .update(T)
        .set({ n: add(T.n, 1) })
        .all()
        .compile().params,
    ).toEqual([1])

    expect(transformed).toBe(0)
    expect(db.update(T).set({ n: 2 }).all().compile().params).toEqual([12])
    expect(transformed).toBe(1)
  } finally {
    await db.close()
  }
})

/** Compile-time restrictions do not invoke unsupported JavaScript query shapes. */
export function arithmeticTypeRestrictions(db: ReturnType<typeof makeDb>) {
  const expression = add(Counters.count, 1)

  // @ts-expect-error string delta
  add(Counters.count, '1')

  // @ts-expect-error bigint delta
  add(Counters.count, 1n)

  // @ts-expect-error column delta
  add(Counters.count, Counters.other)

  // @ts-expect-error nested addition delta
  add(Counters.count, expression)

  // @ts-expect-error update-only expression
  db.from(Counters).select([expression])

  // @ts-expect-error update-only expression
  db.from(Counters).where(Counters.count, 'eq', expression)

  // @ts-expect-error bigint source
  add(defineTable('big', { n: bigint() }).n, 1)

  db.insert(Counters).values({
    id: 1,
    // @ts-expect-error update-only expression
    count: expression,
    other: 0,
    optional: null,
    float: 0,
    label: '',
    json: { kind: '' },
  })

  db.insert(Counters)
    .values({
      id: 1,
      count: 10,
      locked: 0,
      other: 0,
      optional: null,
      float: 0,
      label: '',
      json: { kind: '' },
    })
    .onConflict([Counters.id])
    // @ts-expect-error update-only expression
    .doUpdate({ count: expression })
}
