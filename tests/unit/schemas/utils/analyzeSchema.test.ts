import {
  array,
  bigint,
  boolean,
  date,
  decimal,
  email,
  enum as enumSchema,
  exactOptional,
  fallback,
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
  objectWithRest,
  optional,
  parseBoolean,
  parseJson,
  picklist,
  pipe,
  record,
  safeInteger,
  safeParse,
  strictObject,
  strictTuple,
  string,
  toBoolean,
  toDate,
  toNumber,
  toString,
  transform,
  tuple,
  tupleWithRest,
  undefinedable,
  union,
  unknown,
  uuid,
  variant,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { defineTable, reference, unwrapDeep } from '@/index'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { AnySchema } from '@/types/schema'

it.each([
  isoDate(),
  isoTime(),
  isoTimeSecond(),
  isoDateTime(),
  isoDateTimeSecond(),
  isoTimestamp(),
])('should retain %s only while string output remains', (format) => {
  const schema = nullable(pipe(string(), format))
  expect(extractStorageFacts(schema).stringFormats).toEqual([format.type])

  expect(extractStorageFacts(pipe(string(), format, toDate())).stringFormats).toEqual([])

  expect(extractStorageFacts(pipe(string(), format, string())).stringFormats).toEqual([
    format.type,
  ])
})

it('should reject JSON composites with nested identity-losing outputs', () => {
  const jsonNative = union([
    object({ id: string(), count: number(), active: boolean() }),
    object({ id: string(), count: number(), active: boolean() }),
  ])

  const nestedDate = union([object({ at: date() }), object({ at: date() })])
  const nestedBigint = union([object({ id: bigint() }), object({ id: bigint() })])
  const nestedInfinity = union([
    object({ value: literal(Number.POSITIVE_INFINITY) }),
    object({ value: literal(Number.NEGATIVE_INFINITY) }),
  ])

  expect(extractStorageFacts(jsonNative).jsonOutputCompatible).toBe(true)
  expect(extractStorageFacts(nestedDate).jsonOutputCompatible).toBe(false)
  expect(extractStorageFacts(nestedBigint).jsonOutputCompatible).toBe(false)
  expect(extractStorageFacts(nestedInfinity).jsonOutputCompatible).toBe(false)
})

it('should preserve JSON-safe array, optional, and nested union outputs', () => {
  const nestedArrayHole = union([
    object({ values: array(optional(string())) }),
    object({ values: array(optional(string())) }),
  ])

  const nestedCompositeArrayHole = union([
    object({ values: array(union([optional(string()), string()])) }),
    object({ values: array(union([optional(string()), string()])) }),
  ])

  const nonOptionalArrayValue = union([
    object({ values: array(nonOptional(optional(string()))) }),
    object({ values: array(nonOptional(optional(string()))) }),
  ])

  const defaultedArrayValue = union([
    object({ values: array(optional(string(), 'fallback')) }),
    object({ values: array(optional(string(), 'fallback')) }),
  ])

  const convertedOptionalArrayValue = union([
    object({ values: array(pipe(optional(string()), toString())) }),
    object({ values: array(pipe(optional(string()), toString())) }),
  ])

  const optionalProperty = union([
    object({ label: optional(string()) }),
    object({ label: optional(string()) }),
  ])

  const nestedNativeUnion = union([
    object({ value: union([string(), number(), nullSchema()]) }),
    object({ value: union([string(), number(), nullSchema()]) }),
  ])

  const nestedConversionUnion = union([
    object({ value: union([pipe(string(), toNumber()), number()]) }),
    object({ value: union([pipe(string(), toNumber()), number()]) }),
  ])

  expect(extractStorageFacts(nestedArrayHole).jsonOutputCompatible).toBe(false)
  expect(extractStorageFacts(nestedCompositeArrayHole).jsonOutputCompatible).toBe(false)
  expect(extractStorageFacts(nonOptionalArrayValue).jsonOutputCompatible).toBe(true)
  expect(extractStorageFacts(defaultedArrayValue).jsonOutputCompatible).toBe(true)
  expect(extractStorageFacts(convertedOptionalArrayValue).jsonOutputCompatible).toBe(true)
  expect(extractStorageFacts(nestedNativeUnion).jsonOutputCompatible).toBe(true)
  expect(extractStorageFacts(nestedConversionUnion).jsonOutputCompatible).toBe(true)
  expect(extractStorageFacts(optionalProperty).jsonOutputCompatible).toBe(true)
  const nullishProperty = object({ label: nullish(string()) })
  expect(
    extractStorageFacts(union([nullishProperty, nullishProperty])).jsonOutputCompatible,
  ).toBe(true)

  expect(
    extractStorageFacts(union([object({ label: string() }), nullSchema()]))
      .jsonOutputCompatible,
  ).toBe(true)
})

it('should treat undefinedable defaults as defined array outputs', () => {
  const schema = union([
    object({ values: array(undefinedable(string(), 'fallback')) }),
    object({ values: array(undefinedable(string(), 'fallback')) }),
  ])

  expect(extractStorageFacts(schema).jsonOutputCompatible).toBe(true)
})

it('should analyze optional defaults through their transformed output schema', () => {
  let defaultCalls = 0
  const defaultDate = new Date('2026-01-01T00:00:00.000Z')
  const shape = object({
    label: optional(pipe(date(), toString()), () => {
      defaultCalls += 1
      return defaultDate
    }),
  })

  expect(extractStorageFacts(union([shape, shape])).jsonOutputCompatible).toBe(true)
  expect(defaultCalls).toBe(0)

  const parsed = safeParse(shape, {})
  expect(parsed).toMatchObject({
    success: true,
    output: { label: defaultDate.toString() },
  })

  expect(defaultCalls).toBe(1)
})

it('should retain JSON loss evidence until a transformation proves safe output', () => {
  const unsafeThenValidated = pipe(
    union([object({ at: date() }), object({ at: date() })]),
    object({ at: date() }),
  )

  const recoveredAfterTransform = union([
    pipe(
      unknown(),
      transform(() => ({ label: 'safe' })),
      object({ label: string() }),
    ),
    object({ label: string() }),
  ])

  const variantDate = variant('kind', [
    object({ kind: literal('date'), at: date() }),
    object({ kind: literal('other'), at: date() }),
  ])

  const intersectDate = intersect([object({ at: date() }), object({ label: string() })])
  const nullBranch = union([object({ label: string() }), nullSchema()])

  expect(extractStorageFacts(nullBranch).jsonOutputCompatible).toBe(true)
  expect(extractStorageFacts(unsafeThenValidated).jsonOutputCompatible).toBe(false)
  expect(extractStorageFacts(recoveredAfterTransform).jsonOutputCompatible).toBe(true)
  expect(extractStorageFacts(variantDate).jsonOutputCompatible).toBe(false)
  expect(extractStorageFacts(intersectDate).jsonOutputCompatible).toBe(false)
})

it.each([
  {
    name: 'object member conversion',
    branch: pipe(object({ at: date() }), object({ at: pipe(date(), toString()) })),
  },
  {
    name: 'bigint member conversion',
    branch: pipe(object({ id: bigint() }), object({ id: pipe(bigint(), toString()) })),
  },
  // Valibot parses these projections, but its pipe type requires an unchanged shape.
  {
    name: 'object projection',
    branch: pipe(
      object({ at: date(), label: string() }),
      object({ label: string() }) as never,
    ),
  },
  {
    name: 'tuple conversion and projection',
    branch: pipe(tuple([date(), string()]), tuple([pipe(date(), toString())]) as never),
  },
  {
    name: 'tuple tail projection',
    branch: pipe(tuple([string(), date()]), tuple([string()]) as never),
  },
  {
    name: 'strict object member conversion',
    branch: pipe(object({ at: date() }), strictObject({ at: pipe(date(), toString()) })),
  },
  {
    name: 'object rest member conversion',
    branch: pipe(
      object({ at: date() }),
      objectWithRest({ at: pipe(date(), toString()) }, string()),
    ),
  },
  {
    name: 'strict tuple slot conversion',
    branch: pipe(tuple([date()]), strictTuple([pipe(date(), toString())])),
  },
  {
    name: 'tuple rest slot conversion',
    branch: pipe(
      tupleWithRest([date()], string()),
      tupleWithRest([pipe(date(), toString())], string()),
    ),
  },
  {
    name: 'array item conversion',
    branch: pipe(array(date()), array(pipe(date(), toString()))),
  },
  {
    name: 'record value conversion',
    branch: pipe(record(string(), date()), record(string(), pipe(date(), toString()))),
  },
  {
    name: 'defaulted member conversion',
    branch: pipe(
      object({ at: optional(date()) }),
      object({ at: optional(pipe(date(), toString()), new Date('2026-01-01')) }),
    ),
  },
  {
    name: 'numeric record key conversion',
    branch: pipe(
      record(string(), date()),
      record(pipe(string(), toNumber()), pipe(date(), toString())),
    ),
  },
])('should prove later structured output is JSON-safe: $name', ({ branch }) => {
  expect(extractStorageFacts(union([branch, branch])).jsonOutputCompatible).toBe(true)
})

it('should parse projected object fields and tuple tail away', () => {
  const at = new Date('2026-01-01T00:00:00.000Z')
  const projectedObject = pipe(
    object({ at: date(), label: string() }),
    object({ label: string() }) as never,
  )

  const projectedTuple = pipe(tuple([string(), date()]), tuple([string()]) as never)

  const parsedObject = safeParse(projectedObject, { at, label: 'kept' })
  const parsedTuple = safeParse(projectedTuple, ['kept', at])

  expect(parsedObject.success).toBe(true)
  expect(parsedTuple.success).toBe(true)
  expect(parsedObject).toHaveProperty('output', { label: 'kept' })
  expect(parsedTuple).toHaveProperty('output', ['kept'])
})

it.each([
  {
    name: 'unconverted bigint member',
    branch: pipe(
      object({ at: date(), id: bigint() }),
      object({ at: pipe(date(), toString()), id: bigint() }),
    ),
  },
  {
    name: 'undefined tuple slot',
    branch: pipe(
      tuple([date(), optional(string())]),
      tuple([pipe(date(), toString()), optional(string())]),
    ),
  },
  {
    name: 'strict object validation',
    branch: pipe(object({ at: date() }), strictObject({ at: date() })),
  },
  {
    name: 'strict tuple validation',
    branch: pipe(tuple([date()]), strictTuple([date()])),
  },
  {
    name: 'object validation',
    branch: pipe(object({ at: date() }), object({ at: date() })),
  },
  {
    name: 'unknown nested transformation',
    branch: pipe(
      object({ at: date() }),
      object({
        at: pipe(
          date(),
          transform((at) => at),
        ),
      }),
    ),
  },
  {
    name: 'symbol record key',
    branch: pipe(
      record(string(), date()),
      record(
        pipe(
          string(),
          transform(() => Symbol('key')),
        ),
        pipe(date(), toString()),
      ),
    ),
  },
])('should retain genuinely unsafe structured output: $name', ({ branch }) => {
  expect(extractStorageFacts(union([branch, branch])).jsonOutputCompatible).toBe(false)
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
      const analysis = extractStorageFacts(schema)
      expect(analysis.stringFormats).toEqual([format.type])
      expect(analysis.stringConstraints).toEqual({ maxLength: 80 })
      expect(Object.isFrozen(analysis.stringFormats)).toBe(true)
    }
  },
)

it('should retain conflicting formats without selecting dialect storage', () => {
  const analysis = extractStorageFacts(pipe(string(), uuid(), ip(), uuid(), decimal()))
  expect(analysis.stringFormats).toEqual(['uuid', 'ip', 'decimal'])
  expect(analysis.stringFormats).toContain('uuid')
})

it('should clear format facts on conversions and retain them across validation schemas', () => {
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
    pipe(original, parseJson(), object({ value: number() })),
  ]

  for (const schema of schemas) {
    expect(extractStorageFacts(schema).stringFormats).toEqual([])
    expect(extractStorageFacts(schema).stringFormats).toEqual([])
  }

  expect(extractStorageFacts(pipe(original, string())).stringFormats).toEqual([
    'uuid',
    'ip',
    'decimal',
  ])

  expect(extractStorageFacts(pipe(original, string(), mac48())).stringFormats).toEqual([
    'uuid',
    'ip',
    'decimal',
    'mac48',
  ])

  expect(
    extractStorageFacts(pipe(original, pipe(string(), ipv6()))).stringFormats,
  ).toEqual(['uuid', 'ip', 'decimal', 'ipv6'])

  expect(
    extractStorageFacts(pipe(number(), toString(), decimal())).stringFormats,
  ).toEqual(['decimal'])
})

describe('extractStorageFacts UUID facts', () => {
  it('should record UUID validation without replacing string or length facts', () => {
    const schema = pipe(string(), minLength(30), uuid(), maxLength(36))
    const analysis = extractStorageFacts(schema)

    expect(analysis).toMatchObject({
      stringFormats: ['uuid'],
      outputKind: 'string',
      stringConstraints: { minLength: 30, maxLength: 36 },
    })

    expect(analysis.outputKind).toBe('string')

    expect(
      extractStorageFacts(pipe(string(), length(36), uuid())).stringConstraints,
    ).toEqual({
      minLength: 36,
      maxLength: 36,
    })

    expect(extractStorageFacts(string()).stringFormats).toEqual([])
    expect(extractStorageFacts(pipe(string(), email())).stringFormats).toEqual([])
  })
})

describe('extractStorageFacts UUID wrappers', () => {
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
      expect(extractStorageFacts(schema)).toMatchObject({
        stringFormats: ['uuid'],
        stringConstraints: { maxLength: 36 },
        outputKind: 'string',
        nullable: nullableValue,
        allowsUndefined,
        omitOnInsert,
      })
    }
  })
})

describe('extractStorageFacts UUID nested pipes', () => {
  it('should handle inner and outer pipes on nested and piped wrappers', () => {
    const base = pipe(string(), uuid())
    const inner = nullable(base)
    const outer = pipe(nonNullable(inner), uuid(), maxLength(36))
    expect(extractStorageFacts(outer)).toMatchObject({
      stringFormats: ['uuid'],
      stringConstraints: { maxLength: 36 },
      nullable: false,
      allowsUndefined: false,
      omitOnInsert: false,
      outputKind: 'string',
    })

    expect(unwrapDeep(outer)).toBe(base)

    const outerOnlyBase = string()
    const outerOnly = pipe(nonNullable(nullable(outerOnlyBase)), uuid(), maxLength(36))
    expect(extractStorageFacts(outerOnly)).toMatchObject({
      stringFormats: ['uuid'],
      stringConstraints: { maxLength: 36 },
      nullable: false,
    })

    expect(unwrapDeep(outerOnly)).toBe(outerOnlyBase)

    const innerOnlyBase = pipe(string(), uuid(), maxLength(36))
    expect(unwrapDeep(nonNullable(nullable(innerOnlyBase)))).toBe(innerOnlyBase)

    expect(
      extractStorageFacts(nonNullable(nullable(innerOnlyBase))).stringFormats,
    ).toContain('uuid')

    const reversed = optional(nonNullish(pipe(string(), maxLength(36), uuid())))
    expect(extractStorageFacts(reversed)).toMatchObject({
      stringFormats: ['uuid'],
      nullable: false,
      allowsUndefined: true,
      omitOnInsert: true,
    })
  })
})

describe('extractStorageFacts UUID defaults', () => {
  it('should retain defaults around and inside piped wrappers', () => {
    const defaulted = optional(
      pipe(string(), uuid()),
      '550e8400-e29b-41d4-a716-446655440000',
    )

    expect(extractStorageFacts(defaulted)).toMatchObject({
      stringFormats: ['uuid'],
      schemaDefault: { kind: 'value', value: '550e8400-e29b-41d4-a716-446655440000' },
      omitOnInsert: true,
    })

    const pipedDefault = pipe(
      optional(string(), '550e8400-e29b-41d4-a716-446655440000'),
      uuid(),
    )

    expect(extractStorageFacts(pipedDefault)).toMatchObject({
      stringFormats: ['uuid'],
      schemaDefault: { kind: 'value', value: '550e8400-e29b-41d4-a716-446655440000' },
      allowsUndefined: true,
      omitOnInsert: true,
    })
  })
})

describe('extractStorageFacts', () => {
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
      expect(extractStorageFacts(schema).nullable).toBe(nullableValue)
      expect(extractStorageFacts(schema).omitOnInsert).toBe(omitOnInsert)
      expect(extractStorageFacts(schema).outputKind).toBe(outputKind)
    }
  })

  it('should reduce nested wrappers inside-out and retain constraints below them', () => {
    const schema = nonNullable(nullable(optional(pipe(string(), maxLength(80)))))
    const analysis = extractStorageFacts(schema)

    expect(analysis.nullable).toBe(false)
    expect(analysis.omitOnInsert).toBe(false)
    expect(analysis.stringConstraints).toEqual({ maxLength: 80 })
    expect(analysis.outputKind).toBe('string')

    const numeric = extractStorageFacts(exactOptional(pipe(number(), maxValue(100))))
    expect(numeric.numberConstraints).toEqual({ maxValue: 100 })
    expect(numeric.outputKind).toBe('number')
  })

  it('should only report output kinds for homogeneous enum-like options', () => {
    expect(extractStorageFacts(picklist(['a', 'b'])).outputKind).toBe('string')
    expect(extractStorageFacts(enumSchema({ A: 'a', B: 'b' })).outputKind).toBe('string')
    expect(extractStorageFacts(picklist(['a', 1])).outputKind).toBeUndefined()
    expect(extractStorageFacts(enumSchema({ A: 'a', B: 1 })).outputKind).toBeUndefined()
  })
})

describe('extractStorageFacts: reports every supported scalar and JSON-shaped output family', () => {
  it('should report every supported scalar and JSON-shaped output family', () => {
    expect(extractStorageFacts(string()).outputKind).toBe('string')
    expect(extractStorageFacts(number()).outputKind).toBe('number')
    expect(extractStorageFacts(bigint()).outputKind).toBe('bigint')
    expect(extractStorageFacts(boolean()).outputKind).toBe('boolean')
    expect(extractStorageFacts(date()).outputKind).toBe('date')
    expect(extractStorageFacts(object({ id: string() })).outputKind).toBe('json')
    expect(extractStorageFacts(array(string())).outputKind).toBe('json')
  })

  it('should leave unsupported mixed-output schemas unclassified', () => {
    expect(extractStorageFacts(union([string(), number()])).outputKind).toBeUndefined()
  })
})

describe('extractStorageFacts bigint composites', () => {
  it('should retain outer bigint bounds separately from nested branch bounds', () => {
    const min = -(2n ** 63n)
    const max = 2n ** 63n - 1n
    const schema = nullable(
      pipe(
        union([
          pipe(bigint(), minValue(min + 1n)),
          pipe(intersect([bigint(), bigint()]), maxValue(max - 1n)),
        ]),
        minValue(min),
        maxValue(max),
      ),
    )

    const analysis = extractStorageFacts(schema)
    expect(analysis).toMatchObject({
      outputKind: 'bigint',
      nullable: true,
      numberConstraints: {},
      bigintConstraints: { minValue: min, maxValue: max },
    })

    expect(analysis.composite?.branches[0]?.bigintConstraints).toEqual({
      minValue: min + 1n,
    })

    expect(analysis.composite?.branches[1]).toMatchObject({
      bigintConstraints: { maxValue: max - 1n },
      composite: { kind: 'intersection' },
    })
  })
})

describe('extractStorageFacts composites', () => {
  it('should combine SQL nullability from composite branches with defaults and null-only schemas', () => {
    const defaultedUnion = union([nullable(string(), 'fallback'), string()])
    const nullUnion = union([literal(null as never), string()])

    expect(extractStorageFacts(defaultedUnion).nullable).toBe(true)
    expect(extractStorageFacts(nullUnion).nullable).toBe(true)
  })

  it('should combine SQL nullability across every intersection branch', () => {
    const nullableIntersection = intersect([
      nullable(string(), 'first'),
      nullable(string(), 'second'),
    ])

    expect(extractStorageFacts(nullableIntersection).nullable).toBe(true)
  })

  it('should require every intersection branch to allow SQL NULL', () => {
    const requiredIntersection = intersect([nullable(string()), string()])

    expect(extractStorageFacts(requiredIntersection).nullable).toBe(false)
  })

  it('should keep object variants non-nullable', () => {
    const objectVariant = variant('kind', [
      object({ kind: literal('text'), value: string() }),
      object({ kind: literal('count'), value: number() }),
    ])

    expect(extractStorageFacts(objectVariant).nullable).toBe(false)
  })
})

describe('extractStorageFacts composites', () => {
  it('should derive nullable storage branches without making null an insert omission', () => {
    const schema = union([
      union([nullSchema(), literal(null as never)]),
      pipe(string(), maxLength(12)),
    ])

    const analysis = extractStorageFacts(schema)

    expect(analysis).toMatchObject({
      outputKind: 'string',
      nullable: true,
      omitOnInsert: false,
    })

    expect(analysis.composite?.branches[0]?.nullOnly).toBe(true)
    expect(analysis.composite?.branches[1]?.stringConstraints.maxLength).toBe(12)
    expect(extractStorageFacts(nonNullable(schema)).nullable).toBe(false)
  })

  it('should require an outer wrapper for insert omission and retain its default', () => {
    const schema = union([optional(string(), 'fallback'), string()])
    expect(extractStorageFacts(schema)).toMatchObject({
      outputKind: 'string',
      allowsUndefined: true,
      omitOnInsert: false,
    })

    expect(extractStorageFacts(optional(schema, 'outer'))).toMatchObject({
      omitOnInsert: true,
      schemaDefault: { kind: 'value', value: 'outer' },
    })

    expect(safeParse(schema, undefined).output).toBe('fallback')
  })

  it('should clear nullability when a known conversion produces a non-null output', () => {
    const schema = pipe(union([string(), nullSchema()]), toString())
    expect(extractStorageFacts(schema)).toMatchObject({
      outputKind: 'string',
      nullable: false,
    })

    expect(safeParse(schema, null).output).toBe('null')
  })
})

describe('extractStorageFacts composites', () => {
  it('should retain nested variant and intersect output facts and clear them after conversion', () => {
    const choice = variant('kind', [
      object({ kind: literal('a'), value: string() }),
      variant('kind', [object({ kind: literal('b'), value: number() })]),
    ])

    const merged = intersect([object({ name: string() }), object({ age: number() })])

    expect(extractStorageFacts(choice).outputKind).toBe('json')
    expect(extractStorageFacts(merged).composite?.kind).toBe('intersection')

    expect(
      extractStorageFacts(pipe(union([string(), string()]), maxLength(20)))
        .stringConstraints.maxLength,
    ).toBe(20)

    expect(
      extractStorageFacts(pipe(union([string(), string()]), toNumber())).composite,
    ).toBeUndefined()

    expect(
      extractStorageFacts(pipe(union([string(), string()]), toNumber(), number()))
        .composite,
    ).toBeUndefined()
  })

  it('should leave mixed or unknown branch outputs unclassified', () => {
    expect(extractStorageFacts(union([string(), number()])).outputKind).toBeUndefined()

    expect(
      extractStorageFacts(union([string(), pipe(string(), transform(Number))]))
        .outputKind,
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
    expect(extractStorageFacts(schema)).toMatchObject({
      outputKind,
      nullable: nullableValue,
      omitOnInsert,
    })
  }
})

it('should combine constraints from repeated same-kind schemas', () => {
  expect(
    extractStorageFacts(pipe(number(), safeInteger(), number(), integer()))
      .numberConstraints,
  ).toEqual({ isInteger: true, isSafeInteger: true })

  expect(
    extractStorageFacts(
      pipe(
        number(),
        minValue(5),
        maxValue(10),
        pipe(number(), minValue(0), maxValue(20)),
      ),
    ).numberConstraints,
  ).toEqual({ minValue: 5, maxValue: 10 })

  expect(
    extractStorageFacts(
      pipe(
        bigint(),
        minValue(5n),
        maxValue(10n),
        pipe(bigint(), minValue(0n), maxValue(20n)),
      ),
    ).bigintConstraints,
  ).toEqual({ minValue: 5n, maxValue: 10n })

  expect(
    extractStorageFacts(
      pipe(
        string(),
        uuid(),
        minLength(30),
        maxLength(36),
        pipe(string(), minLength(1), maxLength(80)),
      ),
    ),
  ).toMatchObject({
    stringFormats: ['uuid'],
    stringConstraints: { minLength: 30, maxLength: 36 },
  })
})

it('should retain and narrow finite and composite proofs across same-kind schemas', () => {
  const safeUnion = pipe(
    union([pipe(number(), safeInteger()), pipe(number(), safeInteger())]),
    number(),
    integer(),
  )

  const finiteChoice = pipe(
    picklist([2147483648, 5] as number[]),
    number(),
    integer(),
    maxValue(10),
  )

  const compositeChoice = pipe(
    picklist([2147483648, 5] as number[]),
    union([number(), number()]),
    integer(),
    maxValue(10),
  )

  const narrowedComposite = pipe(
    union([literal<number>(2147483648), literal<number>(5)]),
    number(),
    integer(),
    maxValue(10),
  )

  expect(extractStorageFacts(safeUnion).numberConstraints).toEqual({
    isInteger: true,
    isSafeInteger: true,
  })

  expect(
    extractStorageFacts(safeUnion).composite?.branches.every(
      (branch) => branch.numberConstraints.isSafeInteger,
    ),
  ).toBe(true)

  expect(extractStorageFacts(finiteChoice).finiteEvidence).toBe('choice')

  expect(extractStorageFacts(finiteChoice).numberConstraints).toMatchObject({
    isInteger: true,
    maxValue: 10,
  })

  expect(extractStorageFacts(narrowedComposite).composite?.branches).toHaveLength(1)

  expect(extractStorageFacts(narrowedComposite).composite?.branches[0]).toMatchObject({
    finiteEvidence: 'singleton',
    singletonValue: 5,
  })

  expect(extractStorageFacts(compositeChoice).finiteValues).toEqual([5])
})

it('should retain narrowed enum values through later numeric schemas', () => {
  const schema = pipe(
    enumSchema({ large: 2147483648, small: 5 } as Record<string, number>),
    number(),
    integer(),
    maxValue(10),
  )

  expect(extractStorageFacts(schema).finiteValues).toEqual([5])
})

it('should remove bigint composite choices excluded by a later bound', () => {
  const schemas = [
    pipe(
      union([literal<bigint>(2n ** 64n), literal<bigint>(5n)]),
      bigint(),
      maxValue(10n),
    ),
    pipe(
      union([literal<bigint>(2n ** 64n), literal<bigint>(5n)]),
      pipe(bigint(), maxValue(10n)),
    ),
  ]

  for (const schema of schemas) {
    const analysis = extractStorageFacts(schema)
    expect(analysis.finiteValues).toEqual([5n])
    expect(analysis.composite?.branches).toHaveLength(1)
  }
})

it('should leave authored choice options mutable after analysis', () => {
  const schema = picklist([1, 2])
  const options = (schema as AnySchema & { options: unknown[] }).options

  extractStorageFacts(schema)

  expect(Object.isFrozen(options)).toBe(false)
})

it('should reset facts when a nested same-kind schema pipe transforms its input', () => {
  const nested = pipe(pipe(number(), safeInteger(), toNumber()), number())
  const analysis = extractStorageFacts(
    pipe(number(), integer(), safeInteger(), pipe(nested), integer()),
  )

  expect(analysis.outputKind).toBe('number')

  expect(analysis.numberConstraints).toEqual({ isInteger: true })
})

it('should not carry numeric bounds across a later schema default', () => {
  const schema = pipe(
    nullable(pipe(number(), integer(), minValue(0), maxValue(10))),
    pipe(nullable(number(), Number.MAX_SAFE_INTEGER)),
  )

  expect(safeParse(schema, null)).toMatchObject({
    success: true,
    output: Number.MAX_SAFE_INTEGER,
  })

  expect(extractStorageFacts(schema).numberConstraints).toEqual({})
})

it('should not carry numeric bounds across a fallback schema', () => {
  const schema = pipe(
    number(),
    integer(),
    minValue(0),
    maxValue(10),
    fallback(pipe(number(), minValue(20)), 100_000),
  )

  expect(safeParse(schema, 5)).toMatchObject({ success: true, output: 100_000 })
  expect(extractStorageFacts(schema).numberConstraints).toEqual({ minValue: 20 })
})

describe('extractStorageFacts ordered transformations', () => {
  it('should derive output kinds and retain only constraints on the current output', () => {
    expect(
      extractStorageFacts(
        pipe(string(), maxLength(10), toNumber(), minValue(0), maxValue(100)),
      ),
    ).toMatchObject({
      outputKind: 'number',
      stringConstraints: {},
      numberConstraints: { minValue: 0, maxValue: 100 },
    })

    expect(extractStorageFacts(pipe(string(), toBoolean())).outputKind).toBe('boolean')
    expect(extractStorageFacts(pipe(string(), parseBoolean())).outputKind).toBe('boolean')
    expect(extractStorageFacts(pipe(string(), toDate())).outputKind).toBe('date')
    expect(extractStorageFacts(pipe(number(), toString())).outputKind).toBe('string')
  })

  it('should leave unknown outputs unresolved until a supported schema restores them', () => {
    expect(extractStorageFacts(pipe(string(), parseJson())).outputKind).toBeUndefined()

    expect(
      extractStorageFacts(pipe(string(), transform(Number))).outputKind,
    ).toBeUndefined()

    expect(
      extractStorageFacts(pipe(string(), parseJson(), object({ value: number() })))
        .outputKind,
    ).toBe('json')
  })

  it('should retain output nullability restored by a later schema', () => {
    const analysis = extractStorageFacts(
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

it('should resolve nullable number output without allowing insert omission', () => {
  const analysis = extractStorageFacts(
    pipe(
      string(),
      transform((value): number | null => (value === 'null' ? null : Number(value))),
      nullable(number()),
    ),
  )

  expect(analysis).toMatchObject({
    outputKind: 'number',
    nullable: true,
    omitOnInsert: false,
    outputState: 'known',
  })
})

describe('extractStorageFacts recovered wrapper semantics', () => {
  it('should retain output undefined tolerance without making required input omittable', () => {
    const optionalSchema = pipe(
      pipe(
        string(),
        transform((value): number | undefined => (value ? undefined : 0)),
      ),
      optional(number()),
    )

    const analysis = extractStorageFacts(optionalSchema)

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

    const nonOptionalAnalysis = extractStorageFacts(nonOptionalSchema)

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

  expect(wrappers.map((schema) => extractStorageFacts(schema).outputKind)).toEqual(
    Array(8).fill('number'),
  )
})

it.each([
  [isoTime(), isoTimeSecond()],
  [isoDateTime(), isoDateTimeSecond()],
])(
  'should retain only the revalidated temporal reference output format',
  (minute, second) => {
    const Parent = defineTable(
      'temporal_parent',
      { value: pipe(string(), minute) },
      { primaryKey: 'value' },
    )

    const child = pipe(
      reference(Parent, 'value'),
      transform((value) => `${value}:00`),
      string(),
      second,
    )

    for (const schema of [
      child,
      nullable(child),
      pipe(nullable(child), nullable(string())),
    ]) {
      expect(extractStorageFacts(schema)).toMatchObject({
        outputKind: 'string',
        stringFormats: [second.type],
        outputState: 'known',
      })
    }
  },
)
