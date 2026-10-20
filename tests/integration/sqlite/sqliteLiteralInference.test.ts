import { literal, pipe } from 'valibot'
import { expect, it, vi } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'
import { SchemaError } from '@/utils/error'

import { withSqliteConnector, withSqliteDatabase } from './sqliteIntegration'

it('leaves an existing SQLite catalog and seeded data unchanged when literal lowering fails', async () => {
  await withSqliteConnector(async ({ connector, native }) => {
    native.exec(
      "create table seed(id INTEGER primary key, value TEXT); insert into seed values(7, 'kept')",
    )

    const beforeSchema = native
      .prepare('select name,sql from sqlite_schema order by name')
      .all()

    const beforeData = native.prepare('select * from seed').all()
    const getInstance = vi.spyOn(connector, 'getInstance')
    const exec = vi.spyOn(connector, 'exec')
    const prepare = vi.spyOn(connector, 'prepare')
    const InvalidRecords = defineTable(
      'invalid_records',
      { value: literal(9223372036854775808n) },
      { primaryKey: 'value' },
    )

    expect(() => createDatabase({ connector, schemas: [InvalidRecords] })).toThrow(
      SchemaError,
    )

    expect(getInstance).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()

    expect(
      native.prepare('select name,sql from sqlite_schema order by name').all(),
    ).toEqual(beforeSchema)

    expect(native.prepare('select * from seed').all()).toEqual(beforeData)
  })
})

it('migrates, round-trips supported number and bigint literal boundaries, then has an empty second dry run', async () => {
  const minBigInt = -9223372036854775808n
  const maxBigInt = 9223372036854775807n
  const LiteralValues = defineTable(
    'literal_values',
    {
      id: literal(Number.MIN_SAFE_INTEGER),
      maxInteger: literal(Number.MAX_SAFE_INTEGER),
      realValue: literal(1.25),
      ordinaryBigInt: literal(42n),
      minBigInt: literal(minBigInt),
      maxBigInt: literal(maxBigInt),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([LiteralValues], async ({ db }) => {
    const row = {
      id: Number.MIN_SAFE_INTEGER,
      maxInteger: Number.MAX_SAFE_INTEGER,
      realValue: 1.25,
      ordinaryBigInt: 42n,
      minBigInt,
      maxBigInt,
    } as const

    await db.migrate().execute()
    expect(await db.insert(LiteralValues).values(row).execute()).toEqual([row])
    expect(await db.from(LiteralValues).execute()).toEqual([row])
    expect((await db.migrate().dryRun()).actions).toEqual([])
  })
})

it('allows paired explicit mappings to represent an out-of-range bigint literal in BLOB storage', async () => {
  const outOfRange = 9223372036854775808n
  const Records = defineTable(
    'literal_blob_records',
    {
      value: pipe(
        literal(outOfRange),
        column({
          physicalType: { sqlite: 'BLOB' },
          mapResult: (value) => BigInt(String(value)),
        }),
      ),
    },
    { primaryKey: 'value' },
  )

  await withSqliteDatabase(
    [Records],
    async ({ db }) => {
      await db.migrate().execute()

      expect(await db.insert(Records).values({ value: outOfRange }).execute()).toEqual([
        { value: outOfRange },
      ])

      expect(await db.from(Records).execute()).toEqual([{ value: outOfRange }])
    },
    { map: { mapParamValue: (_type, value) => String(value) } },
  )
})
