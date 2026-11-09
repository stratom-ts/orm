import {
  any,
  bigint,
  boolean,
  date,
  decimal,
  ip,
  isoDate,
  isoDateTime,
  isoDateTimeSecond,
  isoTime,
  isoTimeSecond,
  isoTimestamp,
  literal,
  number,
  object,
  parseJson,
  picklist,
  pipe,
  safeInteger,
  string,
  toBoolean,
  toDate,
  toNumber,
  toString,
  transform,
  union,
  unknown,
  uuid,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  mapPostgresParamValue,
  mapPostgresResultValue,
  validatePostgresValueMapping,
} from '@/dialects/postgres/mapping'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { AnySchema } from '@/types/schema'
import { QueryError, SchemaError } from '@/utils/error'

const bigintContext = { facts: extractStorageFacts(bigint()) }

const numberContext = { facts: extractStorageFacts(pipe(number(), safeInteger())) }

const stringContext = { facts: extractStorageFacts(string()) }

const rejectedScalarStorageCases: [string, AnySchema, string][] = [
  ['date', date(), 'text'],
  ['date', date(), 'varchar(20)'],
  ['number', number(), 'text'],
  ['number', number(), 'varchar(20)'],
  ['boolean', boolean(), 'text'],
  ['boolean', boolean(), 'varchar(20)'],
  ['json', object({ a: number() }), 'text'],
  ['json', object({ a: number() }), 'varchar(20)'],
  ['number', pipe(string(), toNumber()), 'text'],
  ['date', pipe(string(), toDate()), 'text'],
  ['boolean', pipe(string(), toBoolean()), 'text'],
  ['string', pipe(number(), toString()), 'integer'],
  ['unknown', pipe(string(), parseJson()), 'text'],
  [
    'unknown',
    pipe(
      string(),
      transform((value) => value),
    ),
    'text',
  ],
  ['number', number(), 'numeric'],
  ['number', number(), 'decimal(10,2)'],
  ['string', string(), 'serial'],
  ['string', string(), 'interval'],
  ['string', string(), 'text[]'],
  ['string', string(), 'jsonb'],
  ['string', string(), 'boolean'],
  ['string', string(), 'smallint'],
  ['string', string(), 'integer'],
  ['string', string(), 'bigint'],
  ['string', string(), 'real'],
  ['string', string(), 'double precision'],
  ['string', string(), 'oid'],
  ['string', string(), 'json'],
  ['string', string(), 'bytea'],
  ['string', string(), 'point'],
  ['string', string(), 'circle'],
  ['boolean', boolean(), 'integer'],
  ['date', date(), 'time'],
  ['date', date(), 'numeric'],
  ['bigint', bigint(), 'real'],
  ['bigint', bigint(), 'double precision'],
  ['bigint', bigint(), 'text'],
  ['json', object({ a: number() }), 'integer'],
  ['unknown', picklist(['one', 1]), 'text'],
]

const registerMappingCases7 = () => {
  it('should retain second-precision ISO output for homogeneous branches', () => {
    const schema = union([
      pipe(string(), isoTimeSecond()),
      pipe(string(), isoTimeSecond()),
    ])

    expect(
      mapPostgresResultValue('time', '03:04:05', { facts: extractStorageFacts(schema) }),
    ).toBe('03:04:05')
  })

  it('should reject mixed output identities and native temporal precision', () => {
    expect(() =>
      validatePostgresValueMapping('text', {
        facts: extractStorageFacts(union([number(), bigint()])),
      }),
    ).toThrow(SchemaError)

    const temporal = union([pipe(string(), isoTime()), pipe(string(), isoTimeSecond())])
    expect(() =>
      validatePostgresValueMapping('time', { facts: extractStorageFacts(temporal) }),
    ).toThrow(SchemaError)

    expect(() =>
      validatePostgresValueMapping('text', { facts: extractStorageFacts(temporal) }),
    ).not.toThrow()

    expect(
      mapPostgresResultValue('text', '03:04:05', {
        facts: extractStorageFacts(temporal),
      }),
    ).toBe('03:04:05')
  })

  it('should keep native-format strings exact under an explicit text type', () => {
    const schema = union([pipe(string(), uuid()), pipe(string(), ip())])
    expect(() =>
      validatePostgresValueMapping('text', { facts: extractStorageFacts(schema) }),
    ).not.toThrow()

    expect(
      mapPostgresResultValue('text', '192.0.2.1', { facts: extractStorageFacts(schema) }),
    ).toBe('192.0.2.1')
  })
}

const registerMappingCases8 = () => {
  it('should reject selected storage that changes composite output identity', () => {
    expect(() =>
      validatePostgresValueMapping('double precision', {
        facts: extractStorageFacts(union([bigint(), literal(1n)])),
      }),
    ).toThrow(SchemaError)

    expect(() =>
      validatePostgresValueMapping('text', {
        facts: extractStorageFacts(union([number(), literal(2)])),
      }),
    ).toThrow(SchemaError)

    expect(() =>
      validatePostgresValueMapping('text', {
        facts: extractStorageFacts(
          union([object({ a: string() }), object({ b: number() })]),
        ),
      }),
    ).toThrow(SchemaError)

    expect(() =>
      validatePostgresValueMapping('text', {
        facts: extractStorageFacts(union([date(), date()])),
      }),
    ).toThrow(SchemaError)
  })

  it('should map widened safe integer and fractional number branches as numbers', () => {
    const schema = union([pipe(number(), safeInteger()), number()])
    expect(
      mapPostgresParamValue('double precision', Number.MAX_SAFE_INTEGER, {
        facts: extractStorageFacts(schema),
      }),
    ).toBe(Number.MAX_SAFE_INTEGER)

    expect(
      mapPostgresResultValue('double precision', 1.25, {
        facts: extractStorageFacts(schema),
      }),
    ).toBe(1.25)
  })
}

const registerMappingCases9 = () => {
  it.each([
    ['date', '0042-01-02', pipe(string(), isoDate()), '0042-01-02'],
    ['time', '03:04:00', pipe(string(), isoTime()), '03:04'],
    ['time', '03:04:05', pipe(string(), isoTimeSecond()), '03:04:05'],
    [
      'timestamp',
      '2026-01-02 03:04:00',
      pipe(string(), isoDateTime()),
      '2026-01-02T03:04',
    ],
    [
      'timestamp',
      '2026-01-02 03:04:05',
      pipe(string(), isoDateTimeSecond()),
      '2026-01-02T03:04:05',
    ],
    [
      'timestamptz',
      '2026-01-02 08:34:05.123456+11',
      pipe(string(), isoTimestamp()),
      '2026-01-02T08:34:05.123456+11:00',
    ],
    [
      'timestamptz',
      '0042-01-02 12:53:21.123456+09:49:16',
      pipe(string(), isoTimestamp()),
      '0042-01-02T03:04:05.123456Z',
    ],
  ] as const)(
    'should map %s native text to the schema output',
    (type, raw, schema, expected) => {
      expect(() =>
        validatePostgresValueMapping(type, { facts: extractStorageFacts(schema) }),
      ).not.toThrow()

      expect(
        mapPostgresParamValue(type, expected, { facts: extractStorageFacts(schema) }),
      ).toBe(expected)

      expect(
        mapPostgresResultValue(type, raw, { facts: extractStorageFacts(schema) }),
      ).toBe(expected)
    },
  )
}

const registerMappingCases10 = () => {
  it('should map raw local timestamps to Date without host-timezone conversion', () => {
    expect(
      mapPostgresResultValue('timestamp', '2026-01-02 03:04:05', {
        facts: extractStorageFacts(date()),
      }),
    ).toEqual(new Date('2026-01-02T03:04:05Z'))

    expect(mapPostgresResultValue('timestamp', '2026-01-02T03:04:05Z')).toEqual(
      new Date('2026-01-02T03:04:05Z'),
    )

    expect(
      mapPostgresResultValue('timestamptz', '0042-01-02 12:53:21.123456+09:49:16', {
        facts: extractStorageFacts(date()),
      }),
    ).toEqual(new Date('0042-01-02T03:04:05.123Z'))
  })

  it('should reject native seconds or fractions finer than a strict ISO schema', () => {
    expect(() =>
      mapPostgresResultValue('time', '03:04:05', {
        facts: extractStorageFacts(pipe(string(), isoTime())),
      }),
    ).toThrow(QueryError)

    expect(() =>
      mapPostgresResultValue('timestamp', '2026-01-02 03:04:05.123456', {
        facts: extractStorageFacts(pipe(string(), isoDateTimeSecond())),
      }),
    ).toThrow(QueryError)
  })
}

const registerMappingCases11 = () => {
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
}

const registerMappingCases17 = () => {
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
}

const registerMappingCases18 = () => {
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
    const dateContext = { facts: extractStorageFacts(date()) }

    expect(mapPostgresResultValue('numeric', '9007199254740993.25', stringContext)).toBe(
      '9007199254740993.25',
    )

    expect(mapPostgresParamValue('numeric', '9007199254740993.25', stringContext)).toBe(
      '9007199254740993.25',
    )

    expect(
      mapPostgresResultValue('timestamptz', new Date(timestamp), stringContext),
    ).toBe(timestamp)

    expect(mapPostgresResultValue('timestamptz', timestamp, dateContext)).toEqual(
      new Date(timestamp),
    )
  })
}

const registerMappingCases24 = () => {
  it.each(rejectedScalarStorageCases)(
    'should reject %s output in %s storage',
    (kind, schema, dataType) => {
      expect(() =>
        validatePostgresValueMapping(dataType, { facts: extractStorageFacts(schema) }),
      ).toThrow(SchemaError)

      expect(() =>
        validatePostgresValueMapping(dataType, { facts: extractStorageFacts(schema) }),
      ).toThrow(new RegExp(`PostgreSQL ${kind} schema .*mapParam/mapResult`))
    },
  )
}

function registerMappingGroup1() {
  it('should reject unsafe JSON outputs even when JSON storage is selected', () => {
    for (const schema of [
      union([object({ at: date() }), object({ at: date() })]),
      union([object({ id: bigint() }), object({ id: bigint() })]),
    ]) {
      expect(() =>
        validatePostgresValueMapping('jsonb', { facts: extractStorageFacts(schema) }),
      ).toThrow(SchemaError)

      expect(() =>
        validatePostgresValueMapping('jsonb', { facts: extractStorageFacts(schema) }),
      ).toThrow(
        /JSON composite output is not preserved.*physicalType.*paired parameter and result mappings/,
      )
    }
  })
}

function registerMappingGroup2() {
  it.each<[string, AnySchema, string]>([
    ['isoDate/timestamptz', pipe(string(), isoDate()), 'timestamptz'],
    ['isoDate/timestamp', pipe(string(), isoDate()), 'timestamp'],
    ['isoDateTime/timestamptz', pipe(string(), isoDateTime()), 'timestamptz'],
    ['isoDateTime/date', pipe(string(), isoDateTime()), 'date'],
    ['isoTimestamp/timestamp', pipe(string(), isoTimestamp()), 'timestamp'],
  ])(
    'should reject ISO temporal format storage that changes %s',
    (_name, schema, type) => {
      expect(() =>
        validatePostgresValueMapping(type, { facts: extractStorageFacts(schema) }),
      ).toThrow(SchemaError)

      expect(() =>
        validatePostgresValueMapping(type, {
          facts: extractStorageFacts(string()),
          authoredFacts: extractStorageFacts(schema),
        }),
      ).toThrow(/reference output formats.*paired column mapParam\/mapResult/)
    },
  )
}

function registerMappingGroup3() {
  it('should accept native precision, text, varchar, and plain strings for temporal storage', () => {
    const cases = [
      [pipe(string(), isoTimeSecond()), 'time(0)', '03:04:05', '03:04:05', '03:04:05'],
      [
        pipe(string(), isoDateTime()),
        'timestamp(0)',
        '2026-01-02T03:04',
        '2026-01-02 03:04:00',
        '2026-01-02T03:04',
      ],
      [
        pipe(string(), isoTimestamp()),
        'timestamptz(6)',
        '2026-01-02T03:04:05.123456Z',
        '2026-01-02 03:04:05.123456+00',
        '2026-01-02T03:04:05.123456Z',
      ],
      [pipe(string(), isoDate()), 'text', '2026-01-02', '2026-01-02', '2026-01-02'],
      [
        pipe(string(), isoDate()),
        'varchar(40)',
        '2026-01-02',
        '2026-01-02',
        '2026-01-02',
      ],
      [
        string(),
        'timestamp',
        '2026-01-02T03:04:05',
        '2026-01-02 03:04:05',
        '2026-01-02T03:04:05.000Z',
      ],
    ] as const

    for (const [schema, type, input, driver, output] of cases) {
      expect(() =>
        validatePostgresValueMapping(type, { facts: extractStorageFacts(schema) }),
      ).not.toThrow()

      expect(
        mapPostgresParamValue(type, input, { facts: extractStorageFacts(schema) }),
      ).toBe(input)

      expect(
        mapPostgresResultValue(type, driver, { facts: extractStorageFacts(schema) }),
      ).toBe(output)
    }
  })
}

function registerMappingGroup4() {
  it('should use built-in JSON mapping for a recovered structured output', () => {
    const branch = pipe(object({ at: date() }), object({ at: pipe(date(), toString()) }))
    const schema = union([branch, branch])
    const output = { at: new Date('2026-01-01T00:00:00.000Z').toString() }

    expect(() =>
      validatePostgresValueMapping('jsonb', { facts: extractStorageFacts(schema) }),
    ).not.toThrow()

    expect(
      mapPostgresParamValue('jsonb', output, { facts: extractStorageFacts(schema) }),
    ).toBe(JSON.stringify(output))

    expect(mapPostgresResultValue('jsonb', JSON.stringify(output))).toEqual(output)
  })
}

function registerMappingGroup5() {
  it('should reject non-finite nested numbers before JSON serialization', () => {
    const schema = union([object({ value: number() }), object({ value: number() })])
    expect(() =>
      mapPostgresParamValue(
        'jsonb',
        { value: Number.POSITIVE_INFINITY },
        { facts: extractStorageFacts(schema) },
      ),
    ).toThrow(QueryError)
  })
}

function registerMappingGroup6() {
  it('should check authored JSON composites for non-finite parameters', () => {
    const target = object({ value: number() })
    const authoredSchema = union([
      object({ value: number() }),
      object({ value: number() }),
    ])

    expect(() =>
      mapPostgresParamValue(
        'jsonb',
        { value: Number.POSITIVE_INFINITY },
        {
          facts: extractStorageFacts(target),
          authoredFacts: extractStorageFacts(authoredSchema),
        },
      ),
    ).toThrow(QueryError)
  })
}

function registerMappingGroup7() {
  describe('PostgreSQL composite value mapping', () => {
    registerMappingCases7()
  })
}

function registerMappingGroup8() {
  describe('PostgreSQL composite value mapping', () => {
    registerMappingCases8()
  })
}

function registerMappingGroup9() {
  describe('PostgreSQL temporal value mapping', () => {
    registerMappingCases9()
  })
}

function registerMappingGroup10() {
  describe('PostgreSQL temporal value mapping', () => {
    registerMappingCases10()
  })
}

function registerMappingGroup11() {
  describe('PostgreSQL context-free value mapping', () => {
    registerMappingCases11()
  })
}

function registerMappingGroup12() {
  it('should apply underlying integer width rules to serial composite storage', () => {
    const schema = union([pipe(number(), safeInteger()), literal(42)])
    for (const type of ['bigserial', 'bigint']) {
      expect(() =>
        validatePostgresValueMapping(type, { facts: extractStorageFacts(schema) }),
      ).not.toThrow()

      expect(
        mapPostgresResultValue(type, '42', { facts: extractStorageFacts(schema) }),
      ).toBe(42)
    }

    for (const type of ['smallserial', 'smallint', 'serial', 'integer']) {
      expect(() =>
        validatePostgresValueMapping(type, { facts: extractStorageFacts(schema) }),
      ).toThrow(SchemaError)
    }
  })
}

function registerMappingGroup13() {
  it.each([
    ['smallserial', 42],
    ['serial', 42],
    ['bigserial', '42'],
    [' SMALLSERIAL ', 42],
    [' SERIAL ', 42],
    [' BIGSERIAL ', '42'],
    ['smallint', 42],
    ['integer', 42],
    ['bigint', '42'],
  ])('should preserve number and bigint outputs through %s storage', (type, raw) => {
    expect(() => validatePostgresValueMapping(type, bigintContext)).not.toThrow()
    expect(() => validatePostgresValueMapping(type, numberContext)).not.toThrow()
    expect(mapPostgresParamValue(type, 42n, bigintContext)).toBe('42')
    expect(mapPostgresResultValue(type, raw, bigintContext)).toBe(42n)
    expect(mapPostgresParamValue(type, 42, numberContext)).toBe(42)
    expect(mapPostgresResultValue(type, raw, numberContext)).toBe(42)
  })
}

function registerMappingGroup14() {
  it.each(['smallserial', 'serial', 'bigserial', 'smallint', 'integer', 'bigint'])(
    'should reject inexact bigint conversions through %s storage',
    (type) => {
      for (const value of [9007199254740992, -9007199254740992, 42.5, '42.5']) {
        expect(() => mapPostgresParamValue(type, value, bigintContext)).toThrow(
          QueryError,
        )

        expect(() => mapPostgresResultValue(type, value, bigintContext)).toThrow(
          QueryError,
        )
      }
    },
  )
}

function registerMappingGroup15() {
  it.each(['bigserial', 'bigint'])(
    'should guard number conversions through %s storage in both directions',
    (type) => {
      for (const value of [-9007199254740991, 9007199254740991]) {
        expect(mapPostgresParamValue(type, value, numberContext)).toBe(value)
        expect(mapPostgresResultValue(type, String(value), numberContext)).toBe(value)
      }

      for (const value of [
        9007199254740992,
        -9007199254740992,
        '9007199254740993',
        '-9007199254740993',
        9007199254740993n,
        42.5,
        '42.5',
      ]) {
        expect(() => mapPostgresParamValue(type, value, numberContext)).toThrow(
          QueryError,
        )

        expect(() => mapPostgresResultValue(type, value, numberContext)).toThrow(
          QueryError,
        )
      }

      expect(mapPostgresParamValue(type, 9007199254740993n, bigintContext)).toBe(
        '9007199254740993',
      )

      expect(mapPostgresResultValue(type, '9007199254740993', bigintContext)).toBe(
        9007199254740993n,
      )
    },
  )
}

function registerMappingGroup16() {
  it.each(['smallserial', 'serial', 'bigserial', 'smallint', 'integer', 'bigint'])(
    'should preserve absent values and context-free representations through %s',
    (type) => {
      for (const context of [numberContext, bigintContext]) {
        expect(mapPostgresParamValue(type, null, context)).toBeNull()
        expect(mapPostgresResultValue(type, null, context)).toBeNull()
        expect(mapPostgresParamValue(type, undefined, context)).toBeUndefined()
        expect(mapPostgresResultValue(type, undefined, context)).toBeUndefined()
      }

      expect(mapPostgresParamValue(type, 42n)).toBe(42n)
      expect(mapPostgresResultValue(type, '9007199254740993')).toBe('9007199254740993')
      expect(mapPostgresResultValue(type, 42)).toBe(42)
    },
  )
}

function registerMappingGroup17() {
  describe('PostgreSQL integral value mapping', () => {
    registerMappingCases17()
  })
}

function registerMappingGroup18() {
  describe('PostgreSQL numeric safety and representations', () => {
    registerMappingCases18()
  })
}

function registerMappingGroup19() {
  it.each([
    ['time', isoTime(), isoTimeSecond(), '03:04:00', '03:04:00'],
    ['time', isoTimeSecond(), isoTime(), '03:04:00', '03:04'],
    ['time without time zone', isoTimeSecond(), isoTimeSecond(), '03:04:05', '03:04:05'],
    [
      'timestamp',
      isoDateTime(),
      isoDateTimeSecond(),
      '2026-01-02 03:04:00',
      '2026-01-02T03:04:00',
    ],
    [
      'timestamp',
      isoDateTimeSecond(),
      isoDateTime(),
      '2026-01-02 03:04:00',
      '2026-01-02T03:04',
    ],
    ['date', isoDate(), isoDate(), '2026-01-02', '2026-01-02'],
    [
      'timestamptz',
      isoTimestamp(),
      isoTimestamp(),
      '2026-01-02 03:04:05+11',
      '2026-01-02T03:04:05+11:00',
    ],
  ])(
    'should use the authored format with %s storage',
    (type, target, local, raw, expected) => {
      const context = {
        facts: extractStorageFacts(pipe(string(), target)),
        authoredFacts: extractStorageFacts(pipe(string(), local)),
      }

      expect(() => validatePostgresValueMapping(type, context)).not.toThrow()
      expect(mapPostgresResultValue(type, raw, context)).toBe(expected)
    },
  )
}

function registerMappingGroup20() {
  it.each([
    ['time', isoDateTimeSecond()],
    ['timestamp', isoTimeSecond()],
    ['timestamptz', isoDateTimeSecond()],
    ['date', isoTimestamp()],
    ['time', isoDate()],
  ])('should reject incompatible authored formats with %s storage', (type, format) => {
    const context = {
      facts: extractStorageFacts(string()),
      authoredFacts: extractStorageFacts(pipe(string(), format)),
    }

    expect(() => validatePostgresValueMapping(type, context)).toThrow(SchemaError)
    expect(() => validatePostgresValueMapping(type, context)).toThrow(format.type)
    expect(() => validatePostgresValueMapping(type, context)).toThrow(type)

    expect(() => validatePostgresValueMapping(type, context)).toThrow(
      /paired column mapParam\/mapResult or client mapParamValue\/mapResultValue/,
    )
  })
}

function registerMappingGroup21() {
  it('should reject ambiguous native formats and preserve explicit text spelling', () => {
    const context = {
      facts: extractStorageFacts(pipe(string(), isoTime())),
      authoredFacts: extractStorageFacts(pipe(string(), isoTime(), isoTimeSecond())),
    }

    expect(() => validatePostgresValueMapping('time', context)).toThrow(SchemaError)

    for (const type of ['text', 'varchar(40)']) {
      expect(() => validatePostgresValueMapping(type, context)).not.toThrow()
      expect(mapPostgresResultValue(type, '03:04:00', context)).toBe('03:04:00')
    }
  })
}

function registerMappingGroup22() {
  it.each([
    ['time', isoTime(), '03:04:05'],
    ['time', isoTimeSecond(), '03:04:05.001'],
    ['timestamp', isoDateTime(), '2026-01-02 03:04:05'],
    ['timestamp', isoDateTimeSecond(), '2026-01-02 03:04:05.001'],
  ])(
    'should reject finer stored precision for authored %s output',
    (type, format, raw) => {
      expect(() =>
        mapPostgresResultValue(type, raw, {
          facts: extractStorageFacts(string()),
          authoredFacts: extractStorageFacts(pipe(string(), format)),
        }),
      ).toThrow(QueryError)
    },
  )
}

function registerMappingGroup23() {
  it('should retain target formatting when no authored temporal facts remain', () => {
    expect(
      mapPostgresResultValue('time', '03:04:00', {
        facts: extractStorageFacts(pipe(string(), isoTime())),
        authoredFacts: extractStorageFacts(string()),
      }),
    ).toBe('03:04')
  })
}

function registerMappingGroup24() {
  describe('PostgreSQL scalar storage validation', () => {
    registerMappingCases24()
  })
}

const registerMappingGroup25Data: [
  string,
  AnySchema,
  string[],
  unknown,
  unknown,
  unknown,
  unknown,
][] = [
  [
    'PM1 plain date string',
    string(),
    ['date'],
    '2026-01-02',
    '2026-01-02',
    '2026-01-02',
    '2026-01-02',
  ],
  [
    'PM1 plain time string',
    string(),
    ['time', 'time(0)', 'time without time zone'],
    '03:04:05',
    '03:04:05',
    '03:04:05',
    '03:04:05',
  ],
  [
    'PM1 plain local string',
    string(),
    ['timestamp', 'timestamp without time zone'],
    '2026-01-02T03:04:05',
    '2026-01-02T03:04:05',
    '2026-01-02 03:04:05',
    '2026-01-02T03:04:05.000Z',
  ],
  [
    'PM1 plain zoned string',
    string(),
    ['timestamptz', 'timestamp with time zone'],
    '2026-01-02T03:04:05Z',
    '2026-01-02T03:04:05Z',
    '2026-01-02 03:04:05+00',
    '2026-01-02T03:04:05.000Z',
  ],
  [
    'PM1 text',
    string(),
    ['text', 'varchar(20)', 'character varying(20)', 'char(5)', 'character(5)'],
    '00123',
    '00123',
    '00123',
    '00123',
  ],
  [
    'PM1 network string',
    string(),
    ['inet'],
    '192.0.2.1',
    '192.0.2.1',
    '192.0.2.1',
    '192.0.2.1',
  ],
  [
    'PM1 MAC string',
    string(),
    ['macaddr'],
    'ab:cd:ef:12:34:56',
    'ab:cd:ef:12:34:56',
    'ab:cd:ef:12:34:56',
    'ab:cd:ef:12:34:56',
  ],
  [
    'PM1 MAC8 string',
    string(),
    ['macaddr8'],
    'ab:cd:ef:12:34:56:78:90',
    'ab:cd:ef:12:34:56:78:90',
    'ab:cd:ef:12:34:56:78:90',
    'ab:cd:ef:12:34:56:78:90',
  ],
  ['PM1 money string', string(), ['money'], '42.00', '42.00', '$42.00', '$42.00'],
  [
    'PM1 numeric string',
    pipe(string(), decimal()),
    ['numeric', 'decimal', 'numeric(30,3)', 'decimal(30,3)'],
    '9007199254740993.125',
    '9007199254740993.125',
    '9007199254740993.125',
    '9007199254740993.125',
  ],
  [
    'PM1 uuid string',
    pipe(string(), uuid()),
    ['uuid'],
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000',
    '550e8400-e29b-41d4-a716-446655440000',
  ],
  [
    'PM2 narrow number',
    number(),
    [
      'smallint',
      'int2',
      'integer',
      'int4',
      'smallserial',
      'serial',
      'real',
      'float4',
      'double precision',
      'float8',
    ],
    42,
    42,
    42,
    42,
  ],
  ['PM2 wide number', number(), ['bigint', 'int8', 'bigserial'], 42, 42, '42', 42],
  [
    'PM3 narrow bigint',
    bigint(),
    ['smallint', 'int2', 'integer', 'int4', 'smallserial', 'serial'],
    42n,
    '42',
    42,
    42n,
  ],
  [
    'PM3 wide bigint',
    bigint(),
    [
      'bigint',
      'int8',
      'bigserial',
      'numeric',
      'decimal',
      'numeric(30,3)',
      'decimal(30,3)',
    ],
    9007199254740993n,
    '9007199254740993',
    '9007199254740993.000',
    9007199254740993n,
  ],
  ['PM4 boolean', boolean(), ['boolean', 'bool'], false, false, false, false],
  [
    'PM5 local Date',
    date(),
    ['timestamp', 'timestamp(3)', 'timestamp without time zone'],
    new Date('2026-01-02T03:04:05.000Z'),
    '2026-01-02T03:04:05.000Z',
    '2026-01-02 03:04:05',
    new Date('2026-01-02T03:04:05.000Z'),
  ],
  [
    'PM5 zoned Date',
    date(),
    ['timestamptz', 'timestamp(3) with time zone'],
    new Date('2026-01-02T03:04:05.000Z'),
    '2026-01-02T03:04:05.000Z',
    '2026-01-02 03:04:05+00',
    new Date('2026-01-02T03:04:05.000Z'),
  ],
  [
    'PM5 date-only Date',
    date(),
    ['date'],
    new Date('2026-01-02T00:00:00.000Z'),
    new Date('2026-01-02T00:00:00.000Z'),
    '2026-01-02',
    new Date('2026-01-02T00:00:00.000Z'),
  ],
  [
    'PM6 JSON',
    object({ a: number() }),
    ['json', 'jsonb'],
    { a: 42 },
    '{"a":42}',
    '{"a":42}',
    { a: 42 },
  ],
  [
    'PM6 parsed JSON',
    pipe(string(), parseJson(), object({ a: number() })),
    ['json', 'jsonb'],
    { a: 42 },
    '{"a":42}',
    { a: 42 },
    { a: 42 },
  ],
  ['PM7 unknown', unknown(), ['text'], '00123', '00123', '00123', '00123'],
  ['PM7 any', any(), ['jsonb'], { a: 42 }, '{"a":42}', '{"a":42}', { a: 42 }],
]

function registerMappingGroup25() {
  it.each<[string, AnySchema, string[], unknown, unknown, unknown, unknown]>(
    registerMappingGroup25Data,
  )(
    'should validate and map %s independently for every storage alias in PostgreSQL',
    (_id, schema, types, input, parameter, driver, output) => {
      for (const type of types) {
        const context = { facts: extractStorageFacts(schema) }
        expect(() => validatePostgresValueMapping(type, context)).not.toThrow()
        expect(mapPostgresParamValue(type, input, context)).toEqual(parameter)
        expect(mapPostgresResultValue(type, driver, context)).toEqual(output)
        expect(mapPostgresParamValue(type, null, context)).toBeNull()
        expect(mapPostgresResultValue(type, null, context)).toBeNull()
      }
    },
  )
}

describe('PostgreSQL mapping', () => {
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
  registerMappingGroup21()
  registerMappingGroup22()
  registerMappingGroup23()
  registerMappingGroup24()
  registerMappingGroup25()
})
