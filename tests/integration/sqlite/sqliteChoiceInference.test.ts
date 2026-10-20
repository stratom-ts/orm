import { enum as enumSchema, integer, number, picklist, pipe } from 'valibot'
import { expect, it } from 'vitest'

import { defineTable } from '@/index'
import type { AnySchema } from '@/types/schema'

import { withSqliteDatabase } from './sqliteIntegration'

const booleanChoice = (picklist as unknown as (options: readonly boolean[]) => AnySchema)(
  [true, false],
)

const ChoiceValues = defineTable(
  'choice_values',
  {
    id: pipe(number(), integer()),
    textChoice: enumSchema({ first: 'first', second: 'second' }),
    integerChoice: picklist([1, 2]),
    realChoice: picklist([1, 1.5]),
    booleanChoice,
    bigintChoice: picklist([2n, 9007199254740993n]),
  },
  { primaryKey: 'id' },
)

it('should migrate and round-trips inferred SQLite enum and picklist values', async () => {
  await withSqliteDatabase([ChoiceValues], async ({ db }) => {
    await db.migrate().execute()

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
  })
})
