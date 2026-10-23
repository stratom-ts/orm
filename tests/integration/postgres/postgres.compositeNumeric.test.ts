import {
  integer,
  maxValue,
  minValue,
  number,
  pipe,
  safeInteger,
  string,
  union,
} from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { defineTable } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const NumericValues = defineTable(
  'composite_numeric_values',
  {
    id: string(),
    safe: pipe(
      union([pipe(number(), integer()), pipe(number(), integer())]),
      safeInteger(),
    ),
    bounded: pipe(union([number(), number()]), integer(), minValue(0), maxValue(100)),
  },
  { primaryKey: 'id' },
)

it('should migrate and round-trip outer-constrained numeric composites', async () => {
  await withPostgresDatabase([NumericValues] as const, async ({ db, admin, schema }) => {
    expect((await db.migrate().plan()).steps.length).toBeGreaterThan(0)
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    const columns = await admin.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = $1 and table_name = 'composite_numeric_values'`,
      [schema],
    )

    expect(
      Object.fromEntries(
        columns.rows.map(({ column_name, data_type }) => [column_name, data_type]),
      ),
    ).toMatchObject({ safe: 'bigint', bounded: 'smallint' })

    const row = { id: 'max-safe', safe: Number.MAX_SAFE_INTEGER, bounded: 50 }

    expect(await db.insert(NumericValues).values(row).execute()).toEqual([row])

    expect(await db.from(NumericValues).where({ safe: row.safe }).execute()).toEqual([
      row,
    ])

    const changed = { ...row, safe: Number.MIN_SAFE_INTEGER }
    expect(
      await db
        .update(NumericValues)
        .set({ safe: changed.safe })
        .where({ id: row.id })
        .execute(),
    ).toEqual([changed])

    const restored = { ...row, safe: Number.MAX_SAFE_INTEGER }
    expect(
      await db
        .update(NumericValues)
        .set({ safe: restored.safe })
        .where({ id: row.id })
        .execute(),
    ).toEqual([restored])

    expect(await db.from(NumericValues).where({ id: row.id }).execute()).toEqual([
      restored,
    ])
  })
})
