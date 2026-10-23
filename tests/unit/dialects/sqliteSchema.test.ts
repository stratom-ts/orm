import {
  bigint,
  boolean,
  date,
  decimal,
  enum as enumSchema,
  exactOptional,
  integer,
  intersect,
  ip,
  ipv4,
  ipv6,
  isoDate,
  isoDateTime,
  isoDateTimeSecond,
  isoTime,
  isoTimeSecond,
  isoTimestamp,
  length,
  literal,
  mac,
  mac48,
  mac64,
  maxLength,
  minLength,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
  null as nullSchema,
  nullable,
  nullish,
  number,
  object,
  optional,
  parseBoolean,
  parseJson,
  picklist,
  pipe,
  string,
  toBoolean,
  toDate,
  toString,
  transform,
  undefinedable,
  union,
  uuid,
  variant,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { sqliteSchema } from '@/dialects/sqlite/schema'
import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

describe('SQLite schema', () => {
  it('should infer compatible composite logical storage', () => {
    expect(
      sqliteSchema.inferColumnType(union([pipe(number(), integer()), number()])),
    ).toBe('REAL')

    expect(
      sqliteSchema.inferColumnType(
        union([pipe(number(), integer()), pipe(number(), integer())]),
      ),
    ).toBe('INTEGER')

    expect(sqliteSchema.inferColumnType(union([string(), literal('a')]))).toBe('TEXT')
    expect(sqliteSchema.inferColumnType(union([bigint(), literal(42n)]))).toBe('BIGINT')
    expect(sqliteSchema.inferColumnType(union([date(), date()]))).toBe('DATETIME')

    expect(
      sqliteSchema.inferColumnType(
        union([union([nullSchema(), literal(null as never)]), string()]),
      ),
    ).toBe('TEXT')
  })

  it('should infer JSON variants and object intersections', () => {
    const schema = variant('kind', [
      object({ kind: literal('a'), value: string() }),
      variant('kind', [object({ kind: literal('b'), value: number() })]),
    ])

    expect(sqliteSchema.inferColumnType(schema)).toBe('JSON')

    expect(
      sqliteSchema.inferColumnType(
        intersect([object({ a: string() }), object({ b: number() })]),
      ),
    ).toBe('JSON')
  })

  it('should reject composite branches with incompatible JavaScript output', () => {
    for (const schema of [
      union([string(), number()]),
      union([number(), bigint()]),
      union([date(), string()]),
      intersect([string(), number()]),
      union([literal(Number.MAX_SAFE_INTEGER + 1), number()]),
    ])
      expect(() => sqliteSchema.inferColumnType(schema)).toThrow(SchemaError)
  })
})

describe('SQLite schema', () => {
  it.each([
    isoDate(),
    isoTime(),
    isoTimeSecond(),
    isoDateTime(),
    isoDateTimeSecond(),
    isoTimestamp(),
  ])('should infer TEXT for %s and DATETIME after toDate', (format) => {
    expect(sqliteSchema.inferColumnType(nullable(pipe(string(), format)))).toBe('TEXT')

    expect(sqliteSchema.inferColumnType(pipe(string(), format, toDate()))).toBe(
      'DATETIME',
    )
  })
})

describe('SQLite schema', () => {
  it('should infer distinct logical declared types while comparing their affinities stably', () => {
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

  it('should infer homogeneous enum and picklist storage from their output values', () => {
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

  it('should infer boolean and bigint choice storage', () => {
    const booleanChoices = (
      picklist as unknown as (options: readonly boolean[]) => AnySchema
    )([true, false])

    expect(sqliteSchema.inferColumnType(nullable(booleanChoices))).toBe('BOOLEAN')
    expect(sqliteSchema.inferColumnType(picklist([1n, 2n]))).toBe('BIGINT')
  })

  it('should reject mixed choices with the explicit mapping contract', () => {
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

it('should recover choice inference from a later supported schema', () => {
  expect(
    sqliteSchema.inferColumnType(pipe(string(), transform(Number), picklist([1, 2]))),
  ).toBe('INTEGER')
})

it('should infer physical types from supported transformed outputs', () => {
  expect(sqliteSchema.inferColumnType(pipe(string(), toBoolean()))).toBe('BOOLEAN')
  expect(sqliteSchema.inferColumnType(pipe(string(), parseBoolean()))).toBe('BOOLEAN')
  expect(sqliteSchema.inferColumnType(pipe(string(), toDate()))).toBe('DATETIME')
  expect(sqliteSchema.inferColumnType(pipe(number(), toString()))).toBe('TEXT')

  expect(
    sqliteSchema.inferColumnType(
      pipe(string(), parseJson(), object({ value: number() })),
    ),
  ).toBe('JSON')

  expect(() => sqliteSchema.inferColumnType(pipe(string(), parseJson()))).toThrow(
    /physicalType/,
  )
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
  ])('should infer numeric choice storage through %s wrappers', (_name, schema) => {
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
  ])('should reject numeric choice option %s after a valid option', (_name, schema) => {
    expect(() => sqliteSchema.inferColumnType(schema)).toThrow(SchemaError)
  })

  it('should accept safe-integer boundary choices and reject their invalid neighbors', () => {
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
  it('should accept signed 64-bit bigint boundaries and reject their invalid neighbors', () => {
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
  it('should accept finite safe number literals and reject non-finite values consistently', () => {
    expect(sqliteSchema.inferColumnType(literal(Number.MIN_SAFE_INTEGER))).toBe('INTEGER')
    expect(sqliteSchema.inferColumnType(literal(Number.MAX_SAFE_INTEGER))).toBe('INTEGER')
    expect(sqliteSchema.inferColumnType(literal(1.25))).toBe('REAL')
  })
})

describe('SQLite schema', () => {
  it.each([uuid(), ip(), ipv4(), ipv6(), mac48(), mac(), mac64(), decimal()])(
    'should keep $type format validation on TEXT storage',
    (format) => {
      const schemas = [
        pipe(string(), format),
        pipe(string(), format, format),
        nullable(pipe(string(), format)),
        pipe(string(), maxLength(80), format),
        pipe(string(), format, minLength(1), maxLength(80)),
        pipe(pipe(string(), length(36)), format),
        pipe(number(), toString(), format),
      ]

      for (const schema of schemas) {
        expect(sqliteSchema.inferColumnType(schema)).toBe('TEXT')
      }
    },
  )

  const nativeTargets = [uuid(), ip(), mac48(), mac64(), decimal()] as const
  const conflicts = nativeTargets.flatMap((first, index) =>
    nativeTargets.slice(index + 1).map((second) => ({ first, second })),
  )

  it.each(conflicts)(
    'should keep $first.type with $second.type on TEXT storage in either order',
    ({ first, second }) => {
      const forward = pipe(string(), first, second)
      const reverse = pipe(string(), second, first)
      expect(sqliteSchema.inferColumnType(forward)).toBe('TEXT')
      expect(sqliteSchema.inferColumnType(reverse)).toBe('TEXT')
    },
  )
})
