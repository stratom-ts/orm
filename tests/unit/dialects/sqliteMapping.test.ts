import { runInNewContext } from 'node:vm'
import { date, isoTimestamp, pipe, string, toDate } from 'valibot'
import { describe, expect, it } from 'vitest'

import { mapSqliteParamValue, mapSqliteResultValue } from '@/dialects/sqlite/mapping'
import { QueryError } from '@/utils/error'

describe('SQLite value mapping', () => {
  it('should preserve ISO string output and map proven transformed Date output', () => {
    const isoSchema = { schema: pipe(string(), isoTimestamp()) }
    const convertedSchema = { schema: pipe(string(), isoTimestamp(), toDate()) }
    const isoValue = '2026-01-02T03:04:05.123456Z'
    const dateValue = new Date('2026-01-02T03:04:05.123Z')

    expect(mapSqliteParamValue('TEXT', isoValue, isoSchema)).toBe(isoValue)
    expect(mapSqliteResultValue('TEXT', isoValue, isoSchema)).toBe(isoValue)

    expect(mapSqliteParamValue('DATETIME', dateValue, convertedSchema)).toBe(
      dateValue.toISOString(),
    )

    expect(
      mapSqliteResultValue('DATETIME', dateValue.toISOString(), convertedSchema),
    ).toEqual(dateValue)

    expect(
      mapSqliteResultValue('DATETIME', dateValue.toISOString(), { schema: date() }),
    ).toEqual(dateValue)
  })

  it('should map boolean, date, JSON, bigint, and numeric declarations independently', () => {
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
    'should map signed 64-bit BIGINT value %s at the parameter and result boundary',
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
    ])('should reject out-of-range BIGINT value %s', (value) => {
      expect(() => map('BIGINT', value)).toThrow(QueryError)

      expect(() => map('BIGINT', value)).toThrow(
        /SQLite BIGINT values must be within the signed 64-bit integer range/,
      )
    })
  })
})

describe('SQLite numeric value validation', () => {
  it('should preserve nullish values and reject lossy numeric mappings', () => {
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

describe('SQLite value mapping', () => {
  it('should reject invalid Date and cyclic JSON parameter values with query diagnostics', () => {
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

it('should preserve JSON callback defects and serialize shared references once per property', () => {
  const defect = new TypeError('toJSON failed')
  const stack = defect.stack
  let calls = 0
  const value = {
    toJSON() {
      calls++
      throw defect
    },
  }

  const failure = (() => {
    try {
      mapSqliteParamValue('JSON', value)
    } catch (cause) {
      return cause
    }
  })()

  expect(failure).toBe(defect)
  expect((failure as Error).stack).toBe(stack)
  expect(calls).toBe(1)

  const shared = { value: 1 }
  expect(mapSqliteParamValue('JSON', { first: shared, second: shared })).toBe(
    '{"first":{"value":1},"second":{"value":1}}',
  )

  expect(() => mapSqliteParamValue('JSON', { value: 1n })).toThrow(QueryError)
  expect(() => mapSqliteParamValue('JSON', Object(1n))).toThrow(QueryError)

  expect(() => mapSqliteParamValue('JSON', runInNewContext('Object(1n)'))).toThrow(
    QueryError,
  )

  expect(mapSqliteParamValue('JSON', Object.create(BigInt.prototype))).toBe('{}')
})

it('should preserve JSON getter defects and non-syntax parser failures', () => {
  const defect = new RangeError('getter failed')
  const stack = defect.stack
  const value = Object.defineProperty({}, 'field', {
    enumerable: true,
    get() {
      throw defect
    },
  })

  let getterFailure: unknown
  try {
    mapSqliteParamValue('JSON', value)
  } catch (cause) {
    getterFailure = cause
  }

  expect(getterFailure).toBe(defect)
  expect((getterFailure as Error).stack).toBe(stack)
  const parserDefect = new TypeError('parser failed')
  const parserStack = parserDefect.stack
  const originalParse = JSON.parse

  JSON.parse = () => {
    throw parserDefect
  }

  try {
    let parserFailure: unknown
    try {
      mapSqliteResultValue('JSON', '{}')
    } catch (cause) {
      parserFailure = cause
    }

    expect(parserFailure).toBe(parserDefect)
    expect((parserFailure as Error).stack).toBe(parserStack)
  } finally {
    JSON.parse = originalParse
  }
})
