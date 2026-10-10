import { describe, expect, it } from 'vitest'

import { mapSqliteParamValue, mapSqliteResultValue } from '@/dialects/sqlite'
import { QueryError } from '@/utils/error'

describe('SQLite value mapping', () => {
  it('maps boolean, date, JSON, bigint, and numeric declarations independently', () => {
    const date = new Date('2026-01-02T03:04:05.000Z')

    expect(mapSqliteParamValue('BOOLEAN', true)).toBe(1)
    expect(mapSqliteResultValue('BOOL', 0n)).toBe(false)
    expect(mapSqliteParamValue('DATETIME', date)).toBe(date.toISOString())
    expect(mapSqliteResultValue('DATE', date.toISOString())).toEqual(date)

    expect(mapSqliteResultValue('DATETIME', '2026-01-02 03:04:05')).toEqual(
      new Date(Date.UTC(2026, 0, 2, 3, 4, 5)),
    )

    expect(mapSqliteParamValue('JSON', { id: 1 })).toBe('{"id":1}')
    expect(mapSqliteResultValue('JSON', '{"id":1}')).toEqual({ id: 1 })
    expect(mapSqliteParamValue('BIGINT', 42)).toBe(42n)
    expect(mapSqliteResultValue('BIGINT', '9007199254740993')).toBe(9007199254740993n)
    expect(mapSqliteResultValue('INTEGER', 42n)).toBe(42)
    expect(mapSqliteParamValue('REAL', 1.25)).toBe(1.25)
    expect(mapSqliteResultValue('TEXT', 'plain')).toBe('plain')
    expect(mapSqliteResultValue('JSON', '{not json}')).toBe('{not json}')
  })
})

describe('SQLite bigint value mapping', () => {
  it.each([
    -9223372036854775808n,
    9223372036854775807n,
    0n,
    42,
    '-9223372036854775808',
    '9223372036854775807',
  ])(
    'maps signed 64-bit BIGINT value %s at the parameter and result boundary',
    (value) => {
      const expected = BigInt(value)

      expect(mapSqliteParamValue('BIGINT', value)).toBe(expected)
      expect(mapSqliteResultValue('BIGINT', value)).toBe(expected)
    },
  )

  describe.each([
    { direction: 'parameter', map: mapSqliteParamValue },
    { direction: 'result', map: mapSqliteResultValue },
  ])('$direction mapping', ({ map }) => {
    it.each([
      -9223372036854775809n,
      9223372036854775808n,
      -18446744073709551616n,
      18446744073709551616n,
      '-9223372036854775809',
      '9223372036854775808',
      '-18446744073709551616',
      '18446744073709551616',
    ])('rejects out-of-range BIGINT value %s', (value) => {
      expect(() => map('BIGINT', value)).toThrow(QueryError)

      expect(() => map('BIGINT', value)).toThrow(
        /SQLite BIGINT values must be within the signed 64-bit integer range/,
      )
    })
  })
})

describe('SQLite numeric value validation', () => {
  it('preserves nullish values and rejects lossy numeric mappings', () => {
    expect(mapSqliteParamValue('INTEGER', null)).toBeNull()
    expect(mapSqliteResultValue('BIGINT', undefined)).toBeUndefined()

    expect(() => mapSqliteParamValue('INTEGER', Number.MAX_SAFE_INTEGER + 1)).toThrow(
      QueryError,
    )

    expect(() => mapSqliteResultValue('BIGINT', Number.MAX_SAFE_INTEGER + 1)).toThrow(
      QueryError,
    )

    expect(() => mapSqliteParamValue('REAL', Infinity)).toThrow(QueryError)
  })
})

describe('SQLite value mapping: rejects invalid Date and cyclic JSON parameter values with query diagnostics', () => {
  it('rejects invalid Date and cyclic JSON parameter values with query diagnostics', () => {
    /** Maps an invalid date to exercise value-validation rejection. */
    const invalidDate = () => mapSqliteParamValue('DATETIME', new Date('invalid'))
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic

    /** Maps cyclic JSON to exercise serialization rejection. */
    const cyclicJson = () => mapSqliteParamValue('JSON', cyclic)

    expect(invalidDate).toThrow(QueryError)
    expect(invalidDate).toThrow(/Date values must be valid/i)
    expect(cyclicJson).toThrow(QueryError)
    expect(cyclicJson).toThrow(/JSON parameter value cannot be serialized/i)
  })
})
