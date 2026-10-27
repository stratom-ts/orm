import {
  boolean,
  date,
  number,
  object,
  parseJson,
  pipe,
  string,
  toNumber,
  transform,
  uuid,
} from 'valibot'
import { expect, it, vi } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'
import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

import { createMockPostgresConnector } from '../helpers/nativePostgresClient'

type ColumnHooks = Pick<
  NonNullable<Parameters<typeof column>[0]>,
  'mapParam' | 'mapResult'
>

type ClientHooks = NonNullable<Parameters<typeof createDatabase>[0]['map']>

it.each<[string, AnySchema, string]>([
  ['date/text', date(), 'text'],
  ['number/varchar', number(), 'varchar(20)'],
  ['number/numeric', number(), 'numeric'],
  ['boolean/text', boolean(), 'text'],
  ['object/text', object({ a: number() }), 'text'],
  ['converted number/text', pipe(string(), toNumber()), 'text'],
  ['parsed JSON/text', pipe(string(), parseJson()), 'text'],
  ['transformed string/text', pipe(string(), transform(Number)), 'text'],
])(
  'should reject %s at client construction before opening a session',
  (_name, schema, type) => {
    const Records = defineTable(
      'records',
      {
        id: string(),
        value: pipe(schema, column({ physicalType: { postgresql: type } })),
      },
      { primaryKey: 'id' },
    )

    const connector = createMockPostgresConnector()
    const getInstance = vi.spyOn(connector, 'getInstance')

    expect(() => createDatabase({ connector, schemas: [Records] })).toThrow(SchemaError)

    expect(() => createDatabase({ connector, schemas: [Records] })).toThrow(
      /requires explicit parameter and result mappings.*mapParam\/mapResult/,
    )

    expect(getInstance).not.toHaveBeenCalled()
  },
)

it.each<[string, ColumnHooks, ClientHooks]>([
  ['column parameter', { mapParam: () => 'now' }, {}],
  ['column result', { mapResult: () => new Date(0) }, {}],
  ['client parameter', {}, { mapParamValue: () => 'now' }],
  ['client result', {}, { mapResultValue: () => new Date(0) }],
])(
  'should reject an incompatible override with only a %s override',
  (_direction, hooks, map) => {
    const Records = defineTable(
      'records',
      {
        id: string(),
        value: pipe(date(), column({ physicalType: { postgresql: 'text' }, ...hooks })),
      },
      { primaryKey: 'id' },
    )

    const create = () =>
      createDatabase({
        connector: createMockPostgresConnector(),
        schemas: [Records],
        map,
      })

    expect(create).toThrow(SchemaError)
    expect(create).toThrow(/requires explicit parameter and result mappings/)
  },
)

it('should accept an incompatible override with paired column hooks', async () => {
  const Records = defineTable(
    'records',
    {
      id: string(),
      value: pipe(
        date(),
        column({
          physicalType: { postgresql: 'text' },
          mapParam: (value) => (value as Date).toISOString(),
          mapResult: (value) => new Date(String(value)),
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  const value = new Date('2026-01-01T00:00:00.000Z')
  const db = createDatabase({
    connector: createMockPostgresConnector({
      rowsBySql: () => [{ id: 'one', value: value.toISOString() }],
    }),
    schemas: [Records],
  })

  expect(db.insert(Records).values({ id: 'one', value }).compile().params).toEqual([
    'one',
    value.toISOString(),
  ])

  await expect(db.from(Records).execute()).resolves.toEqual([{ id: 'one', value }])
  await db.close()
})

it('should accept an incompatible override with paired client hooks', async () => {
  const Records = defineTable(
    'records',
    {
      id: string(),
      value: pipe(number(), column({ physicalType: { postgresql: 'numeric' } })),
    },
    { primaryKey: 'id' },
  )

  const db = createDatabase({
    connector: createMockPostgresConnector({
      rowsBySql: () => [{ id: 'one', value: '42.25' }],
    }),
    schemas: [Records],
    map: {
      mapParamValue: (type, value) => (type === 'numeric' ? String(value) : value),
      mapResultValue: (type, value) => (type === 'numeric' ? Number(value) : value),
    },
  })

  expect(db.insert(Records).values({ id: 'one', value: 42.25 }).compile().params).toEqual(
    ['one', '42.25'],
  )

  await expect(db.from(Records).execute()).resolves.toEqual([{ id: 'one', value: 42.25 }])
  await db.close()
})

it.each<[string, AnySchema, string]>([
  ['string/varchar', string(), 'varchar(40)'],
  ['number/integer', number(), 'integer'],
  ['date/timestamp', date(), 'timestamp'],
  ['uuid/text', pipe(string(), uuid()), 'text'],
])('should accept compatible %s overrides without hooks', (_name, schema, type) => {
  const Records = defineTable(
    'records',
    { id: string(), value: pipe(schema, column({ physicalType: { postgresql: type } })) },
    { primaryKey: 'id' },
  )

  expect(() =>
    createDatabase({ connector: createMockPostgresConnector(), schemas: [Records] }),
  ).not.toThrow()
})
