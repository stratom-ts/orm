import {
  boolean,
  date,
  enum as enumSchema,
  exactOptional,
  integer,
  literal,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  number,
  object,
  optional,
  picklist,
  pipe,
  string,
  undefinedable,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { sqliteSchema } from '@/dialects/sqlite/schema'
import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

describe('SQLite schema', () => {
  it('infers distinct logical declared types while comparing their affinities stably', () => {
    expect(sqliteSchema.inferColumnType(string())).toBe('TEXT')
    expect(sqliteSchema.inferColumnType(pipe(number(), integer()))).toBe('INTEGER')
    expect(sqliteSchema.inferColumnType(number())).toBe('REAL')
    expect(sqliteSchema.inferColumnType(boolean())).toBe('BOOLEAN')
    expect(sqliteSchema.inferColumnType(date())).toBe('DATETIME')
    expect(sqliteSchema.inferColumnType(object({ value: string() }))).toBe('JSON')
    expect(sqliteSchema.normalizeDataType('BOOLEAN')).toBe('numeric')
    expect(sqliteSchema.normalizeDataType('JSON')).toBe('numeric')
    expect(sqliteSchema.normalizeDataType('INTEGER')).toBe('integer')
  })

  it('infers homogeneous enum and picklist storage from their output values', () => {
    expect(sqliteSchema.inferColumnType(enumSchema({ first: 'a', second: 'b' }))).toBe(
      'TEXT',
    )

    expect(sqliteSchema.inferColumnType(picklist(['a', 'b']))).toBe('TEXT')
    expect(sqliteSchema.inferColumnType(picklist([1, 2]))).toBe('INTEGER')
    expect(sqliteSchema.inferColumnType(picklist([1, 1.5]))).toBe('REAL')
    expect(sqliteSchema.inferColumnType(picklist([1.5, 1]))).toBe('REAL')
    expect(sqliteSchema.inferColumnType(picklist([2, 1]))).toBe('INTEGER')

    expect(sqliteSchema.inferColumnType(enumSchema({ first: 1, second: 2 }))).toBe(
      'INTEGER',
    )

    expect(sqliteSchema.inferColumnType(enumSchema({ first: 1, second: 1.5 }))).toBe(
      'REAL',
    )
  })

  it('infers boolean and bigint choice storage', () => {
    const booleanChoices = (
      picklist as unknown as (options: readonly boolean[]) => AnySchema
    )([true, false])

    expect(sqliteSchema.inferColumnType(nullable(booleanChoices))).toBe('BOOLEAN')
    expect(sqliteSchema.inferColumnType(picklist([1n, 2n]))).toBe('BIGINT')
  })

  it('rejects mixed choices with the explicit mapping contract', () => {
    for (const schema of [
      picklist(['1', 1]),
      picklist([null, 'a'] as unknown as [string, string]),
      enumSchema({ first: 1, second: 'a' }),
    ]) {
      expect(() => sqliteSchema.inferColumnType(schema)).toThrow(SchemaError)

      expect(() => sqliteSchema.inferColumnType(schema)).toThrow(
        /column\(\{ physicalType: \{ sqlite: \.\.\. \} \}\).*explicit parameter and result mappings/,
      )
    }
  })
})

describe('SQLite schema', () => {
  it.each([
    ['optional', optional(picklist([1, 2]))],
    ['exactOptional', exactOptional(picklist([1, 2]))],
    ['undefinedable', undefinedable(picklist([1, 2]))],
    ['nullable', nullable(picklist([1, 2]))],
    ['nullish', nullish(picklist([1, 2]))],
    ['nonOptional', nonOptional(picklist([1, 2]))],
    ['nonNullable', nonNullable(picklist([1, 2]))],
    ['nonNullish', nonNullish(picklist([1, 2]))],
    ['nested wrappers and pipe', nullable(optional(pipe(picklist([1, 2]), minValue(1))))],
  ])('infers numeric choice storage through %s wrappers', (_name, schema) => {
    expect(sqliteSchema.inferColumnType(schema)).toBe('INTEGER')
  })
})

describe('SQLite schema', () => {
  it.each([
    ['NaN', picklist([0, Number.NaN])],
    ['positive infinity', picklist([0, Number.POSITIVE_INFINITY])],
    ['negative infinity', picklist([0, Number.NEGATIVE_INFINITY])],
    ['unsafe positive integer', picklist([0, Number.MAX_SAFE_INTEGER + 1])],
    ['unsafe negative integer', picklist([0, Number.MIN_SAFE_INTEGER - 1])],
  ])('rejects numeric choice option %s after a valid option', (_name, schema) => {
    expect(() => sqliteSchema.inferColumnType(schema)).toThrow(SchemaError)
  })

  it('accepts safe-integer boundary choices and rejects their invalid neighbors', () => {
    expect(
      sqliteSchema.inferColumnType(
        picklist([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]),
      ),
    ).toBe('INTEGER')

    expect(() =>
      sqliteSchema.inferColumnType(picklist([0, Number.MAX_SAFE_INTEGER + 1])),
    ).toThrow(SchemaError)

    expect(() =>
      sqliteSchema.inferColumnType(picklist([0, Number.MIN_SAFE_INTEGER - 1])),
    ).toThrow(SchemaError)
  })
})

describe('SQLite schema', () => {
  it('accepts signed 64-bit bigint boundaries and rejects their invalid neighbors', () => {
    const min = -9223372036854775808n
    const max = 9223372036854775807n

    expect(sqliteSchema.inferColumnType(picklist([min, max]))).toBe('BIGINT')

    expect(() => sqliteSchema.inferColumnType(picklist([0n, min - 1n]))).toThrow(
      SchemaError,
    )

    expect(() => sqliteSchema.inferColumnType(picklist([0n, max + 1n]))).toThrow(
      SchemaError,
    )
  })
})

describe('SQLite schema', () => {
  it('accepts finite safe number literals and rejects non-finite values consistently', () => {
    expect(sqliteSchema.inferColumnType(literal(Number.MIN_SAFE_INTEGER))).toBe('INTEGER')
    expect(sqliteSchema.inferColumnType(literal(Number.MAX_SAFE_INTEGER))).toBe('INTEGER')
    expect(sqliteSchema.inferColumnType(literal(1.25))).toBe('REAL')
  })
})
