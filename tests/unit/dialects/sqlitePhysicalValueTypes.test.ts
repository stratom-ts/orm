import {
  bigint,
  boolean,
  integer,
  nullable,
  number,
  picklist,
  pipe,
  string,
  transform,
  unknown,
} from 'valibot'
import { expect, it, vi } from 'vitest'

import { column, createDatabase, defineTable, reference } from '@/index'
import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

import { customConnector } from '../helpers/operationSessionFixtures'

it.each<[string, AnySchema, string]>([
  ['number/TEXT', number(), 'TEXT'],
  ['boolean/TEXT', boolean(), 'TEXT'],
  ['string/INTEGER', string(), 'INTEGER'],
  ['string/NUMERIC', string(), 'NUMERIC'],
  ['string/REAL', string(), 'REAL'],
  ['string/FLOATING POINT', string(), 'FLOATING POINT'],
  ['string/STRING', string(), 'STRING'],
  ['bigint/REAL', bigint(), 'REAL'],
  ['bigint/TEXT', bigint(), 'TEXT'],
  ['unknown/TEXT', unknown(), 'TEXT'],
  ['mixed picklist/TEXT', picklist(['123', 123]), 'TEXT'],
  ['nullable boolean/TEXT', nullable(boolean()), 'TEXT'],
  ['transformed string/TEXT', pipe(string(), transform(Number)), 'TEXT'],
  [
    'nullable transformed string/TEXT',
    nullable(pipe(string(), transform(Number))),
    'TEXT',
  ],
])(
  'rejects %s at client construction before opening a session or issuing SQL',
  (_name, schema, type) => {
    const Records = defineTable(
      'records',
      {
        id: pipe(number(), integer()),
        value: pipe(schema, column({ physicalType: { sqlite: type } })),
      },
      { primaryKey: 'id' },
    )

    const connector = customConnector('sqlite')
    const getInstance = vi.spyOn(connector, 'getInstance')

    expect(() => createDatabase({ connector, schemas: [Records] })).toThrow(SchemaError)

    expect(() => createDatabase({ connector, schemas: [Records] })).toThrow(
      /requires explicit parameter and result mappings/,
    )

    expect(getInstance).not.toHaveBeenCalled()
  },
)

it.each(['column parameter', 'column result', 'client parameter', 'client result'])(
  'rejects an unsupported mapping with only a %s override',
  (direction) => {
    const Records = defineTable(
      'records',
      {
        value: pipe(
          boolean(),
          column({
            physicalType: { sqlite: 'TEXT' },
            ...(direction === 'column parameter' ? { mapParam: () => 'false' } : {}),
            ...(direction === 'column result' ? { mapResult: () => false } : {}),
          }),
        ),
      },
      { primaryKey: 'value' },
    )

    expect(() =>
      createDatabase({
        connector: customConnector('sqlite'),
        schemas: [Records],
        map: {
          ...(direction === 'client parameter' ? { mapParamValue: () => 'false' } : {}),
          ...(direction === 'client result' ? { mapResultValue: () => false } : {}),
        },
      }),
    ).toThrow(SchemaError)
  },
)

it('rejects a reference override whose affinity cannot preserve its target logical strings', () => {
  const Parents = defineTable(
    'parents',
    { value: pipe(string(), column({ unique: true })) },
    { primaryKey: 'value' },
  )

  const Children = defineTable(
    'children',
    {
      value: pipe(
        reference(Parents, 'value'),
        column({ physicalType: { sqlite: 'INTEGER' } }),
      ),
    },
    { primaryKey: 'value' },
  )

  expect(() =>
    createDatabase({
      connector: customConnector('sqlite'),
      schemas: [Parents, Children],
    }),
  ).toThrow(SchemaError)
})

it.each([false, true])(
  'rejects local reference transformations before SQL (nullable: %s)',
  (allowNull) => {
    const Parents = defineTable('parents', { value: string() }, { primaryKey: 'value' })
    const transformed = pipe(reference(Parents, 'value'), transform(Number))
    const Children = defineTable(
      'children',
      {
        id: pipe(number(), integer()),
        value: pipe(
          allowNull ? nullable(transformed) : transformed,
          column({ physicalType: { sqlite: 'TEXT' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const connector = customConnector('sqlite')
    const getInstance = vi.spyOn(connector, 'getInstance')

    expect(() => createDatabase({ connector, schemas: [Parents, Children] })).toThrow(
      SchemaError,
    )

    expect(getInstance).not.toHaveBeenCalled()
  },
)
