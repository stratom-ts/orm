import {
  array,
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
  maxValue,
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
  safeInteger,
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

import { assertSqliteDefaultCompatibility } from '@/dialects/sqlite/defaultCompatibility'
import {
  mapSqliteParamValueFromFacts,
  mapSqliteResultValueFromFacts,
} from '@/dialects/sqlite/mapping'
import { sqliteSchema } from '@/dialects/sqlite/schema'
import {
  inferSqliteColumnTypeFromFacts,
  validateSqliteValueMappingFromFacts,
} from '@/dialects/sqlite/storage'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { StorageFacts } from '@/storage/facts'
import type { AnySchema } from '@/types/schema'
import { MigrationError, QueryError, SchemaError } from '@/utils/error'

const inferColumnType = (schema: AnySchema) =>
  sqliteSchema.inferColumnType(extractStorageFacts(schema))

const registerSchemaCases5 = () => {
  it('should infer compatible composite logical storage', () => {
    expect(inferColumnType(union([pipe(number(), integer()), number()]))).toBe('REAL')

    expect(
      inferColumnType(union([pipe(number(), integer()), pipe(number(), integer())])),
    ).toBe('INTEGER')

    expect(inferColumnType(union([string(), literal('a')]))).toBe('TEXT')

    expect(inferColumnType(union([bigint(), literal(42n)]))).toBe('BIGINT')

    expect(inferColumnType(union([date(), date()]))).toBe('DATETIME')

    expect(
      inferColumnType(
        union([
          object({ values: array(undefinedable(string(), 'fallback')) }),
          object({ values: array(undefinedable(string(), 'fallback')) }),
        ]),
      ),
    ).toBe('JSON')

    expect(
      inferColumnType(union([union([nullSchema(), literal(null as never)]), string()])),
    ).toBe('TEXT')
  })

  it('should apply outer constraints through nested numeric composites', () => {
    expect(
      inferColumnType(
        pipe(
          union([
            union([pipe(number(), integer()), pipe(number(), integer())]),
            number(),
          ]),
          safeInteger(),
        ),
      ),
    ).toBe('INTEGER')
  })

  it('should retain safe-integer validation through a repeated number schema', () => {
    expect(inferColumnType(pipe(number(), safeInteger(), number()))).toBe('INTEGER')
  })
}

const registerSchemaCases9 = () => {
  it('should retain BIGINT for bounded and unbounded bigint composites', () => {
    for (const schema of [
      union([bigint(), bigint()]),
      pipe(
        union([intersect([bigint(), bigint()]), bigint()]),
        minValue(-(2n ** 63n)),
        maxValue(2n ** 63n - 1n),
      ),
    ])
      expect(inferColumnType(schema)).toBe('BIGINT')
  })
}

const registerSchemaCases10 = () => {
  it('should use outer integer bounds for numeric composite storage', () => {
    expect(
      inferColumnType(
        pipe(union([number(), number()]), integer(), minValue(0), maxValue(100)),
      ),
    ).toBe('INTEGER')
  })
}

const registerSchemaCases11 = () => {
  it('should infer JSON variants and object intersections', () => {
    const schema = variant('kind', [
      object({ kind: literal('a'), value: string() }),
      variant('kind', [object({ kind: literal('b'), value: number() })]),
    ])

    expect(inferColumnType(schema)).toBe('JSON')

    expect(
      inferColumnType(intersect([object({ a: string() }), object({ b: number() })])),
    ).toBe('JSON')

    const nullishSchema = object({ label: nullish(string()) })
    expect(inferColumnType(union([nullishSchema, nullishSchema]))).toBe('JSON')

    const defaulted = object({
      label: optional(pipe(date(), toString()), new Date('2026-01-01T00:00:00Z')),
    })

    expect(inferColumnType(union([defaulted, defaulted]))).toBe('JSON')
  })

  it('should reject composite branches with incompatible JavaScript output', () => {
    for (const schema of [
      union([string(), number()]),
      union([number(), bigint()]),
      union([date(), string()]),
      intersect([string(), number()]),
      union([literal(Number.MAX_SAFE_INTEGER + 1), number()]),
    ])
      expect(() => inferColumnType(schema)).toThrow(SchemaError)

    expect(
      inferColumnType(
        pipe(union([literal(Number.MAX_SAFE_INTEGER + 1), number()]), safeInteger()),
      ),
    ).toBe('INTEGER')
  })
}

const registerSchemaCases12 = () => {
  it.each([
    isoDate(),
    isoTime(),
    isoTimeSecond(),
    isoDateTime(),
    isoDateTimeSecond(),
    isoTimestamp(),
  ])('should infer TEXT for %s and DATETIME after toDate', (format) => {
    expect(inferColumnType(nullable(pipe(string(), format)))).toBe('TEXT')

    expect(inferColumnType(pipe(string(), format, toDate()))).toBe('DATETIME')
  })
}

const registerSchemaCases13 = () => {
  it('should infer distinct logical declared types while comparing their affinities stably', () => {
    expect(inferColumnType(string())).toBe('TEXT')

    expect(inferColumnType(pipe(number(), integer()))).toBe('INTEGER')

    expect(inferColumnType(number())).toBe('REAL')
    expect(inferColumnType(boolean())).toBe('BOOLEAN')
    expect(inferColumnType(date())).toBe('DATETIME')

    expect(inferColumnType(object({ value: string() }))).toBe('JSON')

    expect(sqliteSchema.normalizeDataType('BOOLEAN')).toBe('numeric')
    expect(sqliteSchema.normalizeDataType('JSON')).toBe('numeric')
    expect(sqliteSchema.normalizeDataType('INTEGER')).toBe('integer')
  })

  it('should infer homogeneous enum and picklist storage from their output values', () => {
    expect(inferColumnType(enumSchema({ first: 'a', second: 'b' }))).toBe('TEXT')

    expect(inferColumnType(picklist(['a', 'b']))).toBe('TEXT')

    expect(inferColumnType(picklist([1, 2]))).toBe('INTEGER')

    expect(inferColumnType(picklist([1, 1.5]))).toBe('REAL')

    expect(inferColumnType(picklist([1.5, 1]))).toBe('REAL')

    expect(inferColumnType(picklist([2, 1]))).toBe('INTEGER')

    expect(inferColumnType(enumSchema({ first: 1, second: 2 }))).toBe('INTEGER')

    expect(inferColumnType(enumSchema({ first: 1, second: 1.5 }))).toBe('REAL')
  })

  it('should infer boolean and bigint choice storage', () => {
    const booleanChoices = (
      picklist as unknown as (options: readonly boolean[]) => AnySchema
    )([true, false])

    expect(inferColumnType(nullable(booleanChoices))).toBe('BOOLEAN')

    expect(inferColumnType(picklist([1n, 2n]))).toBe('BIGINT')
  })

  it('should reject mixed choices with the explicit mapping contract', () => {
    for (const schema of [
      picklist(['1', 1]),
      picklist([null, 'a'] as unknown as [string, string]),
      enumSchema({ first: 1, second: 'a' }),
    ]) {
      expect(() => inferColumnType(schema)).toThrow(SchemaError)

      expect(() => inferColumnType(schema)).toThrow(
        /column\(\{ physicalType: \{ sqlite: \.\.\. \} \}\).*explicit parameter and result mappings/,
      )
    }
  })
}

const registerSchemaCases16 = () => {
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
    expect(inferColumnType(schema)).toBe('INTEGER')
  })
}

const registerSchemaCases17 = () => {
  it.each([
    ['NaN', picklist([0, Number.NaN])],
    ['positive infinity', picklist([0, Number.POSITIVE_INFINITY])],
    ['negative infinity', picklist([0, Number.NEGATIVE_INFINITY])],
    ['unsafe positive integer', picklist([0, Number.MAX_SAFE_INTEGER + 1])],
    ['unsafe negative integer', picklist([0, Number.MIN_SAFE_INTEGER - 1])],
  ])('should reject numeric choice option %s after a valid option', (_name, schema) => {
    expect(() => inferColumnType(schema)).toThrow(SchemaError)
  })

  it('should accept safe-integer boundary choices and reject their invalid neighbors', () => {
    expect(
      inferColumnType(picklist([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER])),
    ).toBe('INTEGER')

    expect(() => inferColumnType(picklist([0, Number.MAX_SAFE_INTEGER + 1]))).toThrow(
      SchemaError,
    )

    expect(() => inferColumnType(picklist([0, Number.MIN_SAFE_INTEGER - 1]))).toThrow(
      SchemaError,
    )
  })
}

const registerSchemaCases18 = () => {
  it('should accept signed 64-bit bigint boundaries and reject their invalid neighbors', () => {
    const min = -9223372036854775808n
    const max = 9223372036854775807n

    expect(inferColumnType(picklist([min, max]))).toBe('BIGINT')

    expect(() => inferColumnType(picklist([0n, min - 1n]))).toThrow(SchemaError)

    expect(() => inferColumnType(picklist([0n, max + 1n]))).toThrow(SchemaError)
  })
}

const registerSchemaCases19 = () => {
  it('should accept finite safe number literals and reject non-finite values consistently', () => {
    expect(inferColumnType(literal(Number.MIN_SAFE_INTEGER))).toBe('INTEGER')

    expect(inferColumnType(literal(Number.MAX_SAFE_INTEGER))).toBe('INTEGER')

    expect(inferColumnType(literal(1.25))).toBe('REAL')
  })
}

const registerSchemaCases20 = () => {
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

      for (const schema of schemas) expect(inferColumnType(schema)).toBe('TEXT')
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
      expect(inferColumnType(forward)).toBe('TEXT')
      expect(inferColumnType(reverse)).toBe('TEXT')
    },
  )
}

function registerSchemaGroup1() {
  it('should infer number storage for a nullable transformed output', () => {
    expect(
      inferColumnType(
        pipe(
          string(),
          transform((value): number | null => (value === 'null' ? null : Number(value))),
          nullable(number()),
        ),
      ),
    ).toBe('REAL')
  })
}

function registerSchemaGroup2() {
  it('should reject JSON composites whose nested outputs lose identity', () => {
    for (const schema of [
      union([object({ at: date() }), object({ at: date() })]),
      union([object({ id: bigint() }), object({ id: bigint() })]),
    ]) {
      expect(() => inferColumnType(schema)).toThrow(SchemaError)

      expect(() => inferColumnType(schema)).toThrow(
        /JSON composite output is not preserved.*paired parameter and result mappings/,
      )
    }
  })
}

function registerSchemaGroup3() {
  it('should infer JSON for recovered structured outputs', () => {
    const converted = pipe(
      object({ at: date() }),
      object({ at: pipe(date(), toString()) }),
    )

    const projected = pipe(
      object({ at: date(), label: string() }),
      object({ label: string() }) as never,
    )

    expect(inferColumnType(union([converted, converted]))).toBe('JSON')

    expect(inferColumnType(union([projected, projected]))).toBe('JSON')
  })
}

function registerSchemaGroup4() {
  it('should reject unsafe nested outputs in JSON variants and intersections', () => {
    for (const schema of [
      variant('kind', [
        object({ kind: literal('a'), at: date() }),
        object({ kind: literal('b'), at: date() }),
      ]),
      intersect([object({ at: date() }), object({ label: string() })]),
    ]) {
      expect(() => inferColumnType(schema)).toThrow(SchemaError)

      expect(() => inferColumnType(schema)).toThrow(
        /JSON composite output is not preserved.*paired parameter and result mappings/,
      )
    }
  })
}

function registerSchemaGroup5() {
  describe('SQLite schema', () => {
    registerSchemaCases5()
  })
}

function registerSchemaGroup6() {
  it('should preserve nested composite and enum proofs through later numeric schemas', () => {
    expect(
      inferColumnType(
        pipe(
          union([
            union([pipe(number(), safeInteger()), pipe(number(), safeInteger())]),
            union([pipe(number(), safeInteger()), pipe(number(), safeInteger())]),
          ]),
          number(),
          integer(),
        ),
      ),
    ).toBe('INTEGER')

    expect(
      inferColumnType(
        pipe(
          enumSchema({ large: 2147483648, small: 5 } as Record<string, number>),
          number(),
          integer(),
          maxValue(10),
        ),
      ),
    ).toBe('INTEGER')
  })
}

function registerSchemaGroup7() {
  it('should drop bigint composite choices excluded by a later bound', () => {
    expect(
      inferColumnType(
        pipe(
          union([literal<bigint>(2n ** 64n), literal<bigint>(5n)]),
          bigint(),
          maxValue(10n),
        ),
      ),
    ).toBe('BIGINT')

    expect(
      inferColumnType(
        pipe(
          union([literal<bigint>(2n ** 64n), literal<bigint>(5n)]),
          pipe(bigint(), maxValue(10n)),
        ),
      ),
    ).toBe('BIGINT')
  })
}

function registerSchemaGroup8() {
  it('should retain finite numeric proofs and apply later choice narrowing', () => {
    expect(
      inferColumnType(pipe(picklist([2147483648] as number[]), number(), integer())),
    ).toBe('INTEGER')

    expect(
      inferColumnType(
        pipe(
          picklist([Number.MAX_SAFE_INTEGER + 1, 5] as number[]),
          number(),
          safeInteger(),
        ),
      ),
    ).toBe('INTEGER')

    expect(
      inferColumnType(
        pipe(picklist([2147483648, 5] as number[]), number(), integer(), maxValue(10)),
      ),
    ).toBe('INTEGER')

    expect(
      inferColumnType(
        pipe(
          picklist([2147483648, 5] as number[]),
          union([number(), number()]),
          integer(),
          maxValue(10),
        ),
      ),
    ).toBe('INTEGER')
  })
}

function registerSchemaGroup9() {
  describe('SQLite bigint composite schema', () => {
    registerSchemaCases9()
  })
}

function registerSchemaGroup10() {
  describe('SQLite schema', () => {
    registerSchemaCases10()
  })
}

function registerSchemaGroup11() {
  describe('SQLite schema', () => {
    registerSchemaCases11()
  })
}

function registerSchemaGroup12() {
  describe('SQLite schema', () => {
    registerSchemaCases12()
  })
}

function registerSchemaGroup13() {
  describe('SQLite schema', () => {
    registerSchemaCases13()
  })
}

function registerSchemaGroup14() {
  it('should recover choice inference from a later supported schema', () => {
    expect(inferColumnType(pipe(string(), transform(Number), picklist([1, 2])))).toBe(
      'INTEGER',
    )
  })
}

function registerSchemaGroup15() {
  it('should infer physical types from supported transformed outputs', () => {
    expect(inferColumnType(pipe(string(), toBoolean()))).toBe('BOOLEAN')

    expect(inferColumnType(pipe(string(), parseBoolean()))).toBe('BOOLEAN')

    expect(inferColumnType(pipe(string(), toDate()))).toBe('DATETIME')

    expect(inferColumnType(pipe(number(), toString()))).toBe('TEXT')

    expect(
      inferColumnType(pipe(string(), parseJson(), object({ value: number() }))),
    ).toBe('JSON')

    expect(() => inferColumnType(pipe(string(), parseJson()))).toThrow(/physicalType/)
  })
}

function registerSchemaGroup16() {
  describe('SQLite schema', () => {
    registerSchemaCases16()
  })
}

function registerSchemaGroup17() {
  describe('SQLite schema', () => {
    registerSchemaCases17()
  })
}

function registerSchemaGroup18() {
  describe('SQLite schema', () => {
    registerSchemaCases18()
  })
}

function registerSchemaGroup19() {
  describe('SQLite schema', () => {
    registerSchemaCases19()
  })
}

function registerSchemaGroup20() {
  describe('SQLite schema', () => {
    registerSchemaCases20()
  })
}

describe('SQLite schema', () => {
  registerSchemaGroup1()
  registerSchemaGroup2()
  registerSchemaGroup3()
  registerSchemaGroup4()
  registerSchemaGroup5()
  registerSchemaGroup6()
  registerSchemaGroup7()
  registerSchemaGroup8()
  registerSchemaGroup9()
  registerSchemaGroup10()
  registerSchemaGroup11()
  registerSchemaGroup12()
  registerSchemaGroup13()
  registerSchemaGroup14()
  registerSchemaGroup15()
  registerSchemaGroup16()
  registerSchemaGroup17()
  registerSchemaGroup18()
  registerSchemaGroup19()
  registerSchemaGroup20()
})

function facts(overrides: Partial<StorageFacts>): StorageFacts {
  return {
    outputKind: 'number',
    outputState: 'known',
    nullable: false,
    allowsUndefined: false,
    outputMayBeUndefined: false,
    omitOnInsert: false,
    schemaDefault: { kind: 'absent' },
    stringConstraints: {},
    stringFormats: [],
    numberConstraints: {},
    bigintConstraints: {},
    nullOnly: false,
    ...overrides,
  }
}

it('should distinguish singleton safety from finite-choice safety', () => {
  expect(
    inferSqliteColumnTypeFromFacts(
      facts({ finiteEvidence: 'singleton', singletonValue: 1.5, finiteValues: [1.5] }),
    ),
  ).toBe('REAL')

  expect(
    inferSqliteColumnTypeFromFacts(
      facts({ finiteEvidence: 'choice', finiteValues: [1, 2] }),
    ),
  ).toBe('INTEGER')

  expect(() =>
    inferSqliteColumnTypeFromFacts(
      facts({
        finiteEvidence: 'singleton',
        singletonValue: Number.MAX_SAFE_INTEGER + 1,
        finiteValues: [],
      }),
    ),
  ).toThrow('unsafe integer literal')

  expect(() =>
    inferSqliteColumnTypeFromFacts(
      facts({
        finiteEvidence: 'choice',
        finiteValues: [1, Number.MAX_SAFE_INTEGER + 1],
      }),
    ),
  ).toThrow('choice output')
})

it('should keep bigint limits and composite numeric selection', () => {
  expect(() =>
    inferSqliteColumnTypeFromFacts(
      facts({
        outputKind: 'bigint',
        finiteEvidence: 'singleton',
        singletonValue: 2n ** 63n,
        finiteValues: [],
      }),
    ),
  ).toThrow('signed 64-bit')

  const integer = facts({ numberConstraints: { isInteger: true } })
  const real = facts({})
  expect(
    inferSqliteColumnTypeFromFacts(
      facts({ composite: { kind: 'alternatives', branches: [integer, real] } }),
    ),
  ).toBe('REAL')

  expect(() =>
    inferSqliteColumnTypeFromFacts(
      facts({
        outputKind: 'json',
        composite: { kind: 'intersection', branches: [facts({ outputKind: 'json' })] },
        jsonOutputCompatible: false,
      }),
    ),
  ).toThrow(SchemaError)
})

it('should map logical values while keeping resolved and authored facts separate', () => {
  const resolved = facts({ outputKind: 'boolean' })
  expect(mapSqliteParamValueFromFacts('INTEGER', true, resolved)).toBe(1)
  expect(mapSqliteResultValueFromFacts('INTEGER', 0, resolved)).toBe(false)

  expect(() =>
    validateSqliteValueMappingFromFacts(
      'INTEGER',
      resolved,
      facts({ outputKind: 'string' }),
    ),
  ).toThrow(SchemaError)

  expect(() =>
    mapSqliteParamValueFromFacts(
      'INTEGER',
      Number.MAX_SAFE_INTEGER + 1,
      facts({ numberConstraints: { isInteger: true } }),
    ),
  ).toThrow(QueryError)
})

it('should use default JSON shape evidence without read validation', () => {
  const array = facts({
    outputKind: 'json',
    jsonShape: 'object',
    defaultJsonShape: 'array',
  })

  expect(() =>
    assertSqliteDefaultCompatibility(
      { kind: 'literal', value: '[]' },
      'TEXT',
      array,
      false,
      'items.value',
    ),
  ).not.toThrow()

  expect(() =>
    assertSqliteDefaultCompatibility(
      { kind: 'literal', value: '{}' },
      'TEXT',
      array,
      false,
      'items.value',
    ),
  ).toThrow(MigrationError)
})
