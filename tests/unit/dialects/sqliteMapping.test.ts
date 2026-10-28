import { runInNewContext } from 'node:vm'
import {
  any,
  bigint,
  boolean,
  date,
  integer,
  isoDate,
  isoDateTime,
  isoDateTimeSecond,
  isoTime,
  isoTimeSecond,
  isoTimestamp,
  maxValue,
  minValue,
  number,
  object,
  pipe,
  string,
  toDate,
  toString,
  union,
  unknown,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { sqliteDialect } from '@/dialects/sqlite/dialect'
import {
  mapSqliteParamValue,
  mapSqliteResultValue,
  validateSqliteValueMapping,
} from '@/dialects/sqlite/mapping'
import { column, createDatabase, defineTable } from '@/index'
import { createValueMapper } from '@/query/mapping'
import type { AnySchema } from '@/types/schema'
import { QueryError, SchemaError } from '@/utils/error'

import { customConnector } from '../helpers/operationSessionFixtures'

import { createSqliteControllableProvider } from './sqliteSharedFixtures'

const registerMappingCases11 = () => {
  it('should retain signed-int64 safeguards for bounded bigint composite output', () => {
    const min = -(2n ** 63n)
    const max = 2n ** 63n - 1n
    const context = {
      schema: pipe(union([bigint(), bigint()]), minValue(min), maxValue(max)),
    }

    for (const value of [min, max]) {
      expect(mapSqliteParamValue('BIGINT', value, context)).toBe(value)
      expect(mapSqliteResultValue('BIGINT', String(value), context)).toBe(value)
    }

    for (const value of [min - 1n, max + 1n]) {
      expect(() => mapSqliteParamValue('BIGINT', value, context)).toThrow(QueryError)

      expect(() => mapSqliteResultValue('BIGINT', String(value), context)).toThrow(
        QueryError,
      )
    }
  })

  it('should use REAL when integer and fractional branches share number output', () => {
    const context = { schema: union([pipe(number(), integer()), number()]) }
    expect(mapSqliteParamValue('REAL', 1.25, context)).toBe(1.25)
    expect(mapSqliteResultValue('REAL', 1.25, context)).toBe(1.25)

    expect(() =>
      mapSqliteParamValue('REAL', Number.MAX_SAFE_INTEGER + 1, context),
    ).toThrow(QueryError)
  })

  it('should reject mixed output identities despite a physical override', () => {
    expect(() =>
      validateSqliteValueMapping('TEXT', { schema: union([string(), number()]) }),
    ).toThrow(SchemaError)
  })
}

const registerMappingCases12 = () => {
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
}

const registerMappingCases13 = () => {
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
}

const registerMappingCases14 = () => {
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
}

const registerMappingCases15 = () => {
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
}

const registerMappingGroup1Data: [
  string,
  AnySchema,
  string[],
  string[],
  unknown,
  unknown,
  unknown,
  unknown,
][] = [
  [
    'SM1 string',
    string(),
    ['TEXT', 'VARCHAR(40)', 'BLOB'],
    ['INTEGER', 'REAL', 'NUMERIC'],
    '00123',
    '00123',
    '00123',
    '00123',
  ],
  [
    'SM2 number',
    number(),
    ['INTEGER', 'REAL', 'NUMERIC', 'BLOB', 'FLOATING POINT', 'DOUBLE', 'DECIMAL(10,2)'],
    ['TEXT'],
    1.5,
    1.5,
    1.5,
    1.5,
  ],
  [
    'SM3 boolean',
    boolean(),
    ['INTEGER', 'REAL', 'NUMERIC', 'BLOB', 'BOOLEAN'],
    ['TEXT'],
    false,
    0,
    0n,
    false,
  ],
  [
    'SM4 bigint',
    bigint(),
    ['INTEGER', 'NUMERIC', 'BLOB', 'BIGINT', 'DECIMAL(20,0)'],
    ['TEXT', 'REAL'],
    9007199254740993n,
    9007199254740993n,
    9007199254740993n,
    9007199254740993n,
  ],
  [
    'SM5 Date',
    date(),
    ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB', 'DATETIME'],
    [],
    new Date('2026-01-02T03:04:05.000Z'),
    '2026-01-02T03:04:05.000Z',
    '2026-01-02T03:04:05.000Z',
    new Date('2026-01-02T03:04:05.000Z'),
  ],
  [
    'SM6 structured',
    object({ value: string() }),
    ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB', 'JSON'],
    [],
    { value: '00123' },
    '{"value":"00123"}',
    '{"value":"00123"}',
    { value: '00123' },
  ],
]

function registerMappingGroup1() {
  it.each<[string, AnySchema, string[], string[], unknown, unknown, unknown, unknown]>(
    registerMappingGroup1Data,
  )(
    'SQLite should validate parameters and results for %s',
    (_id, schema, accepted, rejected, input, parameter, driver, output) => {
      for (const type of accepted) {
        const context = { schema }
        expect(() => validateSqliteValueMapping(type, context)).not.toThrow()
        expect(mapSqliteParamValue(type, input, context)).toEqual(parameter)
        expect(mapSqliteResultValue(type, driver, context)).toEqual(output)
        expect(mapSqliteParamValue(type, null, context)).toBeNull()
        expect(mapSqliteResultValue(type, null, context)).toBeNull()
      }

      for (const type of rejected)
        expect(() => validateSqliteValueMapping(type, { schema })).toThrow(SchemaError)
    },
  )
}

function registerMappingGroup2() {
  it.each([unknown(), any()])(
    'should reject SM7 unclassified output for every affinity',
    (schema) => {
      for (const type of ['TEXT', 'INTEGER', 'REAL', 'NUMERIC', 'BLOB'])
        expect(() => validateSqliteValueMapping(type, { schema })).toThrow(SchemaError)
    },
  )
}

function registerMappingGroup3() {
  it.each(['INTEGER', 'REAL', 'NUMERIC', 'BLOB'])(
    'should enforce E01-E03 and E08 ranges with %s storage',
    (type) => {
      const context = { schema: number() }
      for (const value of [-9007199254740991, 9007199254740991]) {
        expect(mapSqliteParamValue(type, value, context)).toBe(value)
        expect(mapSqliteResultValue(type, value, context)).toBe(value)
      }

      for (const value of [-9007199254740992, 9007199254740992, Infinity, NaN]) {
        expect(() => mapSqliteParamValue(type, value, context)).toThrow(QueryError)
        expect(() => mapSqliteResultValue(type, value, context)).toThrow(QueryError)
      }
    },
  )
}

function registerMappingGroup4() {
  it('should reject unsafe JSON outputs even when JSON storage is selected', () => {
    for (const schema of [
      union([object({ at: date() }), object({ at: date() })]),
      union([object({ id: bigint() }), object({ id: bigint() })]),
    ]) {
      expect(() => validateSqliteValueMapping('JSON', { schema })).toThrow(SchemaError)

      expect(() => validateSqliteValueMapping('JSON', { schema })).toThrow(
        /JSON composite output is not preserved.*physicalType.*paired parameter and result mappings/,
      )
    }
  })
}

function registerMappingGroup5() {
  it('should use built-in JSON mapping for a recovered structured output', () => {
    const branch = pipe(object({ at: date() }), object({ at: pipe(date(), toString()) }))
    const schema = union([branch, branch])
    const output = { at: new Date('2026-01-01T00:00:00.000Z').toString() }

    expect(() => validateSqliteValueMapping('JSON', { schema })).not.toThrow()
    expect(mapSqliteParamValue('JSON', output, { schema })).toBe(JSON.stringify(output))
    expect(mapSqliteResultValue('JSON', JSON.stringify(output))).toEqual(output)
  })
}

function registerMappingGroup6() {
  it('should create a SQLite client with inferred JSON for a recovered composite', async () => {
    const branch = pipe(object({ at: date() }), object({ at: pipe(date(), toString()) }))
    const Recovered = defineTable(
      'sqlite_recovered_json_composite',
      { id: string(), value: union([branch, branch]) },
      { primaryKey: 'id' },
    )

    const at = new Date('2026-01-01T00:00:00.000Z')
    const db = createDatabase({
      connector: customConnector('sqlite'),
      schemas: [Recovered],
      operationSessionProvider: createSqliteControllableProvider().provider,
    })

    expect(
      db.insert(Recovered).values({ id: 'one', value: { at } }).compile().params,
    ).toEqual(['one', JSON.stringify({ at: at.toString() })])

    await db.close()
  })
}

function registerMappingGroup7() {
  it('should reject non-finite nested numbers before JSON serialization', () => {
    const schema = union([object({ value: number() }), object({ value: number() })])
    expect(() =>
      mapSqliteParamValue('JSON', { value: Number.POSITIVE_INFINITY }, { schema }),
    ).toThrow(QueryError)
  })
}

function registerMappingGroup8() {
  it('should check authored JSON composites for non-finite parameters', () => {
    const target = object({ value: number() })
    const authoredSchema = union([
      object({ value: number() }),
      object({ value: number() }),
    ])

    expect(() =>
      mapSqliteParamValue(
        'JSON',
        { value: Number.POSITIVE_INFINITY },
        { schema: target, authoredSchema },
      ),
    ).toThrow(QueryError)
  })
}

function registerMappingGroup9() {
  it('should reject unsafe JSON outputs before mapping when both hooks are not paired', () => {
    const schema = pipe(
      union([object({ at: date() }), object({ at: date() })]),
      column({ physicalType: { sqlite: 'JSON' } }),
    )

    const Invalid = defineTable(
      'sqlite_unsafe_json_mapper',
      { id: string(), value: schema },
      { primaryKey: 'id' },
    )

    expect(() => createValueMapper(sqliteDialect, undefined, [Invalid])).toThrow(
      /JSON composite output is not preserved/,
    )

    expect(() =>
      createValueMapper(
        sqliteDialect,
        { mapParamValue: (_type, value) => JSON.stringify(value) },
        [Invalid],
      ),
    ).toThrow(/JSON composite output is not preserved/)
  })
}

function registerMappingGroup10() {
  it('should let paired client mappings preserve nested Date JSON output', () => {
    const schema = pipe(
      union([object({ at: date() }), object({ at: date() })]),
      column({ physicalType: { sqlite: 'JSON' } }),
    )

    const Mapped = defineTable(
      'sqlite_mapped_json_mapper',
      { id: string(), value: schema },
      { primaryKey: 'id' },
    )

    const mapper = createValueMapper(
      sqliteDialect,
      {
        mapParamValue: (type, value) =>
          type === 'JSON'
            ? JSON.stringify({ at: (value as { at: Date }).at.toISOString() })
            : value,
        mapResultValue: (type, value) => {
          if (type !== 'JSON') return value

          const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value
          return { at: new Date((parsed as { at: string }).at) }
        },
      },
      [Mapped],
    )

    const value = { at: new Date('2026-01-01T00:00:00.000Z') }

    expect(mapper.mapParam(Mapped, 'value', value)).toBe(
      '{"at":"2026-01-01T00:00:00.000Z"}',
    )

    expect(
      mapper.mapResultValue(Mapped, 'value', '{"at":"2026-01-01T00:00:00.000Z"}'),
    ).toEqual(value)
  })
}

function registerMappingGroup11() {
  describe('SQLite composite value mapping', () => {
    registerMappingCases11()
  })
}

function registerMappingGroup12() {
  describe('SQLite value mapping', () => {
    registerMappingCases12()
  })
}

function registerMappingGroup13() {
  describe('SQLite bigint value mapping', () => {
    registerMappingCases13()
  })
}

function registerMappingGroup14() {
  describe('SQLite numeric value validation', () => {
    registerMappingCases14()
  })
}

function registerMappingGroup15() {
  describe('SQLite value mapping', () => {
    registerMappingCases15()
  })
}

function registerMappingGroup16() {
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
}

function registerMappingGroup17() {
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
}

function registerMappingGroup18() {
  it.each([
    [isoDate(), '2026-01-02'],
    [isoTime(), '03:04'],
    [isoTimeSecond(), '03:04:00'],
    [isoDateTime(), '2026-01-02T03:04'],
    [isoDateTimeSecond(), '2026-01-02T03:04:00'],
    [isoTimestamp(), '2026-01-02T03:04:05.123456+11:00'],
  ])('should preserve exact ISO text for matching SQLite references', (format, value) => {
    const schema = pipe(string(), format)
    const context = { schema, authoredSchema: schema }
    expect(mapSqliteParamValue('TEXT', value, context)).toBe(value)
    expect(mapSqliteResultValue('TEXT', value, context)).toBe(value)
  })
}

function registerMappingGroup19() {
  it('should preserve SQLite temporal text without native precision formatting', () => {
    const context = {
      schema: pipe(string(), isoTime()),
      authoredSchema: pipe(string(), isoTimeSecond()),
    }

    expect(mapSqliteResultValue('TEXT', '03:04', context)).toBe('03:04')
    expect(mapSqliteResultValue('TEXT', '03:04:00', context)).toBe('03:04:00')
  })
}

function registerMappingGroup20() {
  it('should retain Date output for SQLite references and reject local string-to-Date changes', () => {
    const schema = date()
    const value = new Date('2026-01-02T03:04:05Z')
    const context = { schema, authoredSchema: schema }
    expect(mapSqliteParamValue('DATETIME', value, context)).toBe(value.toISOString())
    expect(mapSqliteResultValue('DATETIME', value.toISOString(), context)).toEqual(value)

    expect(() =>
      validateSqliteValueMapping('TEXT', {
        schema: pipe(string(), isoTimestamp()),
        authoredSchema: pipe(string(), isoTimestamp(), toDate()),
      }),
    ).toThrow(SchemaError)
  })
}

describe('SQLite mapping', () => {
  registerMappingGroup1()
  registerMappingGroup2()
  registerMappingGroup3()
  registerMappingGroup4()
  registerMappingGroup5()
  registerMappingGroup6()
  registerMappingGroup7()
  registerMappingGroup8()
  registerMappingGroup9()
  registerMappingGroup10()
  registerMappingGroup11()
  registerMappingGroup12()
  registerMappingGroup13()
  registerMappingGroup14()
  registerMappingGroup15()
  registerMappingGroup16()
  registerMappingGroup17()
  registerMappingGroup18()
  registerMappingGroup19()
  registerMappingGroup20()
})
