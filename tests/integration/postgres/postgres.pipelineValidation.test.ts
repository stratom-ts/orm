import { integer, number, pipe, safeInteger, string } from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { defineTable, reference } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const Values = defineTable(
  'pipeline_validation_values',
  {
    value: pipe(number(), safeInteger(), number(), integer()),
  },
  { primaryKey: 'value' },
)

const References = defineTable(
  'pipeline_validation_references',
  {
    id: string(),
    value: reference(Values, 'value'),
  },
  { primaryKey: 'id' },
)

it('should migrate repeated safe-integer validation to bigint and round-trip JS numbers', async () => {
  await withPostgresDatabase(
    [Values, References] as const,
    async ({ db, admin, schema }) => {
      expect((await db.migrate().plan()).steps.length).toBeGreaterThan(0)
      await db.migrate().execute()

      const columns = await admin.query<{ column_name: string; data_type: string }>(
        `select column_name, data_type from information_schema.columns
       where table_schema = $1 and table_name = 'pipeline_validation_values'`,
        [schema],
      )

      expect(
        Object.fromEntries(
          columns.rows.map(({ column_name, data_type }) => [column_name, data_type]),
        ),
      ).toMatchObject({ value: 'bigint' })

      await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

      const row = { value: Number.MAX_SAFE_INTEGER }
      expect(await db.insert(Values).values(row).execute()).toEqual([row])

      expect(await db.from(Values).where({ value: row.value }).execute()).toEqual([row])

      const reference = { id: 'ref', value: row.value }
      expect(await db.insert(References).values(reference).execute()).toEqual([reference])

      expect(await db.from(References).where({ value: row.value }).execute()).toEqual([
        reference,
      ])

      await db.delete(References).where({ id: reference.id }).execute()

      const changed = { value: Number.MIN_SAFE_INTEGER }
      expect(
        await db
          .update(Values)
          .set({ value: changed.value })
          .where({ value: row.value })
          .execute(),
      ).toEqual([changed])

      const restored = { value: Number.MAX_SAFE_INTEGER }
      expect(
        await db
          .update(Values)
          .set({ value: restored.value })
          .where({ value: changed.value })
          .execute(),
      ).toEqual([restored])

      expect(await db.from(Values).where({ value: restored.value }).execute()).toEqual([
        restored,
      ])
    },
  )
})
