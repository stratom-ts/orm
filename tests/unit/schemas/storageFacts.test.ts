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
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
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
  toDate,
  toNumber,
  transform,
  tuple,
  undefinedable,
  union,
  unknown,
  uuid,
  variant,
} from 'valibot'
import { expect, it, vi } from 'vitest'

import { extractStorageFacts } from '@/internal/valibot/storageFacts'
import { column } from '@/schemas'
import type { AnySchema } from '@/types/schema'

it('describes primitive families and their independent storage constraints', () => {
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

it('retains singleton versus choice evidence after later validation', () => {
  expect(extractStorageFacts(pipe(literal(2) as AnySchema, number()))).toMatchObject({
    finiteEvidence: 'singleton',
    finiteValues: [2],
    outputKind: 'number',
  })

  expect(
    extractStorageFacts(pipe(pipe(picklist([1, 2]), minValue(2)) as AnySchema, number())),
  ).toMatchObject({
    finiteEvidence: 'choice',
    finiteValues: [2],
    outputKind: 'number',
  })

  expect(extractStorageFacts(picklist(['one', 2]))).toMatchObject({
    outputKind: undefined,
    finiteEvidence: 'choice',
    finiteValues: ['one', 2],
  })
})

it('projects alternatives recursively without losing branch-specific bounds', () => {
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

it('distinguishes JSON shapes and outputs that lose identity through JSON', () => {
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

it('separates unconstrained output from unresolved transformations and known conversions', () => {
  for (const schema of [unknown(), any()])
    expect(extractStorageFacts(schema)).toMatchObject({
      outputKind: undefined,
      outputState: 'unconstrained',
    })

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

it('keeps SQL nullability, undefined output, and insert omission distinct', () => {
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

it('describes absent, null, value and factory defaults without executing user code', () => {
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
