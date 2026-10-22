import {
  array,
  bigint,
  boolean,
  date,
  email,
  enum as enumSchema,
  exactOptional,
  length,
  maxLength,
  maxValue,
  minLength,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
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
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { analyzeSchema } from '@/index'

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
