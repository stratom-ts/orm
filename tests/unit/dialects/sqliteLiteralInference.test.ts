import { literal, pipe } from 'valibot'
import { expect, it, vi } from 'vitest'

import { lowerDesiredSchema } from '@/ddl/desiredSchema'
import { sqliteIdentity } from '@/dialects/sqlite/identity'
import { sqliteSchema } from '@/dialects/sqlite/schema'
import { column, createDatabase, defineTable } from '@/index'
import { MigrationError, SchemaError } from '@/utils/error'

import { customConnector } from '../helpers/operationSessionFixtures'

import { createSqliteControllableProvider } from './sqliteSharedFixtures'

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

    const connector = customConnector('sqlite')
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

    const connector = customConnector('sqlite')
    const exec = vi.spyOn(connector, 'exec')
    const map = {
      ...(mapParamValue ? { mapParamValue } : {}),
      ...(mapResultValue ? { mapResultValue } : {}),
    }

    const db = createDatabase({
      connector,
      schemas: [InvalidRecords],
      map,
      operationSessionProvider: createSqliteControllableProvider().provider,
    })

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
