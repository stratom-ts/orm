import {
  boolean,
  date,
  isoDate,
  isoDateTime,
  isoTimeSecond,
  isoTimestamp,
  number,
  object,
  parseJson,
  parse as parseSchema,
  pipe,
  string,
  toBoolean,
  toDate,
  toNumber,
  toString,
  transform,
  uuid,
} from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { column, defineTable } from '@/index'
import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const parseText = (value: unknown) => JSON.parse(String(value)) as unknown

it.each<[string, AnySchema, string]>([
  ['date', date(), 'text'],
  ['number', number(), 'text'],
  ['boolean', boolean(), 'text'],
  ['toNumber', pipe(string(), toNumber()), 'text'],
  ['toDate', pipe(string(), toDate()), 'text'],
  ['toBoolean', pipe(string(), toBoolean()), 'text'],
  ['toString', pipe(number(), toString()), 'integer'],
  ['object', object({ a: number() }), 'text'],
  ['parseJson', pipe(string(), parseJson()), 'text'],
  [
    'unknown transform',
    pipe(
      string(),
      transform((value) => value.length),
    ),
    'text',
  ],
  ['numeric number', number(), 'numeric'],
  ['isoDate/timestamptz', pipe(string(), isoDate()), 'timestamptz'],
  ['isoDate/timestamp', pipe(string(), isoDate()), 'timestamp'],
  ['isoDateTime/timestamptz', pipe(string(), isoDateTime()), 'timestamptz'],
  ['isoDateTime/date', pipe(string(), isoDateTime()), 'date'],
  ['isoTimestamp/timestamp', pipe(string(), isoTimestamp()), 'timestamp'],
])(
  'should reject a %s output in %s storage at client creation',
  async (_name, schema, type) => {
    const Rejected = defineTable(
      'override_rejected',
      {
        id: string(),
        value: pipe(schema, column({ physicalType: { postgresql: type } })),
      },
      { primaryKey: 'id' },
    )

    await withPostgresDatabase([], async ({ createDatabase }) => {
      expect(() => createDatabase([Rejected])).toThrow(SchemaError)
      expect(() => createDatabase([Rejected])).toThrow(/mapParam\/mapResult/)
    })
  },
)

const Mapped = defineTable(
  'override_mapped',
  {
    id: string(),
    d: pipe(
      date(),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: (value) => (value as Date).toISOString(),
        mapResult: (value) => new Date(String(value)),
      }),
    ),
    n: pipe(
      number(),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: String,
        mapResult: Number,
      }),
    ),
    b: pipe(
      boolean(),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: String,
        mapResult: (value) => value === 'true',
      }),
    ),
    tn: pipe(
      string(),
      toNumber(),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: String,
        mapResult: Number,
      }),
    ),
    td: pipe(
      string(),
      toDate(),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: (value) => (value as Date).toISOString(),
        mapResult: (value) => new Date(String(value)),
      }),
    ),
    tb: pipe(
      string(),
      toBoolean(),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: String,
        mapResult: (value) => value === 'true',
      }),
    ),
    ts: pipe(
      number(),
      toString(),
      column({
        physicalType: { postgresql: 'integer' },
        mapParam: Number,
        mapResult: String,
      }),
    ),
    j: pipe(
      object({ a: number() }),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: (value) => JSON.stringify(value),
        mapResult: parseText,
      }),
    ),
    pj: pipe(
      string(),
      parseJson(),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: (value) => JSON.stringify(value),
        mapResult: parseText,
      }),
    ),
    len: pipe(
      string(),
      transform((value) => value.length),
      column({
        physicalType: { postgresql: 'text' },
        mapParam: String,
        mapResult: Number,
      }),
    ),
    num: pipe(
      number(),
      column({
        physicalType: { postgresql: 'numeric' },
        mapParam: String,
        mapResult: Number,
      }),
    ),
  },
  { primaryKey: 'id' },
)

const mappedAt = new Date('2026-01-02T03:04:05.000Z')
const mappedOutput = {
  id: 'one',
  d: mappedAt,
  n: 1.5,
  b: true,
  tn: 42,
  td: mappedAt,
  tb: true,
  ts: '7',
  j: { a: 1 },
  pj: { nested: [1, 'two'] },
  len: 5,
  num: 42.25,
}

const mappedInput = {
  id: 'one',
  d: mappedAt,
  n: 1.5,
  b: true,
  tn: '42',
  td: mappedAt.toISOString(),
  tb: 'true',
  ts: 7,
  j: { a: 1 },
  pj: '{"nested":[1,"two"]}',
  len: 'hello',
  num: 42.25,
}

const MAPPED_OUTPUTS = [
  Mapped.d,
  Mapped.n,
  Mapped.b,
  Mapped.tn,
  Mapped.td,
  Mapped.tb,
  Mapped.ts,
  Mapped.j,
  Mapped.pj,
  Mapped.len,
  Mapped.num,
]

it('should round-trip incompatible overrides through paired hooks', async () => {
  await withPostgresDatabase([Mapped] as const, async ({ db }) => {
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    expect(await db.insert(Mapped).values(mappedInput).execute()).toEqual([mappedOutput])
    expect(await db.from(Mapped).execute()).toEqual([mappedOutput])

    const { id: _id, ...returned } = mappedOutput

    expect(
      await db
        .insert(Mapped)
        .values({ ...mappedInput, id: 'two' })
        .returning(MAPPED_OUTPUTS)
        .execute(),
    ).toEqual([returned])
  })
})

const Compatible = defineTable(
  'override_compatible',
  {
    id: string(),
    s: pipe(string(), column({ physicalType: { postgresql: 'varchar(40)' } })),
    n: pipe(number(), column({ physicalType: { postgresql: 'integer' } })),
    d: pipe(date(), column({ physicalType: { postgresql: 'timestamp' } })),
    u: pipe(string(), uuid(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id' },
)

it('should round-trip compatible overrides without hooks', async () => {
  await withPostgresDatabase([Compatible] as const, async ({ db }) => {
    await db.migrate().execute()

    const row = {
      id: 'one',
      s: 'label',
      n: 7,
      d: new Date('2026-01-02T03:04:05.000Z'),
      u: '550e8400-e29b-41d4-a716-446655440000',
    }

    expect(await db.insert(Compatible).values(row).execute()).toEqual([row])
    expect(await db.from(Compatible).execute()).toEqual([row])

    expect(
      await db
        .insert(Compatible)
        .values({ ...row, id: 'two' })
        .returning([Compatible.n, Compatible.d])
        .execute(),
    ).toEqual([{ n: row.n, d: row.d }])
  })
})

const StorageOutputs = defineTable(
  'override_storage_outputs',
  {
    id: string(),
    fixed: pipe(string(), column({ physicalType: { postgresql: 'char(4)' } })),
    money: pipe(string(), column({ physicalType: { postgresql: 'money' } })),
    day: pipe(date(), column({ physicalType: { postgresql: 'date' } })),
    float: pipe(number(), column({ physicalType: { postgresql: 'real' } })),
    document: pipe(
      object({ value: number() }),
      column({ physicalType: { postgresql: 'json' } }),
    ),
    plainTime: pipe(string(), column({ physicalType: { postgresql: 'time' } })),
    plainLocal: pipe(string(), column({ physicalType: { postgresql: 'timestamp' } })),
    plainZone: pipe(string(), column({ physicalType: { postgresql: 'timestamptz' } })),
  },
  { primaryKey: 'id' },
)

it('should preserve each accepted PostgreSQL storage representation through native results', async () => {
  await withPostgresDatabase([StorageOutputs], async ({ db, connector }) => {
    await (await connector.getInstance!()).query("set lc_monetary to 'C'")
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
    const input = {
      id: 'one',
      fixed: 'ABCD',
      money: '42.25',
      day: new Date('2026-01-02T00:00:00.000Z'),
      float: 1.5,
      document: { value: 7 },
      plainTime: '03:04:05',
      plainLocal: '2026-01-02T03:04:05',
      plainZone: '2026-01-02T03:04:05Z',
    }

    const output = {
      ...input,
      money: '$42.25',
      plainLocal: '2026-01-02T03:04:05.000Z',
      plainZone: '2026-01-02T03:04:05.000Z',
    }

    expect(await db.insert(StorageOutputs).values(input).execute()).toEqual([output])

    // PostgreSQL json has no equality operator. JSONB predicates run in the shared scenario.
    const { document: _document, ...predicate } = input
    expect(await db.from(StorageOutputs).where(predicate).execute()).toEqual([output])

    const changed = {
      ...input,
      fixed: 'EFGH',
      money: '43.50',
      day: new Date('2026-01-03T00:00:00.000Z'),
      float: 2.5,
      document: { value: 8 },
      plainTime: '04:05:06',
      plainLocal: '2026-01-03T04:05:06',
      plainZone: '2026-01-03T04:05:06Z',
    }

    const next = {
      ...changed,
      money: '$43.50',
      plainLocal: '2026-01-03T04:05:06.000Z',
      plainZone: '2026-01-03T04:05:06.000Z',
    }

    expect(
      await db.update(StorageOutputs).set(changed).where({ id: 'one' }).execute(),
    ).toEqual([next])

    expect(await db.from(StorageOutputs).where({ id: 'one' }).execute()).toEqual([next])
  })
})

const safeTimeSchema = pipe(string(), isoTimeSecond())
const SafeTemporal = defineTable(
  'override_safe_temporal',
  {
    id: string(),
    at: pipe(safeTimeSchema, column({ physicalType: { postgresql: 'time(0)' } })),
  },
  { primaryKey: 'id' },
)

it('should round-trip safe ISO temporal precision and converge migrations', async () => {
  await withPostgresDatabase([SafeTemporal] as const, async ({ db }) => {
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    const row = { id: 'one', at: '03:04:05' }
    const inserted = await db.insert(SafeTemporal).values(row).execute()
    const selected = await db.from(SafeTemporal).execute()
    const returned = await db
      .insert(SafeTemporal)
      .values({ ...row, id: 'two' })
      .returning([SafeTemporal.at])
      .execute()

    expect(inserted).toEqual([row])
    expect(selected).toEqual([row])
    expect(returned).toEqual([{ at: row.at }])
    for (const result of [inserted[0]?.at, selected[0]?.at, returned[0]?.at])
      expect(parseSchema(safeTimeSchema, result)).toBe(row.at)
  })
})

const pairedDaySchema = pipe(string(), isoDate())
const PairedTemporal = defineTable(
  'override_paired_temporal',
  {
    id: string(),
    day: pipe(
      pairedDaySchema,
      column({
        physicalType: { postgresql: 'timestamp(0)' },
        mapParam: (value) => `${String(value)} 00:00:00`,
        mapResult: (value) => String(value).slice(0, 10),
      }),
    ),
  },
  { primaryKey: 'id' },
)

it('should round-trip an incompatible ISO override through paired hooks', async () => {
  await withPostgresDatabase([PairedTemporal] as const, async ({ db }) => {
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    const row = { id: 'one', day: '2026-01-02' }
    const inserted = await db.insert(PairedTemporal).values(row).execute()
    const selected = await db.from(PairedTemporal).execute()
    const returned = await db
      .insert(PairedTemporal)
      .values({ ...row, id: 'two' })
      .returning([PairedTemporal.day])
      .execute()

    expect(inserted).toEqual([row])
    expect(selected).toEqual([row])
    expect(returned).toEqual([{ day: row.day }])
    for (const result of [inserted[0]?.day, selected[0]?.day, returned[0]?.day])
      expect(parseSchema(pairedDaySchema, result)).toBe(row.day)
  })
})
