import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { literal, pipe } from 'valibot'
import { expect, it, vi } from 'vitest'

import { lowerDesiredSchema } from '@/ddl/desiredSchema'
import { sqliteIdentity } from '@/dialects/sqlite/identity'
import { sqliteSchema } from '@/dialects/sqlite/schema'
import { column, createDatabase, defineTable } from '@/index'
import { MigrationError, SchemaError } from '@/utils/error'

const identities = sqliteIdentity.create({
  context: {
    writableDefault: [{ role: 'database' as const, spelling: 'main' }],
  },
})

const invalidNumericLiterals: readonly [string, number | bigint][] = [
  ['NaN', Number.NaN],
  ['positive infinity', Number.POSITIVE_INFINITY],
  ['negative infinity', Number.NEGATIVE_INFINITY],
  ['unsafe positive integer', Number.MAX_SAFE_INTEGER + 1],
  ['unsafe negative integer', Number.MIN_SAFE_INTEGER - 1],
  ['below the signed 64-bit bigint range', -9223372036854775809n],
  ['above the signed 64-bit bigint range', 9223372036854775808n],
]

it.each(invalidNumericLiterals)(
  'rejects a %s literal before acquiring a connector or exposing a Migration Program',
  async (_name, value) => {
    const InvalidRecords = defineTable(
      'invalid_records',
      { value: literal(value) },
      { primaryKey: 'value' },
    )

    const connector = nodeSqliteConnector({ name: ':memory:' })
    const getInstance = vi.spyOn(connector, 'getInstance')
    const exec = vi.spyOn(connector, 'exec')
    const prepare = vi.spyOn(connector, 'prepare')

    expect(() => createDatabase({ connector, schemas: [InvalidRecords] })).toThrow(
      SchemaError,
    )

    expect(getInstance).not.toHaveBeenCalled()
    expect(exec).not.toHaveBeenCalled()
    expect(prepare).not.toHaveBeenCalled()
  },
)

it.each([
  ['no mapping hooks', undefined, undefined, undefined, undefined],
  ['column parameter hook only', () => 'encoded', undefined, undefined, undefined],
  ['column result hook only', undefined, () => 1, undefined, undefined],
  ['client parameter hook only', undefined, undefined, () => 'encoded', undefined],
  ['client result hook only', undefined, undefined, undefined, () => 1],
])(
  'rejects an unsafe numeric literal with an explicit physical type and %s during lowering',
  async (_name, mapParam, mapResult, mapParamValue, mapResultValue) => {
    const InvalidRecords = defineTable(
      'invalid_explicit_records',
      {
        value: pipe(
          literal(Number.MAX_SAFE_INTEGER + 1),
          column({
            physicalType: { sqlite: 'INTEGER' },
            ...(mapParam ? { mapParam } : {}),
            ...(mapResult ? { mapResult } : {}),
          }),
        ),
      },
      { primaryKey: 'value' },
    )

    const connector = nodeSqliteConnector({ name: ':memory:' })
    const exec = vi.spyOn(connector, 'exec')
    const map = {
      ...(mapParamValue ? { mapParamValue } : {}),
      ...(mapResultValue ? { mapResultValue } : {}),
    }

    const db = createDatabase({ connector, schemas: [InvalidRecords], map })

    try {
      await expect(db.migrate().dryRun()).rejects.toThrow(MigrationError)
      expect(exec).not.toHaveBeenCalled()
    } finally {
      await db.close()
    }
  },
)

it('rejects an out-of-range bigint literal with an explicit BIGINT type for direct desired-schema lowering', () => {
  const InvalidRecords = defineTable(
    'invalid_explicit_bigint_records',
    {
      value: pipe(
        literal(9223372036854775808n),
        column({ physicalType: { sqlite: 'BIGINT' } }),
      ),
    },
    { primaryKey: 'value' },
  )

  expect(() => lowerDesiredSchema([InvalidRecords], identities, sqliteSchema)).toThrow(
    /signed 64-bit integer range/,
  )
})

it('leaves an existing SQLite catalog and seeded data unchanged when literal lowering fails', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  try {
    const native = await connector.getInstance!()
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
  } finally {
    await connector.dispose?.()
  }
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

  const db = createDatabase({
    connector: nodeSqliteConnector({ name: ':memory:' }),
    schemas: [LiteralValues],
  })

  const row = {
    id: Number.MIN_SAFE_INTEGER,
    maxInteger: Number.MAX_SAFE_INTEGER,
    realValue: 1.25,
    ordinaryBigInt: 42n,
    minBigInt,
    maxBigInt,
  } as const

  try {
    await db.migrate().execute()
    expect(await db.insert(LiteralValues).values(row).execute()).toEqual([row])
    expect(await db.from(LiteralValues).execute()).toEqual([row])
    expect((await db.migrate().dryRun()).actions).toEqual([])
  } finally {
    await db.close()
  }
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

  const db = createDatabase({
    connector: nodeSqliteConnector({ name: ':memory:' }),
    schemas: [Records],
    map: { mapParamValue: (_type, value) => String(value) },
  })

  try {
    await db.migrate().execute()

    expect(await db.insert(Records).values({ value: outOfRange }).execute()).toEqual([
      { value: outOfRange },
    ])

    expect(await db.from(Records).execute()).toEqual([{ value: outOfRange }])
  } finally {
    await db.close()
  }
})
