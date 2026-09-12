import {
  array,
  bigint,
  boolean,
  date,
  enum as enumSchema,
  exactOptional,
  maxLength,
  maxValue,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  number,
  object,
  optional,
  picklist,
  pipe,
  string,
  undefinedable,
  union,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { analyzeSchema } from '@/index'

describe('analyzeSchema', () => {
  it('reports direct wrapper semantics and dialect-neutral output facts', () => {
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

  it('reduces nested wrappers inside-out and retains constraints below them', () => {
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

  it('only reports output kinds for homogeneous enum-like options', () => {
    expect(analyzeSchema(picklist(['a', 'b'])).outputKind).toBe('string')
    expect(analyzeSchema(enumSchema({ A: 'a', B: 'b' })).outputKind).toBe('string')
    expect(analyzeSchema(picklist(['a', 1])).outputKind).toBeUndefined()
    expect(analyzeSchema(enumSchema({ A: 'a', B: 1 })).outputKind).toBeUndefined()
  })

  it('reports every supported scalar and JSON-shaped output family', () => {
    expect(analyzeSchema(string()).outputKind).toBe('string')
    expect(analyzeSchema(number()).outputKind).toBe('number')
    expect(analyzeSchema(bigint()).outputKind).toBe('bigint')
    expect(analyzeSchema(boolean()).outputKind).toBe('boolean')
    expect(analyzeSchema(date()).outputKind).toBe('date')
    expect(analyzeSchema(object({ id: string() })).outputKind).toBe('json')
    expect(analyzeSchema(array(string())).outputKind).toBe('json')
  })

  it('leaves unsupported mixed-output schemas unclassified', () => {
    expect(analyzeSchema(union([string(), number()])).outputKind).toBeUndefined()
  })
})
