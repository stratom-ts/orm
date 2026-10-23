import {
  array,
  bigint,
  boolean,
  date,
  decimal,
  email,
  enum as enumSchema,
  exactOptional,
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
  safeParse,
  string,
  toBoolean,
  toDate,
  toNumber,
  toString,
  transform,
  undefinedable,
  union,
  uuid,
  variant,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { analyzeSchema } from '@/index'

it.each([
  isoDate(),
  isoTime(),
  isoTimeSecond(),
  isoDateTime(),
  isoDateTimeSecond(),
  isoTimestamp(),
])('should retain %s only while string output remains', (format) => {
  const schema = nullable(pipe(string(), format))
  expect(analyzeSchema(schema).stringFormats).toEqual([format.type])
  expect(analyzeSchema(pipe(string(), format, toDate())).stringFormats).toEqual([])
  expect(analyzeSchema(pipe(string(), format, string())).stringFormats).toEqual([])
})

it.each([ip(), ipv4(), ipv6(), mac(), mac48(), mac64(), decimal()])(
  'should retain %s through wrappers, nested pipes, and length constraints',
  (format) => {
    const validated = pipe(string(), format, maxLength(80))
    const schemas = [
      optional(validated),
      exactOptional(validated),
      undefinedable(validated),
      nullable(validated),
      nullish(validated),
      nonOptional(optional(validated)),
      nonNullable(nullable(validated)),
      nonNullish(nullish(validated)),
      nullable(nonNullable(nullable(validated))),
      optional(nonOptional(optional(validated))),
      nullish(nonNullish(nullish(validated))),
      pipe(pipe(string(), format), maxLength(80)),
      pipe(nonNullable(nullable(string())), format, maxLength(80)),
      pipe(nonNullable(nullable(validated)), format),
    ]

    for (const schema of schemas) {
      const analysis = analyzeSchema(schema)
      expect(analysis.stringFormats).toEqual([format.type])
      expect(analysis.stringConstraints).toEqual({ maxLength: 80 })
      expect(Object.isFrozen(analysis.stringFormats)).toBe(true)
    }
  },
)

it('should retain conflicting formats without selecting dialect storage', () => {
  const analysis = analyzeSchema(pipe(string(), uuid(), ip(), uuid(), decimal()))
  expect(analysis.stringFormats).toEqual(['uuid', 'ip', 'decimal'])
  expect(analysis.stringFormat).toBe('uuid')
})

it('should clear every format fact on conversions and later schemas', () => {
  const original = pipe(string(), uuid(), ip(), decimal())
  const schemas = [
    pipe(original, toNumber()),
    pipe(original, toBoolean()),
    pipe(original, toDate()),
    pipe(original, toString()),
    pipe(
      original,
      transform((value) => value),
    ),
    pipe(original, string()),
    pipe(original, parseJson(), object({ value: number() })),
  ]

  for (const schema of schemas) {
    expect(analyzeSchema(schema).stringFormats).toEqual([])
    expect(analyzeSchema(schema).stringFormat).toBeUndefined()
  }

  expect(analyzeSchema(pipe(original, string(), mac48())).stringFormats).toEqual([
    'mac48',
  ])

  expect(analyzeSchema(pipe(original, pipe(string(), ipv6()))).stringFormats).toEqual([
    'ipv6',
  ])

  expect(analyzeSchema(pipe(number(), toString(), decimal())).stringFormats).toEqual([
    'decimal',
  ])
})

describe('analyzeSchema UUID facts', () => {
  it('should record UUID validation without replacing string or length facts', () => {
    const schema = pipe(string(), minLength(30), uuid(), maxLength(36))
    const analysis = analyzeSchema(schema)

    expect(analysis).toMatchObject({
      stringFormat: 'uuid',
      outputKind: 'string',
      stringConstraints: { minLength: 30, maxLength: 36 },
    })

    expect(analysis.baseSchema.type).toBe('string')

    expect(analyzeSchema(pipe(string(), length(36), uuid())).stringConstraints).toEqual({
      minLength: 36,
      maxLength: 36,
    })

    expect(analyzeSchema(string()).stringFormat).toBeUndefined()
    expect(analyzeSchema(pipe(string(), email())).stringFormat).toBeUndefined()
  })
})

describe('analyzeSchema UUID wrappers', () => {
  it('should retain UUID through every supported wrapper family', () => {
    const validated = pipe(string(), uuid(), maxLength(36))
    const cases = [
      [optional(validated), false, true, true],
      [exactOptional(validated), false, true, true],
      [undefinedable(validated), false, true, false],
      [nullable(validated), true, false, false],
      [nullish(validated), true, true, true],
      [nonOptional(optional(validated)), false, false, false],
      [nonNullable(nullable(validated)), false, false, false],
      [nonNullish(nullish(validated)), false, false, false],
    ] as const

    for (const [schema, nullableValue, allowsUndefined, omitOnInsert] of cases) {
      expect(analyzeSchema(schema)).toMatchObject({
        stringFormat: 'uuid',
        stringConstraints: { maxLength: 36 },
        outputKind: 'string',
        nullable: nullableValue,
        allowsUndefined,
        omitOnInsert,
      })
    }
  })
})

describe('analyzeSchema UUID nested pipes', () => {
  it('should handle inner and outer pipes on nested and piped wrappers', () => {
    const base = pipe(string(), uuid())
    const inner = nullable(base)
    const outer = pipe(nonNullable(inner), uuid(), maxLength(36))
    expect(analyzeSchema(outer)).toMatchObject({
      stringFormat: 'uuid',
      stringConstraints: { maxLength: 36 },
      nullable: false,
      allowsUndefined: false,
      omitOnInsert: false,
      outputKind: 'string',
    })

    expect(analyzeSchema(outer).unwrappedSchema).toBe(base)

    const outerOnlyBase = string()
    const outerOnly = pipe(nonNullable(nullable(outerOnlyBase)), uuid(), maxLength(36))
    expect(analyzeSchema(outerOnly)).toMatchObject({
      stringFormat: 'uuid',
      stringConstraints: { maxLength: 36 },
      nullable: false,
    })

    expect(analyzeSchema(outerOnly).unwrappedSchema).toBe(outerOnlyBase)

    const innerOnlyBase = pipe(string(), uuid(), maxLength(36))
    expect(analyzeSchema(nonNullable(nullable(innerOnlyBase))).unwrappedSchema).toBe(
      innerOnlyBase,
    )

    expect(analyzeSchema(nonNullable(nullable(innerOnlyBase))).stringFormat).toBe('uuid')

    const reversed = optional(nonNullish(pipe(string(), maxLength(36), uuid())))
    expect(analyzeSchema(reversed)).toMatchObject({
      stringFormat: 'uuid',
      nullable: false,
      allowsUndefined: true,
      omitOnInsert: true,
    })
  })
})

describe('analyzeSchema UUID defaults', () => {
  it('should retain defaults around and inside piped wrappers', () => {
    const defaulted = optional(
      pipe(string(), uuid()),
      '550e8400-e29b-41d4-a716-446655440000',
    )

    expect(analyzeSchema(defaulted)).toMatchObject({
      stringFormat: 'uuid',
      schemaDefault: '550e8400-e29b-41d4-a716-446655440000',
      omitOnInsert: true,
    })

    const pipedDefault = pipe(
      optional(string(), '550e8400-e29b-41d4-a716-446655440000'),
      uuid(),
    )

    expect(analyzeSchema(pipedDefault)).toMatchObject({
      stringFormat: 'uuid',
      schemaDefault: '550e8400-e29b-41d4-a716-446655440000',
      allowsUndefined: true,
      omitOnInsert: true,
    })
  })
})

describe('analyzeSchema', () => {
  it('should report direct wrapper semantics and dialect-neutral output facts', () => {
    const cases = [
      [optional(string()), false, true, 'string'],
      [exactOptional(string()), false, true, 'string'],
      [undefinedable(number()), false, false, 'number'],
      [nullable(string()), true, false, 'string'],
      [nullish(string()), true, true, 'string'],
      [nonOptional(nullable(string())), true, false, 'string'],
      [nonNullable(nullable(string())), false, false, 'string'],
      [nonNullish(nullish(string())), false, false, 'string'],
    ] as const

    for (const [schema, nullableValue, omitOnInsert, outputKind] of cases) {
      expect(analyzeSchema(schema).nullable).toBe(nullableValue)
      expect(analyzeSchema(schema).omitOnInsert).toBe(omitOnInsert)
      expect(analyzeSchema(schema).outputKind).toBe(outputKind)
    }
  })

  it('should reduce nested wrappers inside-out and retain constraints below them', () => {
    const schema = nonNullable(nullable(optional(pipe(string(), maxLength(80)))))
    const analysis = analyzeSchema(schema)

    expect(analysis.nullable).toBe(false)
    expect(analysis.omitOnInsert).toBe(false)
    expect(analysis.stringConstraints).toEqual({ maxLength: 80 })
    expect(analysis.baseSchema.type).toBe('string')

    const numeric = analyzeSchema(exactOptional(pipe(number(), maxValue(100))))
    expect(numeric.numberConstraints).toEqual({ maxValue: 100 })
    expect(numeric.baseSchema.type).toBe('number')
  })

  it('should only report output kinds for homogeneous enum-like options', () => {
    expect(analyzeSchema(picklist(['a', 'b'])).outputKind).toBe('string')
    expect(analyzeSchema(enumSchema({ A: 'a', B: 'b' })).outputKind).toBe('string')
    expect(analyzeSchema(picklist(['a', 1])).outputKind).toBeUndefined()
    expect(analyzeSchema(enumSchema({ A: 'a', B: 1 })).outputKind).toBeUndefined()
  })
})

describe('analyzeSchema: reports every supported scalar and JSON-shaped output family', () => {
  it('should report every supported scalar and JSON-shaped output family', () => {
    expect(analyzeSchema(string()).outputKind).toBe('string')
    expect(analyzeSchema(number()).outputKind).toBe('number')
    expect(analyzeSchema(bigint()).outputKind).toBe('bigint')
    expect(analyzeSchema(boolean()).outputKind).toBe('boolean')
    expect(analyzeSchema(date()).outputKind).toBe('date')
    expect(analyzeSchema(object({ id: string() })).outputKind).toBe('json')
    expect(analyzeSchema(array(string())).outputKind).toBe('json')
  })

  it('should leave unsupported mixed-output schemas unclassified', () => {
    expect(analyzeSchema(union([string(), number()])).outputKind).toBeUndefined()
  })
})

describe('analyzeSchema composites', () => {
  it('should derive nullable storage branches without making null an insert omission', () => {
    const schema = union([
      union([nullSchema(), literal(null as never)]),
      pipe(string(), maxLength(12)),
    ])

    const analysis = analyzeSchema(schema)

    expect(analysis).toMatchObject({
      outputKind: 'string',
      nullable: true,
      omitOnInsert: false,
    })

    expect(analysis.composite?.branches[0]?.nullOnly).toBe(true)
    expect(analysis.composite?.branches[1]?.stringConstraints.maxLength).toBe(12)
    expect(analyzeSchema(nonNullable(schema)).nullable).toBe(false)
  })

  it('should require an outer wrapper for insert omission and retain its default', () => {
    const schema = union([optional(string(), 'fallback'), string()])
    expect(analyzeSchema(schema)).toMatchObject({
      outputKind: 'string',
      allowsUndefined: true,
      omitOnInsert: false,
    })

    expect(analyzeSchema(optional(schema, 'outer'))).toMatchObject({
      omitOnInsert: true,
      schemaDefault: 'outer',
    })

    expect(safeParse(schema, undefined).output).toBe('fallback')
  })

  it('should clear nullability when a known conversion produces a non-null output', () => {
    const schema = pipe(union([string(), nullSchema()]), toString())
    expect(analyzeSchema(schema)).toMatchObject({ outputKind: 'string', nullable: false })
    expect(safeParse(schema, null).output).toBe('null')
  })
})

describe('analyzeSchema composites', () => {
  it('should retain nested variant and intersect output facts and clear them after conversion', () => {
    const choice = variant('kind', [
      object({ kind: literal('a'), value: string() }),
      variant('kind', [object({ kind: literal('b'), value: number() })]),
    ])

    const merged = intersect([object({ name: string() }), object({ age: number() })])

    expect(analyzeSchema(choice).outputKind).toBe('json')
    expect(analyzeSchema(merged).composite?.type).toBe('intersect')

    expect(
      analyzeSchema(pipe(union([string(), string()]), maxLength(20))).stringConstraints
        .maxLength,
    ).toBe(20)

    expect(
      analyzeSchema(pipe(union([string(), string()]), toNumber())).composite,
    ).toBeUndefined()

    expect(
      analyzeSchema(pipe(union([string(), string()]), toNumber(), number())).composite,
    ).toBeUndefined()
  })

  it('should leave mixed or unknown branch outputs unclassified', () => {
    expect(analyzeSchema(union([string(), number()])).outputKind).toBeUndefined()

    expect(
      analyzeSchema(union([string(), pipe(string(), transform(Number))])).outputKind,
    ).toBeUndefined()
  })
})

it('should distinguish consumed null inputs from stored null outputs', () => {
  const cases = [
    [pipe(nullable(string()), toNumber()), 'number', false, false],
    [pipe(nullable(string()), toString()), 'string', false, false],
    [pipe(nullish(string()), toNumber()), 'number', false, true],
    [pipe(nullish(string()), toString()), 'string', false, true],
    [pipe(union([string(), nullSchema()]), toString(), string()), 'string', false, false],
    [nullable(string()), 'string', true, false],
    [pipe(nullable(string(), 'fallback'), toString()), 'string', false, false],
    [pipe(nullable(string(), 'fallback'), maxLength(20)), 'string', true, false],
  ] as const

  for (const [schema, outputKind, nullableValue, omitOnInsert] of cases) {
    expect(analyzeSchema(schema)).toMatchObject({
      outputKind,
      nullable: nullableValue,
      omitOnInsert,
    })
  }
})

describe('analyzeSchema ordered transformations', () => {
  it('should derive output kinds and retain only constraints on the current output', () => {
    expect(
      analyzeSchema(
        pipe(string(), maxLength(10), toNumber(), minValue(0), maxValue(100)),
      ),
    ).toMatchObject({
      outputKind: 'number',
      stringConstraints: {},
      numberConstraints: { minValue: 0, maxValue: 100 },
    })

    expect(analyzeSchema(pipe(string(), toBoolean())).outputKind).toBe('boolean')
    expect(analyzeSchema(pipe(string(), parseBoolean())).outputKind).toBe('boolean')
    expect(analyzeSchema(pipe(string(), toDate())).outputKind).toBe('date')
    expect(analyzeSchema(pipe(number(), toString())).outputKind).toBe('string')
  })

  it('should leave unknown outputs unresolved until a supported schema restores them', () => {
    expect(analyzeSchema(pipe(string(), parseJson())).outputKind).toBeUndefined()
    expect(analyzeSchema(pipe(string(), transform(Number))).outputKind).toBeUndefined()

    expect(
      analyzeSchema(pipe(string(), parseJson(), object({ value: number() }))).outputKind,
    ).toBe('json')
  })

  it('should retain output nullability restored by a later schema', () => {
    const analysis = analyzeSchema(
      pipe(
        string(),
        transform((value) => (value ? null : value)),
        nullable(string()),
      ),
    )

    expect(analysis).toMatchObject({
      outputKind: 'string',
      nullable: true,
      omitOnInsert: false,
    })
  })
})

describe('analyzeSchema recovered wrapper semantics', () => {
  it('should retain output undefined tolerance without making required input omittable', () => {
    const optionalSchema = pipe(
      pipe(
        string(),
        transform((value): number | undefined => (value ? undefined : 0)),
      ),
      optional(number()),
    )

    const analysis = analyzeSchema(optionalSchema)

    expect(analysis).toMatchObject({
      outputKind: 'number',
      allowsUndefined: true,
      omitOnInsert: false,
    })

    expect(safeParse(optionalSchema, 'required')).toMatchObject({
      success: true,
      output: undefined,
    })

    const nonOptionalSchema = pipe(
      pipe(
        string(),
        transform((): number => 0),
      ),
      nonOptional(optional(number())),
    )

    const nonOptionalAnalysis = analyzeSchema(nonOptionalSchema)

    expect(nonOptionalAnalysis).toMatchObject({
      allowsUndefined: false,
      omitOnInsert: false,
    })

    expect(safeParse(nonOptionalSchema, 'required')).toMatchObject({
      success: true,
      output: 0,
    })
  })
})

it('should preserve wrapper semantics around nested transformed pipes', () => {
  const transformed = pipe(pipe(string(), toNumber()), minValue(0))
  const wrappers = [
    optional(transformed),
    exactOptional(transformed),
    undefinedable(transformed),
    nullable(transformed),
    nullish(transformed),
    nonOptional(optional(transformed)),
    nonNullable(nullable(transformed)),
    nonNullish(nullish(transformed)),
  ]

  expect(wrappers.map((schema) => analyzeSchema(schema).outputKind)).toEqual(
    Array(8).fill('number'),
  )
})
