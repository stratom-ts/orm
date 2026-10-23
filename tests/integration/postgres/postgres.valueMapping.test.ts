import { bigint, decimal, nullable, number, pipe, safeInteger, string } from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { column, defineTable, reference } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const Parent = defineTable(
  'mapped_numbers',
  {
    id: bigint(),
    safe: pipe(number(), safeInteger()),
    scaled: pipe(bigint(), column({ physicalType: { postgresql: 'numeric(30,3)' } })),
    amount: pipe(string(), decimal()),
    stamp: pipe(string(), column({ physicalType: { postgresql: 'timestamptz' } })),
    nullableValue: nullable(bigint()),
  },
  { primaryKey: 'id' },
)

const Child = defineTable(
  'mapped_number_refs',
  {
    id: string(),
    parentId: reference(Parent, 'id'),
    optionalParentId: nullable(reference(Parent, 'id')),
  },
  { primaryKey: 'id' },
)

it('should round-trip schema outputs through PostgreSQL writes, predicates, references, and results', async () => {
  await withPostgresDatabase([Parent, Child] as const, async ({ db, admin, schema }) => {
    expect((await db.migrate().plan()).steps.length).toBeGreaterThan(0)
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    const columns = await admin.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = $1 and table_name = 'mapped_numbers'`,
      [schema],
    )

    expect(
      Object.fromEntries(columns.rows.map((row) => [row.column_name, row.data_type])),
    ).toMatchObject({
      id: 'numeric',
      safe: 'bigint',
      scaled: 'numeric',
      amount: 'numeric',
      stamp: 'timestamp with time zone',
    })

    const parent = {
      id: 9223372036854775808n,
      safe: Number.MAX_SAFE_INTEGER,
      scaled: 9007199254740993n,
      amount: '12345.125',
      stamp: '2026-01-02T03:04:05.000Z',
      nullableValue: null,
    }

    expect(await db.insert(Parent).values(parent).execute()).toEqual([parent])
    expect(await db.from(Parent).where({ id: parent.id }).execute()).toEqual([parent])
    expect(await db.from(Parent).where({ safe: parent.safe }).execute()).toEqual([parent])

    const child = {
      id: 'child',
      parentId: parent.id,
      optionalParentId: null,
    }

    expect(await db.insert(Child).values(child).execute()).toEqual([child])
    expect(await db.from(Child).where({ parentId: parent.id }).execute()).toEqual([child])

    const changed = { ...parent, safe: Number.MIN_SAFE_INTEGER }
    expect(
      await db
        .update(Parent)
        .set({ safe: changed.safe })
        .where({ id: parent.id })
        .execute(),
    ).toEqual([changed])

    expect(await db.from(Parent).where({ id: parent.id }).execute()).toEqual([changed])
  })
})
