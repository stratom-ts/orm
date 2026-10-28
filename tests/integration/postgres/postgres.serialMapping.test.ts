import type { Client } from 'pg'
import { bigint, nullable, number, pipe, string } from 'valibot'
import { beforeAll, expect, expectTypeOf, it } from 'vitest'

import { column, defineTable, reference } from '@/index'
import type { InferSelect } from '@/index'
import { QueryError } from '@/utils/error'

import { waitForPostgres } from './postgres.setup'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const Serial = defineTable(
  'serial_outputs',
  {
    id: string(),
    smallNumber: pipe(number(), column({ physicalType: { postgresql: 'smallserial' } })),
    serialNumber: pipe(number(), column({ physicalType: { postgresql: 'serial' } })),
    bigNumber: pipe(number(), column({ physicalType: { postgresql: 'bigserial' } })),
    smallBigint: pipe(bigint(), column({ physicalType: { postgresql: 'smallserial' } })),
    serialBigint: pipe(bigint(), column({ physicalType: { postgresql: 'serial' } })),
    bigBigint: pipe(bigint(), column({ physicalType: { postgresql: 'bigserial' } })),
    nullableBigint: nullable(
      pipe(bigint(), column({ physicalType: { postgresql: 'bigserial' } })),
    ),
  },
  { primaryKey: 'id' },
)

const References = defineTable(
  'serial_references',
  {
    id: string(),
    small: reference(Serial, 'smallBigint'),
    serial: reference(Serial, 'serialBigint'),
    big: reference(Serial, 'bigBigint'),
    optionalBig: nullable(reference(Serial, 'bigBigint')),
  },
  { primaryKey: 'id' },
)

type SerialRow = {
  id: string
  smallNumber: number
  serialNumber: number
  bigNumber: number
  smallBigint: bigint
  serialBigint: bigint
  bigBigint: bigint
  nullableBigint: bigint | null
}

/** Creates native serial storage independently of migration pseudo-type handling. */
async function createSerialTables(admin: Client, schema: string): Promise<void> {
  const namespace = quoteIdentifier(schema)
  await admin.query(`create table ${namespace}.serial_outputs (
    id text primary key,
    "smallNumber" smallserial,
    "serialNumber" serial,
    "bigNumber" bigserial,
    "smallBigint" smallserial unique,
    "serialBigint" serial unique,
    "bigBigint" bigserial unique,
    "nullableBigint" bigint
  )`)

  await admin.query(`create table ${namespace}.serial_references (
    id text primary key,
    small smallint references ${namespace}.serial_outputs ("smallBigint"),
    serial integer references ${namespace}.serial_outputs ("serialBigint"),
    big bigint references ${namespace}.serial_outputs ("bigBigint"),
    "optionalBig" bigint references ${namespace}.serial_outputs ("bigBigint")
  )`)
}

const original: SerialRow = {
  id: 'one',
  smallNumber: 12,
  serialNumber: 123456,
  bigNumber: Number.MAX_SAFE_INTEGER,
  smallBigint: 23n,
  serialBigint: 234567n,
  bigBigint: 9007199254740993n,
  nullableBigint: null,
}

it('should exercise the underlying native integer types and driver representations', async () => {
  await withPostgresDatabase([Serial] as const, async ({ db, admin, schema }) => {
    await createSerialTables(admin, schema)
    await db.insert(Serial).values(original).execute()

    const columns = await admin.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
       where table_schema = $1 and table_name = 'serial_outputs'`,
      [schema],
    )

    expect(
      Object.fromEntries(
        columns.rows.map(({ column_name, data_type }) => [column_name, data_type]),
      ),
    ).toMatchObject({
      smallNumber: 'smallint',
      serialNumber: 'integer',
      bigNumber: 'bigint',
      smallBigint: 'smallint',
      serialBigint: 'integer',
      bigBigint: 'bigint',
    })

    const raw = await admin.query(
      `select "smallBigint", "serialBigint", "bigBigint", "bigNumber"
       from ${quoteIdentifier(schema)}.serial_outputs where id = $1`,
      ['one'],
    )

    expect(raw.rows).toEqual([
      {
        smallBigint: 23,
        serialBigint: 234567,
        bigBigint: '9007199254740993',
        bigNumber: '9007199254740991',
      },
    ])
  })
})

it('should preserve serial number and bigint outputs through writes and predicates', async () => {
  expectTypeOf<InferSelect<typeof Serial>>().toEqualTypeOf<SerialRow>()

  await withPostgresDatabase([Serial] as const, async ({ db, admin, schema }) => {
    await createSerialTables(admin, schema)
    const inserted = await db.insert(Serial).values(original).execute()
    expectTypeOf(inserted).toEqualTypeOf<SerialRow[]>()
    expect(inserted).toEqual([original])
    const selected = await db
      .from(Serial)
      .where({
        smallNumber: 12,
        serialNumber: 123456,
        bigNumber: Number.MAX_SAFE_INTEGER,
        smallBigint: 23n,
        serialBigint: 234567n,
        bigBigint: 9007199254740993n,
      })
      .execute()

    expectTypeOf(selected).toEqualTypeOf<SerialRow[]>()
    expect(selected).toEqual([original])
  })
})

it('should preserve serial outputs in update returning projections', async () => {
  await withPostgresDatabase([Serial] as const, async ({ db, admin, schema }) => {
    await createSerialTables(admin, schema)
    await db.insert(Serial).values(original).execute()
    const changed: SerialRow = {
      ...original,
      smallNumber: -12,
      serialNumber: -123456,
      bigNumber: Number.MIN_SAFE_INTEGER,
      smallBigint: -23n,
      serialBigint: -234567n,
      bigBigint: -9007199254740993n,
      nullableBigint: 42n,
    }

    const { id: _id, ...changes } = changed
    const returned = await db
      .update(Serial)
      .set(changes)
      .where({ id: 'one' })
      .returning([
        Serial.smallNumber,
        Serial.serialNumber,
        Serial.bigNumber,
        Serial.smallBigint,
        Serial.serialBigint,
        Serial.bigBigint,
        Serial.nullableBigint,
      ])
      .execute()

    expectTypeOf(returned).toEqualTypeOf<Omit<SerialRow, 'id'>[]>()
    expect(returned).toEqual([changes])
    expect(await db.from(Serial).where({ id: 'one' }).execute()).toEqual([changed])
  })
})

it('should inherit serial mapping for references and preserve insert returning types', async () => {
  expectTypeOf<InferSelect<typeof References>>().toEqualTypeOf<{
    id: string
    small: bigint
    serial: bigint
    big: bigint
    optionalBig: bigint | null
  }>()

  await withPostgresDatabase(
    [Serial, References] as const,
    async ({ db, admin, schema }) => {
      await createSerialTables(admin, schema)
      await db.insert(Serial).values(original).execute()
      const child = {
        id: 'child',
        small: 23n,
        serial: 234567n,
        big: 9007199254740993n,
        optionalBig: null,
      }

      expect(await db.insert(References).values(child).execute()).toEqual([child])

      expect(
        await db
          .from(References)
          .where({ small: child.small, serial: child.serial, big: child.big })
          .execute(),
      ).toEqual([child])

      const insertedReturn = await db
        .insert(Serial)
        .values({
          ...original,
          id: 'two',
          smallBigint: 24n,
          serialBigint: 234568n,
          bigBigint: 9007199254740994n,
        })
        .returning([Serial.bigNumber, Serial.bigBigint])
        .execute()

      expectTypeOf(insertedReturn).toEqualTypeOf<
        { bigNumber: number; bigBigint: bigint }[]
      >()

      expect(insertedReturn).toEqual([
        { bigNumber: Number.MAX_SAFE_INTEGER, bigBigint: 9007199254740994n },
      ])
    },
  )
})

it('should reject unsafe bigserial numbers before writes and after native reads', async () => {
  await withPostgresDatabase([Serial] as const, async ({ db, admin, schema }) => {
    await createSerialTables(admin, schema)
    await db.insert(Serial).values(original).execute()

    await expect(
      db
        .insert(Serial)
        .values({ ...original, id: 'unsafe', bigNumber: 9007199254740992 })
        .execute(),
    ).rejects.toBeInstanceOf(QueryError)

    await expect(
      db
        .update(Serial)
        .set({ bigNumber: -9007199254740992 })
        .where({ id: 'one' })
        .execute(),
    ).rejects.toBeInstanceOf(QueryError)

    await expect(
      db.from(Serial).where({ bigNumber: 9007199254740992 }).execute(),
    ).rejects.toBeInstanceOf(QueryError)

    expect(await db.from(Serial).execute()).toEqual([original])

    await admin.query(
      `update ${quoteIdentifier(schema)}.serial_outputs set "bigNumber" = $1 where id = $2`,
      ['9007199254740993', 'one'],
    )

    await expect(db.from(Serial).where({ id: 'one' }).execute()).rejects.toBeInstanceOf(
      QueryError,
    )

    await expect(
      db
        .update(Serial)
        .set({ serialNumber: 7 })
        .where({ id: 'one' })
        .returning([Serial.bigNumber])
        .execute(),
    ).rejects.toBeInstanceOf(QueryError)
  })
})
