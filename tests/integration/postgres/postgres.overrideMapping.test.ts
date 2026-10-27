import {
  boolean,
  date,
  number,
  object,
  parseJson,
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
