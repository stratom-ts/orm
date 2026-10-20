import { array, bigint, boolean, date, number, object, pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'
import type { AnySchema } from '@/types/schema'

import { customConnector } from '../helpers/operationSessionFixtures'

import { createSqliteControllableProvider } from './sqliteSharedFixtures'

it.each<[string, AnySchema, string | number | boolean | null, string]>([
  ['Boolean numeric value outside 0/1', boolean(), 2, 'INTEGER'],
  ['number with unconverted numeric text', number(), '12', 'BLOB'],
  ['number with non-ASCII numeric whitespace', number(), '0\u00a0', 'INTEGER'],
  ['number with hex text', number(), '0x10', 'NUMERIC'],
  ['unsafe numeric literal', number(), Number.MAX_SAFE_INTEGER + 1, 'INTEGER'],
  ['unsafe REAL numeric text', number(), '9007199254740993', 'REAL'],
  [
    'bigint with a decimal stored as REAL at the signed64 boundary',
    bigint(),
    '-9223372036854775808.0',
    'INTEGER',
  ],
  ['object with scalar JSON', object({}), '123', 'JSON'],
  ['object with array JSON', object({}), '[]', 'JSON'],
  ['array with object JSON', array(string()), '{}', 'TEXT'],
  ['Date with time-only text', date(), '12:34:56', 'TEXT'],
])(
  'should reject %s during desired-schema validation',
  async (_name, schema, value, type) => {
    const Records = defineTable(
      'records',
      {
        id: number(),
        value: pipe(
          schema,
          column({
            physicalType: { sqlite: type },
            databaseDefault: { kind: 'literal', value },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    const db = createDatabase({
      connector: customConnector('sqlite'),
      schemas: [Records],
      operationSessionProvider: createSqliteControllableProvider().provider,
    })

    try {
      await expect(db.migrate().dryRun()).rejects.toMatchObject({
        stage: 'planning',
        outcome: 'unchanged',
      })
    } finally {
      await db.close()
    }
  },
)

it('should not let a parameter-only mapping approve incompatible omitted defaults', async () => {
  const Records = defineTable(
    'records',
    {
      id: number(),
      value: pipe(
        boolean(),
        column({
          databaseDefault: { kind: 'literal', value: 'false' },
          mapParam: (value) => (value ? 1 : 0),
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  const db = createDatabase({
    connector: customConnector('sqlite'),
    schemas: [Records],
    operationSessionProvider: createSqliteControllableProvider().provider,
    map: { mapParamValue: (_type, value) => value },
  })

  try {
    await expect(db.migrate().dryRun()).rejects.toMatchObject({
      stage: 'planning',
      outcome: 'unchanged',
    })
  } finally {
    await db.close()
  }
})
