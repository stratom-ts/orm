import {
  enum as enumSchema,
  integer,
  literal,
  number,
  picklist,
  pipe,
  union,
} from 'valibot'
import { expect, expectTypeOf, it } from 'vitest'

import { defineTable } from '@/index'
import type { InferInsert, InferSelect, InferUpdate } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

const ChoiceValues = defineTable(
  'choice_values',
  {
    id: pipe(number(), integer()),
    textChoice: enumSchema({ first: 'first', second: 'second' }),
    integerChoice: picklist([1, 2]),
    realChoice: picklist([1, 1.5]),
    booleanChoice: union([literal(true), literal(false)]),
    bigintChoice: picklist([2n, 9007199254740993n]),
  },
  { primaryKey: 'id' },
)

const rows = [
  {
    id: 1,
    textChoice: 'second',
    integerChoice: 2,
    realChoice: 1.5,
    booleanChoice: true,
    bigintChoice: 9007199254740993n,
  },
  {
    id: 2,
    textChoice: 'first',
    integerChoice: 1,
    realChoice: 1,
    booleanChoice: false,
    bigintChoice: 2n,
  },
] as const

type ChoiceRow = {
  id: number
  textChoice: 'first' | 'second'
  integerChoice: 1 | 2
  realChoice: 1 | 1.5
  booleanChoice: boolean
  bigintChoice: 2n | 9007199254740993n
}

it('should migrate and round-trips inferred SQLite enum and picklist values', async () => {
  expectTypeOf<InferInsert<typeof ChoiceValues>>().toEqualTypeOf<ChoiceRow>()
  expectTypeOf<InferSelect<typeof ChoiceValues>>().toEqualTypeOf<ChoiceRow>()
  expectTypeOf<InferUpdate<typeof ChoiceValues>>().toEqualTypeOf<Partial<ChoiceRow>>()

  await withSqliteDatabase([ChoiceValues], async ({ db, native }) => {
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    expect(
      native
        .prepare('select name, type from pragma_table_info(?) order by name')
        .all('choice_values'),
    ).toEqual([
      { name: 'bigintChoice', type: 'BIGINT' },
      { name: 'booleanChoice', type: 'BOOLEAN' },
      { name: 'id', type: 'INTEGER' },
      { name: 'integerChoice', type: 'INTEGER' },
      { name: 'realChoice', type: 'REAL' },
      { name: 'textChoice', type: 'TEXT' },
    ])

    expect(
      await db
        .insert(ChoiceValues)
        .values([...rows])
        .execute(),
    ).toEqual(rows)

    expect(
      await db.from(ChoiceValues).where({ bigintChoice: 9007199254740993n }).execute(),
    ).toEqual([rows[0]])

    expect(await db.from(ChoiceValues).where({ booleanChoice: false }).execute()).toEqual(
      [rows[1]],
    )

    for (const predicate of [
      { integerChoice: 2 as const },
      { realChoice: 1.5 as const },
      { textChoice: 'second' as const },
    ])
      expect(await db.from(ChoiceValues).where(predicate).execute()).toEqual([rows[0]])

    const changed = { ...rows[1], id: 1 }
    expect(await db.update(ChoiceValues).set(changed).where({ id: 1 }).execute()).toEqual(
      [changed],
    )

    expect(await db.from(ChoiceValues).where({ id: 1 }).execute()).toEqual([changed])
  })
})
