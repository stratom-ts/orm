import { bigint, date, number, pipe, safeInteger, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  mapPostgresParamValue,
  mapPostgresResultValue,
} from '@/dialects/postgres/mapping'
import { QueryError } from '@/utils/error'

const bigintContext = { schema: bigint() }
const numberContext = { schema: pipe(number(), safeInteger()) }
const stringContext = { schema: string() }

describe('PostgreSQL context-free value mapping', () => {
  it('should preserve context-free values and nullable values', () => {
    const dateValue = new Date('2026-01-02T03:04:05.000Z')
    expect(mapPostgresResultValue('int8', '42')).toBe('42')
    expect(mapPostgresResultValue('numeric', '42.000')).toBe('42.000')

    expect(mapPostgresResultValue('timestamptz', dateValue.toISOString())).toEqual(
      dateValue,
    )

    expect(mapPostgresParamValue('timestamptz', dateValue)).toBe(dateValue.toISOString())
    expect(mapPostgresResultValue('jsonb', '{"value":42}')).toEqual({ value: 42 })
    expect(mapPostgresResultValue('uuid', 42)).toBe('42')
    expect(mapPostgresParamValue('numeric', null, bigintContext)).toBeNull()
    expect(mapPostgresResultValue('bigint', undefined, bigintContext)).toBeUndefined()
  })
})

describe('PostgreSQL integral value mapping', () => {
  it.each(['numeric', 'numeric(30,3)', 'decimal(30,3)'])(
    'should map arbitrary-precision bigint values through %s storage',
    (type) => {
      expect(mapPostgresParamValue(type, 9223372036854775808n, bigintContext)).toBe(
        '9223372036854775808',
      )

      expect(mapPostgresResultValue(type, '9223372036854775808', bigintContext)).toBe(
        9223372036854775808n,
      )

      expect(mapPostgresParamValue(type, '42.000', bigintContext)).toBe('42')
      expect(mapPostgresResultValue(type, '-42.000', bigintContext)).toBe(-42n)
    },
  )

  it.each(['bigint', 'int8', 'integer', 'int4', 'smallint', 'int2'])(
    'should map bigint output through %s integral storage',
    (type) => {
      expect(mapPostgresParamValue(type, 42n, bigintContext)).toBe('42')
      expect(mapPostgresResultValue(type, 42, bigintContext)).toBe(42n)
    },
  )

  it.each([-9007199254740991, 9007199254740991])(
    'should map safe bigint storage as a number at %s',
    (value) => {
      expect(mapPostgresParamValue('int8', value, numberContext)).toBe(value)
      expect(mapPostgresResultValue('bigint', String(value), numberContext)).toBe(value)
    },
  )
})

describe('PostgreSQL numeric safety and representations', () => {
  it.each([
    [
      'bigint parameter',
      () => mapPostgresParamValue('numeric', 9007199254740992, bigintContext),
    ],
    [
      'bigint result',
      () => mapPostgresResultValue('numeric', 9007199254740992, bigintContext),
    ],
    [
      'fractional bigint parameter',
      () => mapPostgresParamValue('numeric', '42.5', bigintContext),
    ],
    [
      'fractional bigint result',
      () => mapPostgresResultValue('numeric', '42.5', bigintContext),
    ],
    [
      'unsafe number parameter',
      () => mapPostgresParamValue('int8', 9007199254740992, numberContext),
    ],
    [
      'unsafe number result',
      () => mapPostgresResultValue('int8', '9007199254740992', numberContext),
    ],
    [
      'unsafe driver number',
      () => mapPostgresResultValue('int8', 9007199254740992, numberContext),
    ],
  ])('should reject lossy %s', (_name, map) => {
    expect(map).toThrow(QueryError)
  })

  it('should preserve decimal strings and use temporal output representation', () => {
    const timestamp = '2026-01-02T03:04:05.000Z'

    expect(mapPostgresResultValue('numeric', '9007199254740993.25', stringContext)).toBe(
      '9007199254740993.25',
    )

    expect(mapPostgresParamValue('numeric', '9007199254740993.25', stringContext)).toBe(
      '9007199254740993.25',
    )

    expect(mapPostgresResultValue('numeric', '42.25', numberContext)).toBe('42.25')

    expect(
      mapPostgresResultValue('timestamptz', new Date(timestamp), stringContext),
    ).toBe(timestamp)

    expect(mapPostgresResultValue('timestamptz', timestamp, { schema: date() })).toEqual(
      new Date(timestamp),
    )
  })
})
