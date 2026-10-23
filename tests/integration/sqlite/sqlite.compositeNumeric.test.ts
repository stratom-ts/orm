import { integer, maxValue, minValue, number, pipe, string, union } from 'valibot'
import { expect, it } from 'vitest'

import { column, defineTable } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

const NumericValues = defineTable(
  'composite_numeric_values',
  {
    id: string(),
    bounded: pipe(union([number(), number()]), integer(), minValue(0), maxValue(100)),
    overridden: pipe(
      union([number(), number()]),
      integer(),
      minValue(0),
      maxValue(100),
      column({ physicalType: { sqlite: 'REAL' } }),
    ),
  },
  { primaryKey: 'id' },
)

it('should migrate bounded numeric composites to INTEGER and converge', async () => {
  await withSqliteDatabase([NumericValues] as const, async ({ db, native }) => {
    expect((await db.migrate().plan()).steps.length).toBeGreaterThan(0)
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    const columns = native
      .prepare('pragma table_info(composite_numeric_values)')
      .all() as { name: string; type: string }[]

    expect(
      Object.fromEntries(columns.map(({ name, type }) => [name, type])),
    ).toMatchObject({
      bounded: 'INTEGER',
      overridden: 'REAL',
    })

    const row = { id: 'bounded', bounded: 42, overridden: 42 }
    expect(await db.insert(NumericValues).values(row).execute()).toEqual([row])
    expect(await db.from(NumericValues).where({ id: row.id }).execute()).toEqual([row])
  })
})
