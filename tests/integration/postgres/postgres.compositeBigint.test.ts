import { bigint, intersect, maxValue, minValue, pipe, string, union } from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { defineTable } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

const BigintValues = defineTable(
  'composite_bigint_values',
  {
    id: string(),
    bounded: pipe(union([bigint(), bigint()]), minValue(INT64_MIN), maxValue(INT64_MAX)),
    nested: pipe(
      union([
        pipe(intersect([bigint(), bigint()]), minValue(INT64_MIN)),
        pipe(bigint(), minValue(INT64_MIN)),
      ]),
      maxValue(INT64_MAX),
    ),
  },
  { primaryKey: 'id' },
)

it('should migrate and round-trip bounded bigint composites at both int64 limits', async () => {
  await withPostgresDatabase([BigintValues] as const, async ({ db, admin, schema }) => {
    expect((await db.migrate().plan()).steps.length).toBeGreaterThan(0)
    await db.migrate().execute()

    const columns = await admin.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = $1 and table_name = 'composite_bigint_values'`,
      [schema],
    )

    expect(
      Object.fromEntries(
        columns.rows.map(({ column_name, data_type }) => [column_name, data_type]),
      ),
    ).toMatchObject({ bounded: 'bigint', nested: 'bigint' })

    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    for (const value of [INT64_MIN, INT64_MAX]) {
      const row = { id: String(value), bounded: value, nested: value }
      expect(await db.insert(BigintValues).values(row).execute()).toEqual([row])

      expect(await db.from(BigintValues).where({ bounded: value }).execute()).toEqual([
        row,
      ])
    }

    for (const [previous, next] of [
      [INT64_MIN, INT64_MAX],
      [INT64_MAX, INT64_MIN],
    ] as const) {
      const changed = { id: String(previous), bounded: next, nested: next }
      expect(
        await db
          .update(BigintValues)
          .set({ bounded: next, nested: next })
          .where({ id: changed.id })
          .execute(),
      ).toEqual([changed])

      expect(await db.from(BigintValues).where({ id: changed.id }).execute()).toEqual([
        changed,
      ])
    }
  })
})
