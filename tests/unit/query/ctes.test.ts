import { nullable, number, pipe, string } from 'valibot'
import { expect, expectTypeOf, it } from 'vitest'

import { alias, column, createDatabase, defineTable, eq, exists, outer } from '@/index'
import type { CteHandle } from '@/types/cte'

import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

const Rows = defineTable(
  'cte_rows',
  { id: number(), parent: nullable(number()), label: string() },
  { primaryKey: 'id' },
)

function setup(dialect: 'postgresql' | 'sqlite' = 'postgresql') {
  const controls = createControllableProvider()
  const db = createDatabase({
    connector: customConnector(dialect),
    operationSessionProvider: controls.provider,
    schemas: [Rows],
  })

  return { db, controls }
}

for (const dialect of ['postgresql', 'sqlite'] as const) {
  it(`should ${dialect}: composes typed ordinary chains, aliases and ordered bindings without executing`, () => {
    const { db, controls } = setup(dialect)
    const first = db.cte(
      'first',
      db
        .from(Rows)
        .select((b) => [Rows.id, b.as(Rows.label, 'name')])
        .where(eq(Rows.id, 1)),
    )

    expectTypeOf(first.name.__type).toEqualTypeOf<string>()
    const second = db.cte('second', db.from(first).where(eq(first.name, 'x')))
    const named = alias(second, 'named')
    const query = db.with(second).from(named).where(eq(named.id, 2))
    const compiled = query.compile()
    expect(compiled.params).toEqual([1, 'x', 2])
    expect(compiled.sql).toMatch(/with "first".*"second"/)
    expect(query.compile()).toEqual(compiled)
    expect(controls.calls).toEqual([])
    expect(() => db.from(first).compile()).toThrow(/attach|unavailable/)
  })

  it(`should ${dialect}: emits direct recursive terms with inferred nullable self`, () => {
    const { db } = setup(dialect)
    const team = db.cte(
      'team',
      db.from(Rows).select([Rows.id]).where(eq(Rows.id, 1)),
      (self) => {
        expectTypeOf(self.id.__type).toEqualTypeOf<number | null>()
        return db
          .from(Rows)
          .innerJoin(self, (b) => b.eq(Rows.parent, self.id))
          .select([Rows.id])
      },
    )

    const compiled = db.with(team).from(team).compile()
    expect(compiled.sql).toMatch(/with recursive "team"/)
    expect(compiled.sql).toMatch(/union all select/)
    expect(compiled.params).toEqual([1])
  })
}

it('should discover dependencies in nested queries and rejects cross-client owners and writes', () => {
  const { db } = setup()
  const first = db.cte('first', db.from(Rows).select([Rows.id]))
  const second = db.cte(
    'second',
    db
      .from(Rows)
      .select([Rows.id])
      .where(exists(db.from(first))),
  )

  expect(db.with(second).from(second).compile().sql).toMatch(/with "first".*"second"/)
  expect(() => setup().db.with(first).from(first).compile()).toThrow(/client scope/)

  const write = db
    .insert(Rows)
    .values({ id: 1, parent: null, label: 'x' })
    .returning([Rows.id])

  expect(() => db.cte('write', write as never)).toThrow(/SELECT/)

  expect(() =>
    db
      .update(Rows)
      .set({ label: 'x' })
      .where(exists(db.with(first).from(first)))
      .compile(),
  ).toThrow(/CTE|unavailable/)
})

it('should reject duplicate definitions and deduplicate diamond dependencies', () => {
  const { db } = setup()
  const first = db.cte('first', db.from(Rows).select([Rows.id]))
  const a = db.cte('a', db.from(first))
  const b = db.cte('b', db.from(first))
  const last = db.cte(
    'last',
    db
      .from(a)
      .innerJoin(b, (q) => q.eq(a.id, b.id))
      .select([a.id]),
  )

  const sql = db.with(last).from(last).compile().sql
  expect(sql.match(/"first" \(/g)).toHaveLength(1)
  expect(sql).toMatch(/"first".*"a".*"b".*"last"/)
  const duplicate = db.cte('first', db.from(Rows))
  expect(() => db.with(first, duplicate).from(first).compile()).toThrow(/Duplicate CTE/)
})

it('should enforce recursive self scope and portable shape restrictions before execution', () => {
  const { db, controls } = setup()
  const initial = db.from(Rows).select([Rows.id])
  let escaped: CteHandle<{ id: number | null }> = db.cte('placeholder', initial)
  const recursive = db.cte('r', initial, (self) => {
    escaped = self
    return db.from(self).select([self.id])
  })

  expect(() => db.from(escaped).compile()).toThrow(/escaped/)
  expect(() => db.with(escaped).from(escaped).compile()).toThrow(/self|cycle/i)

  expect(() => db.with(recursive).from(recursive).select([escaped.id]).compile()).toThrow(
    /available/,
  )

  const missing = db.cte('missing', initial, () => initial)
  expect(() => db.with(missing).from(missing).compile()).toThrow(/exactly one/)
  const nested = db.cte('nested', initial, (self) =>
    db
      .from(Rows)
      .select([Rows.id])
      .where(exists(db.from(self))),
  )

  expect(() => db.with(nested).from(nested).compile()).toThrow(/direct self/)
  const paginated = db.cte('pages', initial, (self) =>
    db.from(self).select([self.id]).limit(2),
  )

  expect(() => db.with(paginated).from(paginated).compile()).toThrow(/pagination/)
  expect(controls.calls).toEqual([])
})

it('should validate recursive output names, order and storage contracts dynamically', () => {
  const { db } = setup()
  const initial = db.from(Rows).select([Rows.id, Rows.label])
  const reordered = db.cte('order', initial, (() =>
    db.from(Rows).select([Rows.label, Rows.id])) as never)

  expect(() => db.with(reordered).from(reordered).compile()).toThrow(/name and order/)
  const initialHandle = db.cte('typed', db.from(Rows).select([Rows.id]))
  const incompatible = db.cte('type', db.from(Rows).select([Rows.id]), ((
    self: typeof initialHandle,
  ) =>
    db
      .from(Rows)
      .innerJoin(self, (b) => b.eq(Rows.id, self.id))
      .select((b) => [b.as(Rows.label, 'id')])) as never)

  expect(() => db.with(incompatible).from(incompatible).compile()).toThrow(
    /representation/,
  )

  const duplicate = db.from(Rows).select([Rows.id, Rows.id])
  expect(() => db.cte('duplicate', duplicate as never)).toThrow(/ambiguous/)

  expect(() =>
    db.cte(
      'computed',
      db.from(Rows).select((b) => [{ kind: 'expr', expr: b.countAll() }] as never),
    ),
  ).toThrow(/aliases/)
})

it('should retain root, nested and expired transaction ownership and closed-client guards', async () => {
  const { db } = setup()
  const root = db.cte('root', db.from(Rows).select([Rows.id]))
  let expired: CteHandle<{ id: number }> = root

  const expiredQuery = await db.transaction(async (trx) => {
    const local = trx.cte('local', trx.from(Rows).select([Rows.id]))
    expired = local
    expect(() => trx.with(root).from(root)).toThrow(/scope/)
    expect(() => db.with(local).from(local)).toThrow(/scope/)

    await trx.transaction(async (nested) => {
      expect(() => nested.with(local).from(local)).toThrow(/scope/)
    })

    return trx.with(local).from(local)
  })

  await expect(expiredQuery.execute()).rejects.toThrow(/no longer active/)
  expect(() => db.with(expired).from(expired)).toThrow(/scope/)
  const reusable = db.with(root).from(root)
  await db.close()
  await expect(reusable.execute()).rejects.toThrow(/closed/)
  expect(() => db.cte('closed', reusable)).toThrow(/closed/)
})

it('should infer nullable recursive results and reject invalid static contracts', () => {
  const { db } = setup()
  const initial = db.from(Rows).select([Rows.id])
  const nullable = db.cte('nullable', initial, (self) => db.from(self).select([self.id]))
  expectTypeOf(nullable.id.__type).toEqualTypeOf<number | null>()

  const invalidTypes = () => {
    // @ts-expect-error CTE handles have no physical-table authority.
    db.insert(nullable)
    const incompatible = db.from(Rows).select((b) => [b.as(Rows.label, 'id')])

    // @ts-expect-error Recursive non-null value types must agree.
    db.cte('bad_type', initial, () => incompatible)

    // @ts-expect-error Duplicate names cannot define CTE columns.
    db.cte('duplicate', db.from(Rows).select([Rows.id, Rows.id]))

    const write = db
      .insert(Rows)
      .values({ id: 1, parent: null, label: 'x' })
      .returning([Rows.id])

    // @ts-expect-error Returning rows does not make a write a SELECT definition.
    db.cte('write', write)

    // @ts-expect-error Recursive terms must also be SELECT builders.
    db.cte('recursive_write', initial, () => write)
  }

  expectTypeOf(invalidTypes).toBeFunction()
})

it('should preserve physical database session guards inside transitive CTE definitions', () => {
  const Physical = defineTable(
    'physical',
    { id: number() },
    {
      primaryKey: 'id',
      namespace: [
        { role: 'database', spelling: 'expected' },
        { role: 'schema', spelling: 'public' },
      ],
    },
  )

  const db = createDatabase({
    connector: customConnector('postgresql'),
    operationSessionProvider: createControllableProvider().provider,
    schemas: [Physical],
  })

  const first = db.cte('first', db.from(Physical).select([Physical.id]))
  const second = db.cte('second', db.from(first))
  const compiled = db.with(second).from(second).compile()
  expect(compiled.assertSession).toBeTypeOf('function')
  expect(() => compiled.assertSession?.({ database: 'wrong' })).toThrow(/database/)
  expect(() => compiled.assertSession?.({ database: 'expected' })).not.toThrow()
})

it('should include attachments from nested SELECTs and set branches while rejecting indirect writes', () => {
  const { db } = setup()
  const cte = db.cte('c', db.from(Rows).select([Rows.id]))
  const attached = db.with(cte).from(cte)
  expect(db.from(Rows).where(exists(attached)).compile().sql).toMatch(/^with "c"/)

  expect(db.from(Rows).select([Rows.id]).unionAll(attached).compile().sql).toMatch(
    /^with "c"/,
  )

  expect(() => db.delete(Rows).where(exists(attached)).compile()).toThrow(
    /CTE-consuming writes/,
  )

  expect(() => db.insert(cte as never)).toThrow(/handle/)
})

it('should map parameters and results once through aliases and CTE chains', async () => {
  const params: unknown[] = []
  const results: unknown[] = []
  const Mapped = defineTable(
    'mapped',
    {
      id: pipe(
        number(),
        column({
          name: 'physical_id',
          mapParam: (value) => {
            params.push(value)
            return Number(value) + 10
          },
          mapResult: (value) => {
            results.push(value)
            return Number(value) - 10
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  const controls = createControllableProvider({
    queryRows: (sql) => (sql.startsWith('with ') ? [{ renamed: 11 }] : []),
  })

  const db = createDatabase({
    connector: customConnector('postgresql'),
    operationSessionProvider: controls.provider,
    schemas: [Mapped],
  })

  const first = db.cte(
    'first',
    db
      .from(Mapped)
      .select((b) => [b.as(Mapped.id, 'renamed')])
      .where(eq(Mapped.id, 1)),
  )

  const second = db.cte('second', db.from(first))
  const named = alias(second, 'named')
  expect(params).toEqual([])

  const query = db.with(second).from(named).where(eq(named.renamed, 2))
  expect(query.compile().params).toEqual([11, 12])
  expect(params).toEqual([1, 2])
  params.length = 0
  expect(await query.execute()).toEqual([{ renamed: 1 }])

  expect(params).toEqual([1, 2])
  expect(results).toEqual([11])
  await db.close()
})

it('should preserve nullable column hooks while bypassing hooks for empty scalar results', async () => {
  const mapped: unknown[] = []
  const NullableRows = defineTable(
    'nullable_rows',
    {
      id: number(),
      label: pipe(
        nullable(string()),
        column({
          mapResult: (value) => {
            mapped.push(value)
            return value === null ? 'missing' : value
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  const controls = createControllableProvider({ queryRows: () => [{ label: null }] })
  const db = createDatabase({
    connector: customConnector('postgresql'),
    operationSessionProvider: controls.provider,
    schemas: [NullableRows],
  })

  try {
    const query = db.from(NullableRows).select([NullableRows.label])
    expect(await query.execute()).toEqual([{ label: 'missing' }])
    const first = db.cte('nullable', query)
    const second = db.cte('nullable_chain', db.from(first))
    expect(await db.with(second).from(alias(second, 'named')).execute()).toEqual([
      { label: 'missing' },
    ])

    expect(mapped).toEqual([null, null])

    const scalarNull = db.cte(
      'scalar_null',
      db.from(NullableRows).select((b) => [b.as(b.scalar(query.limit(0)), 'label')]),
    )

    expect(await db.with(scalarNull).from(scalarNull).execute()).toEqual([
      { label: null },
    ])

    expect(mapped).toEqual([null, null])
  } finally {
    await db.close()
  }
})

it('should reject self hidden in another CTE definition', () => {
  const { db } = setup()
  const recursive = db.cte('r', db.from(Rows).select([Rows.id]), (self) => {
    const escaped = db.cte('escaped', db.from(self))
    return db
      .from(self)
      .innerJoin(escaped, (b) => b.eq(self.id, escaped.id))
      .select([self.id])
  })

  expect(() => db.with(recursive).from(recursive).compile()).toThrow(/escaped/)
})

it('should share one binding stream across initial, recursive and consuming SELECTs', () => {
  const { db } = setup()
  const tree = db.cte(
    'tree',
    db.from(Rows).select([Rows.id]).where(eq(Rows.id, 1)),
    (self) => db.from(self).select([self.id]).where(eq(self.id, 2)),
    { union: 'distinct' },
  )

  const query = db.with(tree).from(tree).where(eq(tree.id, 3))
  expect(query.compile().params).toEqual([1, 2, 3])
  expect(query.compile().sql.match(/\$\d+/g)).toEqual(['$1', '$2', '$3'])
  expect(query.compile().sql).toMatch(/union select/)
})

it('should retain distinct source and alias identities in selected column types', () => {
  const { db } = setup()
  const numbers = db.cte('numbers', db.from(Rows).select([Rows.id]))
  const strings = db.cte(
    'strings',
    db.from(Rows).select((b) => [b.as(Rows.label, 'id')]),
  )

  const selected = db
    .with(numbers, strings)
    .from(numbers)
    .innerJoin(strings, (b) => b.eq(numbers.id, numbers.id))
    .select([strings.id])

  expectTypeOf<ReturnType<typeof selected.execute>>().toEqualTypeOf<
    Promise<{ id: string }[]>
  >()

  const other = alias(numbers, 'other')
  const renamed = alias(other, 'renamed')
  const renamedSelection = db.with(numbers).from(renamed).select([renamed.id])
  expectTypeOf<ReturnType<typeof renamedSelection.execute>>().toEqualTypeOf<
    Promise<{ id: number }[]>
  >()

  const joined = db
    .with(numbers)
    .from(numbers)
    .leftJoin(other, (b) => b.eq(numbers.id, other.id))

  const required = joined.select([numbers.id])
  expectTypeOf<ReturnType<typeof required.execute>>().toEqualTypeOf<
    Promise<{ id: number }[]>
  >()

  const optional = joined.select([other.id])
  expectTypeOf<ReturnType<typeof optional.execute>>().toEqualTypeOf<
    Promise<{ id: number | null }[]>
  >()

  const renamedOptional = db
    .with(numbers)
    .from(numbers)
    .leftJoin(renamed, (b) => b.eq(numbers.id, renamed.id))
    .select([renamed.id])

  expectTypeOf<ReturnType<typeof renamedOptional.execute>>().toEqualTypeOf<
    Promise<{ id: number | null }[]>
  >()
})

it('should preserve explicit outer references to CTE sources without correlating definitions', () => {
  const { db } = setup()
  const cte = db.cte('c', db.from(Rows).select([Rows.id]))
  const inner = db.from(Rows).where(eq(Rows.id, outer(cte.id)))
  expect(() => db.with(cte).from(cte).where(exists(inner)).compile()).not.toThrow()
  const invalid = db.cte(
    'invalid',
    db
      .from(Rows)
      .select([Rows.id])
      .where(eq(Rows.id, outer(cte.id))),
  )

  expect(() =>
    db
      .with(cte, invalid)
      .from(cte)
      .where(exists(db.from(invalid)))
      .compile(),
  ).toThrow(/enclosing scope/)
})
