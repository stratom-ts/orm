import {
  any,
  array,
  bigint,
  boolean,
  date,
  exactOptional,
  fallback,
  integer,
  intersect,
  length,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  normalize,
  null as nullSchema,
  nullable,
  nullish,
  number,
  object,
  optional,
  picklist,
  pipe,
  safeInteger,
  string,
  toBigint,
  toDate,
  toLowerCase,
  toMaxValue,
  toMinValue,
  toNumber,
  toUpperCase,
  transform,
  trim,
  trimEnd,
  trimStart,
  tuple,
  undefinedable,
  union,
  unknown,
  uuid,
  variant,
} from 'valibot'
import { expect, it, vi } from 'vitest'

import { column } from '@/schemas'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { AnySchema } from '@/types/schema'

it('should describe primitive families and their independent storage constraints', () => {
  expect(
    extractStorageFacts(pipe(string(), minLength(2), maxLength(12), uuid())),
  ).toMatchObject({
    outputKind: 'string',
    outputState: 'known',
    stringConstraints: { minLength: 2, maxLength: 12 },
    stringFormats: ['uuid'],
  })

  expect(
    extractStorageFacts(
      pipe(number(), integer(), safeInteger(), minValue(-5), maxValue(10)),
    ),
  ).toMatchObject({
    outputKind: 'number',
    numberConstraints: {
      isInteger: true,
      isSafeInteger: true,
      minValue: -5,
      maxValue: 10,
    },
  })

  expect(
    extractStorageFacts(pipe(bigint(), minValue(-(2n ** 63n)), maxValue(2n ** 63n - 1n))),
  ).toMatchObject({
    outputKind: 'bigint',
    bigintConstraints: { minValue: -(2n ** 63n), maxValue: 2n ** 63n - 1n },
  })

  expect(extractStorageFacts(boolean()).outputKind).toBe('boolean')
  expect(extractStorageFacts(date()).outputKind).toBe('date')
})

it('should retain singleton versus choice evidence after later validation', () => {
  expect(extractStorageFacts(pipe(literal(2) as AnySchema, number()))).toMatchObject({
    finiteEvidence: 'singleton',
    singletonValue: 2,
    finiteValues: [2],
    outputKind: 'number',
  })

  expect(extractStorageFacts(pipe(literal(1), minValue(2 as 1)))).toMatchObject({
    finiteEvidence: 'singleton',
    singletonValue: 1,
    finiteValues: [],
  })

  expect(
    extractStorageFacts(pipe(pipe(picklist([1, 2]), minValue(2)) as AnySchema, number())),
  ).toMatchObject({
    finiteEvidence: 'choice',
    finiteValues: [2],
    finiteSourceValues: [1, 2],
    outputKind: 'number',
  })

  expect(
    extractStorageFacts(
      pipe(picklist([2147483648, Number.MAX_SAFE_INTEGER + 1]), maxValue(2147483648)),
    ),
  ).toMatchObject({
    finiteEvidence: 'choice',
    finiteValues: [2147483648],
    finiteSourceValues: [2147483648, Number.MAX_SAFE_INTEGER + 1],
  })

  expect(extractStorageFacts(picklist(['one', 2]))).toMatchObject({
    outputKind: undefined,
    finiteEvidence: 'choice',
    finiteValues: ['one', 2],
  })

  // @ts-expect-error Deliberately contradictory literal constraint tests preserved evidence.
  expect(extractStorageFacts(pipe(literal(1), minValue(2)))).toMatchObject({
    finiteEvidence: 'singleton',
    inputSingleton: true,
    singletonValue: 1,
    finiteValues: [],
  })

  expect(extractStorageFacts(pipe(literal('1'), toNumber()))).toMatchObject({
    inputSingleton: true,
    finiteEvidence: undefined,
    outputKind: 'number',
  })
})

it('should retain base JSON shape for default compatibility independently of output shape', () => {
  expect(extractStorageFacts(array(string()))).toMatchObject({
    jsonShape: 'array',
    defaultJsonShape: 'array',
  })

  expect(extractStorageFacts(object({ name: string() }))).toMatchObject({
    jsonShape: 'object',
    defaultJsonShape: 'object',
  })
})

it('should project alternatives recursively without losing branch-specific bounds', () => {
  const facts = extractStorageFacts(
    union([literal(3), pipe(number(), minValue(10)), nullSchema()]),
  )

  expect(facts).toMatchObject({
    nullable: true,
    outputKind: 'number',
    composite: {
      kind: 'alternatives',
      branches: [
        { outputKind: 'number', finiteEvidence: 'singleton', finiteValues: [3] },
        { outputKind: 'number', numberConstraints: { minValue: 10 } },
        { nullOnly: true },
      ],
    },
  })

  expect(
    extractStorageFacts(intersect([object({ a: string() }), object({ b: number() })])),
  ).toMatchObject({
    outputKind: 'json',
    jsonShape: 'object',
    composite: { kind: 'intersection' },
  })

  expect(
    extractStorageFacts(
      variant('type', [object({ type: literal('a') }), object({ type: literal('b') })]),
    ),
  ).toMatchObject({
    outputKind: 'json',
    jsonShape: 'object',
    composite: { kind: 'alternatives' },
  })
})

it('should distinguish JSON shapes and outputs that lose identity through JSON', () => {
  expect(extractStorageFacts(object({ id: string() }))).toMatchObject({
    jsonShape: 'object',
    jsonOutputCompatible: true,
  })

  expect(extractStorageFacts(array(string()))).toMatchObject({
    jsonShape: 'array',
    jsonOutputCompatible: true,
  })

  expect(extractStorageFacts(tuple([string(), number()]))).toMatchObject({
    jsonShape: 'array',
    jsonOutputCompatible: true,
  })

  expect(extractStorageFacts(union([object({}), array(string())]))).toMatchObject({
    jsonShape: 'mixed',
    jsonOutputCompatible: true,
  })

  expect(extractStorageFacts(object({ at: date() }))).toMatchObject({
    jsonShape: 'object',
    jsonOutputCompatible: false,
  })

  expect(
    extractStorageFacts(
      pipe(
        string(),
        transform(() => ({})),
        array(string()),
      ),
    ),
  ).toMatchObject({ jsonShape: 'array', outputState: 'known' })
})

it('should separate unconstrained output from unresolved transformations and known conversions', () => {
  for (const schema of [unknown(), any()]) {
    expect(extractStorageFacts(schema)).toMatchObject({
      outputKind: undefined,
      outputState: 'unconstrained',
    })
  }

  expect(
    extractStorageFacts(
      pipe(
        string(),
        transform((value) => value.length),
      ),
    ),
  ).toMatchObject({
    outputKind: undefined,
    outputState: 'unresolved',
    finiteEvidence: undefined,
    jsonShape: undefined,
  })

  expect(extractStorageFacts(pipe(literal('1'), toNumber()))).toMatchObject({
    outputKind: 'number',
    outputState: 'known',
    finiteEvidence: undefined,
    finiteValues: undefined,
  })

  expect(extractStorageFacts(pipe(string(), toDate()))).toMatchObject({
    outputKind: 'date',
    outputState: 'known',
    jsonOutputCompatible: false,
  })

  expect(extractStorageFacts(pipe(string(), transform(Number), number()))).toMatchObject({
    outputKind: 'number',
    outputState: 'known',
  })
})

it('should keep SQL nullability, undefined output, and insert omission distinct', () => {
  expect(extractStorageFacts(nullable(string()))).toMatchObject({
    nullable: true,
    allowsUndefined: false,
    outputMayBeUndefined: false,
    omitOnInsert: false,
  })

  expect(extractStorageFacts(optional(string()))).toMatchObject({
    nullable: false,
    allowsUndefined: true,
    outputMayBeUndefined: true,
    omitOnInsert: true,
  })

  expect(extractStorageFacts(undefinedable(string()))).toMatchObject({
    nullable: false,
    allowsUndefined: true,
    outputMayBeUndefined: true,
    omitOnInsert: false,
  })

  expect(extractStorageFacts(exactOptional(string()))).toMatchObject({
    omitOnInsert: true,
  })

  expect(extractStorageFacts(nullish(string()))).toMatchObject({
    nullable: true,
    allowsUndefined: true,
    outputMayBeUndefined: true,
    omitOnInsert: true,
  })

  expect(extractStorageFacts(optional(string(), 'default'))).toMatchObject({
    allowsUndefined: true,
    outputMayBeUndefined: false,
    omitOnInsert: true,
  })

  expect(extractStorageFacts(nullSchema())).toMatchObject({
    nullOnly: true,
    nullable: true,
    outputState: 'known',
  })
})

it('should describe absent, null, value and factory defaults without executing user code', () => {
  const defaultFactory = vi.fn<() => string>(() => 'default')
  const fallbackFactory = vi.fn<() => string>(() => 'fallback')
  const transformation = vi.fn<(value: string) => string>((value) => value)
  const mapping = vi.fn<(value: unknown) => unknown>((value) => value)
  expect(extractStorageFacts(string()).schemaDefault).toEqual({ kind: 'absent' })

  expect(extractStorageFacts(nullable(string(), null)).schemaDefault).toEqual({
    kind: 'value',
    value: null,
  })

  expect(extractStorageFacts(optional(string(), 'value')).schemaDefault).toEqual({
    kind: 'value',
    value: 'value',
  })

  expect(extractStorageFacts(optional(string(), defaultFactory)).schemaDefault).toEqual({
    kind: 'factory',
  })

  extractStorageFacts(
    pipe(
      fallback(optional(string(), defaultFactory), fallbackFactory),
      transform(transformation),
      column({ mapParam: mapping, mapResult: mapping }),
    ),
  )

  expect(defaultFactory).not.toHaveBeenCalled()
  expect(fallbackFactory).not.toHaveBeenCalled()
  expect(transformation).not.toHaveBeenCalled()
  expect(mapping).not.toHaveBeenCalled()
})

it('should recognize trim output and apply constraints after normalization', () => {
  expect(
    extractStorageFacts(pipe(string(), trim(), minLength(1), maxLength(200))),
  ).toMatchObject({
    outputKind: 'string',
    outputState: 'known',
    nullable: false,
    outputMayBeUndefined: false,
    stringConstraints: { minLength: 1, maxLength: 200 },
  })

  expect(
    extractStorageFacts(pipe(string(), minLength(10), maxLength(20), trim()))
      .stringConstraints,
  ).toEqual({ maxLength: 20 })

  expect(
    extractStorageFacts(pipe(string(), length(10), trim())).stringConstraints,
  ).toEqual({ maxLength: 10 })

  expect(
    extractStorageFacts(pipe(string(), minLength(10), trim(), minLength(1)))
      .stringConstraints,
  ).toEqual({ minLength: 1 })
})

it('should discard finite and format facts that trimming can change', () => {
  for (const schema of [
    pipe(literal<string>(' padded '), trim()),
    pipe(picklist([' a ', ' b '] as string[]), trim()),
    pipe(string(), uuid(), trim()),
  ]) {
    expect(extractStorageFacts(schema)).toMatchObject({
      outputKind: 'string',
      outputState: 'known',
      finiteEvidence: undefined,
      finiteValues: undefined,
      singletonValue: undefined,
      stringFormats: [],
    })
  }
})

it('should preserve wrappers and defaults surrounding trimmed titles', () => {
  const title = pipe(string(), trim(), minLength(1), maxLength(200))
  expect(extractStorageFacts(nullable(title))).toMatchObject({
    outputKind: 'string',
    nullable: true,
    outputMayBeUndefined: false,
  })

  expect(extractStorageFacts(optional(title, '  Default title  '))).toMatchObject({
    outputKind: 'string',
    omitOnInsert: true,
    allowsUndefined: true,
    outputMayBeUndefined: false,
    schemaDefault: { kind: 'value', value: '  Default title  ' },
  })

  expect(
    extractStorageFacts(
      pipe(
        title,
        transform((value) => value),
      ),
    ),
  ).toMatchObject({
    outputKind: undefined,
    outputState: 'unresolved',
    stringConstraints: {},
  })
})

it('should recognize string normalization output and retain only safe length facts', () => {
  for (const action of [trimStart(), trimEnd()]) {
    expect(extractStorageFacts(pipe(string(), maxLength(20), action))).toMatchObject({
      outputKind: 'string',
      stringConstraints: { maxLength: 20 },
    })
  }

  for (const action of [toLowerCase(), toUpperCase(), normalize(), normalize('NFKC')]) {
    expect(
      extractStorageFacts(pipe(string(), maxLength(20), uuid(), action)),
    ).toMatchObject({
      outputKind: 'string',
      stringConstraints: {},
      stringFormats: [],
      finiteEvidence: undefined,
    })
  }
})

it('should track numeric clamp bounds without stale finite or integer evidence', () => {
  expect(
    extractStorageFacts(
      pipe(number(), integer(), minValue(-10), maxValue(50), toMinValue(0)),
    ),
  ).toMatchObject({
    outputKind: 'number',
    numberConstraints: { minValue: 0, maxValue: 50, isInteger: true },
    finiteEvidence: undefined,
  })

  expect(
    extractStorageFacts(pipe(number(), integer(), toMaxValue(2.5))).numberConstraints,
  ).toEqual({ maxValue: 2.5 })

  expect(
    extractStorageFacts(
      pipe(number(), safeInteger(), toMaxValue(Number.MAX_SAFE_INTEGER + 1)),
    ).numberConstraints,
  ).toMatchObject({ isInteger: true, maxValue: Number.MAX_SAFE_INTEGER + 1 })

  expect(
    extractStorageFacts(pipe(number(), integer(), toMinValue(Number.POSITIVE_INFINITY)))
      .numberConstraints,
  ).toMatchObject({ minValue: Number.POSITIVE_INFINITY })

  expect(
    extractStorageFacts(pipe(number(), integer(), toMinValue(Number.POSITIVE_INFINITY)))
      .numberConstraints.isInteger,
  ).toBeUndefined()

  expect(
    extractStorageFacts(pipe(number(), minValue(10), toMaxValue(5))).numberConstraints,
  ).toEqual({ minValue: 5, maxValue: 5 })

  expect(
    extractStorageFacts(pipe(number(), maxValue(-10), toMinValue(5))).numberConstraints,
  ).toEqual({ minValue: 5, maxValue: 5 })

  expect(
    extractStorageFacts(pipe(number(), minValue(1), maxValue(4), toMinValue(Number.NaN))),
  ).toMatchObject({ numberConstraints: { minValue: 1, maxValue: 4 } })

  for (const schema of [
    pipe(picklist([1, 2] as number[]), toMinValue(0)),
    pipe(picklist([1, 2] as number[]), toMaxValue(1)),
  ]) {
    expect(extractStorageFacts(schema)).toMatchObject({
      finiteEvidence: undefined,
      finiteValues: undefined,
      singletonValue: undefined,
    })
  }
})

it('should track bigint clamps and conversion output', () => {
  expect(
    extractStorageFacts(pipe(bigint(), minValue(-20n), maxValue(20n), toMinValue(0n))),
  ).toMatchObject({
    outputKind: 'bigint',
    bigintConstraints: { minValue: 0n, maxValue: 20n },
  })

  expect(
    extractStorageFacts(pipe(bigint(), minValue(10n), toMaxValue(5n))).bigintConstraints,
  ).toEqual({ minValue: 5n, maxValue: 5n })

  expect(extractStorageFacts(pipe(string(), toBigint()))).toMatchObject({
    outputKind: 'bigint',
    outputState: 'known',
  })

  expect(
    extractStorageFacts(pipe(string(), maxLength(1), toMinValue('zz'))),
  ).toMatchObject({
    outputKind: undefined,
    outputState: 'unresolved',
    stringConstraints: {},
  })
})
