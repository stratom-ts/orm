import {
  bigint,
  date,
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
  pipe,
  safeInteger,
  string,
  toString,
  union,
  uuid,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import {
  mapPostgresParamValue,
  mapPostgresResultValue,
  validatePostgresValueMapping,
} from '@/dialects/postgres/mapping'
import { QueryError, SchemaError } from '@/utils/error'

it('should reject unsafe JSON outputs even when JSON storage is selected', () => {
  for (const schema of [
    union([object({ at: date() }), object({ at: date() })]),
    union([object({ id: bigint() }), object({ id: bigint() })]),
  ]) {
    expect(() => validatePostgresValueMapping('jsonb', { schema })).toThrow(SchemaError)

    expect(() => validatePostgresValueMapping('jsonb', { schema })).toThrow(
      /JSON composite output is not preserved.*physicalType.*paired parameter and result mappings/,
    )
  }
})

it('should use built-in JSON mapping for a recovered structured output', () => {
  const branch = pipe(object({ at: date() }), object({ at: pipe(date(), toString()) }))
  const schema = union([branch, branch])
  const output = { at: new Date('2026-01-01T00:00:00.000Z').toString() }

  expect(() => validatePostgresValueMapping('jsonb', { schema })).not.toThrow()
  expect(mapPostgresParamValue('jsonb', output, { schema })).toBe(JSON.stringify(output))
  expect(mapPostgresResultValue('jsonb', JSON.stringify(output))).toEqual(output)
})

it('should reject non-finite nested numbers before JSON serialization', () => {
  const schema = union([object({ value: number() }), object({ value: number() })])
  expect(() =>
    mapPostgresParamValue('jsonb', { value: Number.POSITIVE_INFINITY }, { schema }),
  ).toThrow(QueryError)
})

it('should check authored JSON composites for non-finite parameters', () => {
  const target = object({ value: number() })
  const authoredSchema = union([object({ value: number() }), object({ value: number() })])
  expect(() =>
    mapPostgresParamValue(
      'jsonb',
      { value: Number.POSITIVE_INFINITY },
      { schema: target, authoredSchema },
    ),
  ).toThrow(QueryError)
})

describe('PostgreSQL composite value mapping', () => {
  it('should retain second-precision ISO output for homogeneous branches', () => {
    const schema = union([
      pipe(string(), isoTimeSecond()),
      pipe(string(), isoTimeSecond()),
    ])

    expect(mapPostgresResultValue('time', '03:04:05', { schema })).toBe('03:04:05')
  })

  it('should reject mixed output identities and native temporal precision', () => {
    expect(() =>
      validatePostgresValueMapping('text', { schema: union([number(), bigint()]) }),
    ).toThrow(SchemaError)

    const temporal = union([pipe(string(), isoTime()), pipe(string(), isoTimeSecond())])
    expect(() => validatePostgresValueMapping('time', { schema: temporal })).toThrow(
      SchemaError,
    )

    expect(() => validatePostgresValueMapping('text', { schema: temporal })).not.toThrow()

    expect(mapPostgresResultValue('text', '03:04:05', { schema: temporal })).toBe(
      '03:04:05',
    )
  })

  it('should keep native-format strings exact under an explicit text type', () => {
    const schema = union([pipe(string(), uuid()), pipe(string(), ip())])
    expect(() => validatePostgresValueMapping('text', { schema })).not.toThrow()
    expect(mapPostgresResultValue('text', '192.0.2.1', { schema })).toBe('192.0.2.1')
  })
})

describe('PostgreSQL composite value mapping', () => {
  it('should reject selected storage that changes composite output identity', () => {
    expect(() =>
      validatePostgresValueMapping('double precision', {
        schema: union([bigint(), literal(1n)]),
      }),
    ).toThrow(SchemaError)

    expect(() =>
      validatePostgresValueMapping('text', {
        schema: union([number(), literal(2)]),
      }),
    ).toThrow(SchemaError)

    expect(() =>
      validatePostgresValueMapping('text', {
        schema: union([object({ a: string() }), object({ b: number() })]),
      }),
    ).toThrow(SchemaError)

    expect(() =>
      validatePostgresValueMapping('text', {
        schema: union([date(), date()]),
      }),
    ).toThrow(SchemaError)
  })

  it('should map widened safe integer and fractional number branches as numbers', () => {
    const schema = union([pipe(number(), safeInteger()), number()])
    expect(
      mapPostgresParamValue('double precision', Number.MAX_SAFE_INTEGER, { schema }),
    ).toBe(Number.MAX_SAFE_INTEGER)

    expect(mapPostgresResultValue('double precision', 1.25, { schema })).toBe(1.25)
  })
})

const bigintContext = { schema: bigint() }
const numberContext = { schema: pipe(number(), safeInteger()) }
const stringContext = { schema: string() }

describe('PostgreSQL temporal value mapping', () => {
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
      expect(mapPostgresResultValue(type, raw, { schema })).toBe(expected)
    },
  )
})

describe('PostgreSQL temporal value mapping', () => {
  it('should map raw local timestamps to Date without host-timezone conversion', () => {
    expect(
      mapPostgresResultValue('timestamp', '2026-01-02 03:04:05', { schema: date() }),
    ).toEqual(new Date('2026-01-02T03:04:05Z'))

    expect(mapPostgresResultValue('timestamp', '2026-01-02T03:04:05Z')).toEqual(
      new Date('2026-01-02T03:04:05Z'),
    )

    expect(
      mapPostgresResultValue('timestamptz', '0042-01-02 12:53:21.123456+09:49:16', {
        schema: date(),
      }),
    ).toEqual(new Date('0042-01-02T03:04:05.123Z'))
  })

  it('should reject native seconds or fractions finer than a strict ISO schema', () => {
    expect(() =>
      mapPostgresResultValue('time', '03:04:05', { schema: pipe(string(), isoTime()) }),
    ).toThrow(QueryError)

    expect(() =>
      mapPostgresResultValue('timestamp', '2026-01-02 03:04:05.123456', {
        schema: pipe(string(), isoDateTimeSecond()),
      }),
    ).toThrow(QueryError)
  })
})

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
      schema: pipe(string(), target),
      authoredSchema: pipe(string(), local),
    }

    expect(() => validatePostgresValueMapping(type, context)).not.toThrow()
    expect(mapPostgresResultValue(type, raw, context)).toBe(expected)
  },
)

it.each([
  ['time', isoDateTimeSecond()],
  ['timestamp', isoTimeSecond()],
  ['timestamptz', isoDateTimeSecond()],
  ['date', isoTimestamp()],
  ['time', isoDate()],
])('should reject incompatible authored formats with %s storage', (type, format) => {
  const context = { schema: string(), authoredSchema: pipe(string(), format) }
  expect(() => validatePostgresValueMapping(type, context)).toThrow(SchemaError)
  expect(() => validatePostgresValueMapping(type, context)).toThrow(format.type)
  expect(() => validatePostgresValueMapping(type, context)).toThrow(type)

  expect(() => validatePostgresValueMapping(type, context)).toThrow(
    /paired column mapParam\/mapResult or client mapParamValue\/mapResultValue/,
  )
})

it('should reject ambiguous native formats and preserve explicit text spelling', () => {
  const context = {
    schema: pipe(string(), isoTime()),
    authoredSchema: pipe(string(), isoTime(), isoTimeSecond()),
  }

  expect(() => validatePostgresValueMapping('time', context)).toThrow(SchemaError)

  for (const type of ['text', 'varchar(40)']) {
    expect(() => validatePostgresValueMapping(type, context)).not.toThrow()
    expect(mapPostgresResultValue(type, '03:04:00', context)).toBe('03:04:00')
  }
})

it.each([
  ['time', isoTime(), '03:04:05'],
  ['time', isoTimeSecond(), '03:04:05.001'],
  ['timestamp', isoDateTime(), '2026-01-02 03:04:05'],
  ['timestamp', isoDateTimeSecond(), '2026-01-02 03:04:05.001'],
])('should reject finer stored precision for authored %s output', (type, format, raw) => {
  expect(() =>
    mapPostgresResultValue(type, raw, {
      schema: string(),
      authoredSchema: pipe(string(), format),
    }),
  ).toThrow(QueryError)
})

it('should retain target formatting when no authored temporal facts remain', () => {
  expect(
    mapPostgresResultValue('time', '03:04:00', {
      schema: pipe(string(), isoTime()),
      authoredSchema: string(),
    }),
  ).toBe('03:04')
})
