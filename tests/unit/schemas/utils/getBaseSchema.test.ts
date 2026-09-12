import {
  exactOptional,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  number,
  object,
  optional,
  pipe,
  string,
  title,
  undefinedable,
  union,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { getBaseSchema } from '@/index'

describe('getBaseSchema', () => {
  it('should return the schema itself for a plain schema', () => {
    const schema = string()
    expect(getBaseSchema(schema)).toBe(schema)
  })

  it('should unwrap optional wrapper', () => {
    const schema = string()
    const wrapped = optional(schema)
    expect(getBaseSchema(wrapped)).toBe(schema)
  })

  it('should unwrap nullable wrapper', () => {
    const schema = string()
    const wrapped = nullable(schema)
    expect(getBaseSchema(wrapped)).toBe(schema)
  })

  it('should unwrap nullish wrapper', () => {
    const schema = string()
    const wrapped = nullish(schema)
    expect(getBaseSchema(wrapped)).toBe(schema)
  })

  it('should unwrap nested wrappers', () => {
    const schema = string()
    const wrapped = optional(nullable(schema))
    expect(getBaseSchema(wrapped)).toBe(schema)
  })

  it('unwraps every supported presence and nullability wrapper family', () => {
    const base = string()

    expect(getBaseSchema(exactOptional(base))).toBe(base)
    expect(getBaseSchema(undefinedable(base))).toBe(base)
    expect(getBaseSchema(nonOptional(optional(base)))).toBe(base)
    expect(getBaseSchema(nonNullable(nullable(base)))).toBe(base)
    expect(getBaseSchema(nonNullish(nullish(base)))).toBe(base)
  })

  it('should extract base schema from a pipe', () => {
    const base = string()
    const schema = pipe(base, title('test'))
    expect(getBaseSchema(schema).type).toBe('string')
  })

  it('should return base schema for object schema', () => {
    const schema = object({ name: string() })
    expect(getBaseSchema(schema).type).toBe('object')
  })

  it('should handle number schema', () => {
    const schema = number()
    expect(getBaseSchema(schema).type).toBe('number')
  })

  it('returns an unsupported schema family unchanged instead of guessing a base', () => {
    const unsupported = union([string(), number()])

    expect(getBaseSchema(unsupported)).toBe(unsupported)
  })
})
