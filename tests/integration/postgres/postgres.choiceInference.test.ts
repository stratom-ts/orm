import {
  enum as enumSchema,
  literal,
  nullable,
  picklist,
  pipe,
  string,
  union,
} from 'valibot'
import { beforeAll, expect, expectTypeOf, it } from 'vitest'

import { column, defineTable, reference } from '@/index'
import type { InferInsert, InferSelect, InferUpdate } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const ChoiceParent = defineTable(
  'choice_parents',
  {
    id: picklist([1, 2]),
    textChoice: enumSchema({ first: 'first', second: 'second' }),
    wideNumber: picklist([0, Number.MAX_SAFE_INTEGER]),
    fractional: picklist([1, 1.5]),
    int64Choice: picklist([0n, 2n ** 63n - 1n]),
    numericChoice: picklist([0n, 2n ** 63n]),
    selected: pipe(picklist([1, 2]), column({ physicalType: { postgresql: 'integer' } })),
    nullableChoice: nullable(picklist([1n, 2n])),
    booleanChoice: union([literal(true), literal(false)]),
  },
  { primaryKey: 'id' },
)

const ChoiceChild = defineTable(
  'choice_children',
  { id: string(), parentId: reference(ChoiceParent, 'id') },
  { primaryKey: 'id' },
)

const first = {
  id: 1,
  textChoice: 'first',
  wideNumber: Number.MAX_SAFE_INTEGER,
  fractional: 1.5,
  int64Choice: 2n ** 63n - 1n,
  numericChoice: 2n ** 63n,
  selected: 2,
  nullableChoice: null,
  booleanChoice: false,
} as const

type ChoiceRow = {
  id: 1 | 2
  textChoice: 'first' | 'second'
  wideNumber: number
  fractional: 1 | 1.5
  int64Choice: bigint
  numericChoice: bigint
  selected: 1 | 2
  nullableChoice: 1n | 2n | null
  booleanChoice: boolean
}

expectTypeOf<InferInsert<typeof ChoiceParent>>().toEqualTypeOf<ChoiceRow>()
expectTypeOf<InferSelect<typeof ChoiceParent>>().toEqualTypeOf<ChoiceRow>()
expectTypeOf<InferUpdate<typeof ChoiceParent>>().toEqualTypeOf<Partial<ChoiceRow>>()

it('should migrate inferred PostgreSQL choices and converge on the selected types', async () => {
  await withPostgresDatabase(
    [ChoiceParent, ChoiceChild] as const,
    async ({ db, admin, schema }) => {
      expect((await db.migrate().plan()).steps.length).toBeGreaterThan(0)
      await db.migrate().execute()
      await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

      const columns = await admin.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
       where table_schema = $1 and table_name = 'choice_parents'`,
        [schema],
      )

      expect(
        Object.fromEntries(columns.rows.map((row) => [row.column_name, row.data_type])),
      ).toMatchObject({
        id: 'smallint',
        textChoice: 'text',
        wideNumber: 'bigint',
        fractional: 'double precision',
        int64Choice: 'bigint',
        numericChoice: 'numeric',
        selected: 'integer',
        nullableChoice: 'bigint',
        booleanChoice: 'boolean',
      })
    },
  )
})

it('should round-trip inferred number and bigint choices through writes and references', async () => {
  await withPostgresDatabase([ChoiceParent, ChoiceChild] as const, async ({ db }) => {
    await db.migrate().execute()

    expect(await db.insert(ChoiceParent).values(first).execute()).toEqual([first])
    for (const predicate of [
      { fractional: 1.5 as const },
      { textChoice: 'first' as const },
      { int64Choice: first.int64Choice },
      { booleanChoice: false },
    ])
      expect(await db.from(ChoiceParent).where(predicate).execute()).toEqual([first])

    expect(
      await db.from(ChoiceParent).where({ wideNumber: first.wideNumber }).execute(),
    ).toEqual([first])

    expect(
      await db.from(ChoiceParent).where({ numericChoice: first.numericChoice }).execute(),
    ).toEqual([first])

    const child = { id: 'child', parentId: first.id }
    expect(await db.insert(ChoiceChild).values(child).execute()).toEqual([child])

    expect(await db.from(ChoiceChild).where({ parentId: first.id }).execute()).toEqual([
      child,
    ])

    const changed: ChoiceRow = {
      ...first,
      wideNumber: 0,
      numericChoice: 0n,
      nullableChoice: 2n as const,
      textChoice: 'second',
      fractional: 1,
      int64Choice: 0n,
      selected: 1,
      booleanChoice: true,
    }

    expect(
      await db.update(ChoiceParent).set(changed).where({ id: first.id }).execute(),
    ).toEqual([changed])

    expect(await db.from(ChoiceParent).where({ id: first.id }).execute()).toEqual([
      changed,
    ])
  })
})
