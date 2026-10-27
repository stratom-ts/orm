import {
  boolean,
  date,
  number,
  object,
  parseJson,
  pipe,
  string,
  toDate,
  toNumber,
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

it('should round-trip incompatible overrides through paired hooks', async () => {
  await withPostgresDatabase([Mapped] as const, async ({ db }) => {
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    const at = new Date('2026-01-02T03:04:05.000Z')
    const expected = {
      id: 'one',
      d: at,
      n: 1.5,
      b: true,
      tn: 42,
      td: at,
      j: { a: 1 },
      pj: { nested: [1, 'two'] },
      len: 5,
      num: 42.25,
    }

    const input = {
      id: 'one',
      d: at,
      n: 1.5,
      b: true,
      tn: '42',
      td: at.toISOString(),
      j: { a: 1 },
      pj: '{"nested":[1,"two"]}',
      len: 'hello',
      num: 42.25,
    }

    expect(await db.insert(Mapped).values(input).execute()).toEqual([expected])
    expect(await db.from(Mapped).execute()).toEqual([expected])

    expect(
      await db
        .insert(Mapped)
        .values({ ...input, id: 'two' })
        .returning([Mapped.d, Mapped.b, Mapped.j, Mapped.num])
        .execute(),
    ).toEqual([{ d: at, b: true, j: { a: 1 }, num: 42.25 }])
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
