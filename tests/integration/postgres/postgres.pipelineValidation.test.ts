import {
  integer,
  literal,
  number,
  picklist,
  pipe,
  safeInteger,
  string,
  union,
} from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { defineTable, reference } from '@/index'

import { waitForPostgres } from './postgres.setup'
import type { PostgresDatabaseContext } from './postgresIntegration'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const Values = defineTable(
  'pipeline_validation_values',
  {
    value: pipe(number(), safeInteger(), number(), integer()),
    composite: pipe(
      union([pipe(number(), safeInteger()), pipe(number(), safeInteger())]),
      number(),
      integer(),
    ),
    literal: pipe(literal<number>(2147483648), number(), integer()),
    choice: pipe(picklist([2147483648] as number[]), number(), integer()),
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

type PipelineContext = PostgresDatabaseContext<
  readonly [typeof Values, typeof References]
>

async function assertBigintStorage({ db, admin, schema }: PipelineContext) {
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
  ).toMatchObject({
    value: 'bigint',
    composite: 'bigint',
    literal: 'bigint',
    choice: 'bigint',
  })

  await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
}

async function assertInsertAndSelect({ db }: PipelineContext) {
  const row = {
    value: Number.MAX_SAFE_INTEGER,
    composite: Number.MAX_SAFE_INTEGER,
    literal: 2147483648,
    choice: 2147483648,
  } as const

  expect(await db.insert(Values).values(row).execute()).toEqual([row])
  expect(await db.from(Values).where({ value: row.value }).execute()).toEqual([row])

  expect(
    await db
      .from(Values)
      .select([Values.value, Values.composite])
      .where({ value: row.value })
      .execute(),
  ).toEqual([{ value: Number.MAX_SAFE_INTEGER, composite: Number.MAX_SAFE_INTEGER }])
}

async function assertUpdateReturning({ db }: PipelineContext) {
  const row = {
    value: Number.MAX_SAFE_INTEGER,
    composite: Number.MAX_SAFE_INTEGER,
    literal: 2147483648,
    choice: 2147483648,
  } as const

  const changed = {
    ...row,
    value: Number.MIN_SAFE_INTEGER,
    composite: Number.MIN_SAFE_INTEGER,
  } as const

  expect(
    await db
      .update(Values)
      .set({ value: changed.value, composite: changed.composite })
      .where({ value: row.value })
      .execute(),
  ).toEqual([changed])

  const updated = { ...changed, value: 2147483648, composite: 2147483648 } as const

  expect(
    await db
      .update(Values)
      .set({ value: updated.value, composite: updated.composite })
      .where({ value: changed.value })
      .execute(),
  ).toEqual([updated])

  expect(await db.from(Values).where({ value: updated.value }).execute()).toEqual([
    updated,
  ])
}

async function assertReferenceMapping({ db }: PipelineContext) {
  const reference = { id: 'ref', value: Number.MAX_SAFE_INTEGER }

  expect(await db.insert(References).values(reference).execute()).toEqual([reference])

  expect(await db.from(References).where({ value: reference.value }).execute()).toEqual([
    reference,
  ])

  await db.delete(References).where({ id: reference.id }).execute()
}

it('should migrate repeated safe-integer validation to bigint and round-trip JS numbers', async () => {
  await withPostgresDatabase([Values, References] as const, async (context) => {
    await assertBigintStorage(context)
    await assertInsertAndSelect(context)
    await assertReferenceMapping(context)
    await assertUpdateReturning(context)
  })
})
