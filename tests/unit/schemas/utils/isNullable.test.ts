import {
  exactOptional,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  object,
  optional,
  pipe,
  string,
  title,
  undefinedable,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { isNullable } from '@/index'

describe('isNullable', () => {
  it('should return false for a plain string schema', () => {
    expect(isNullable(string())).toBe(false)
  })

  it('should return true for nullable wrapper', () => {
    expect(isNullable(nullable(string()))).toBe(true)
  })

  it('should return true for optional wrapper', () => {
    expect(isNullable(optional(string()))).toBe(true)
  })

  it('should return true for nullish wrapper', () => {
    expect(isNullable(nullish(string()))).toBe(true)
  })

  it('should follow exactOptional and undefinedable wrappers', () => {
    expect(isNullable(exactOptional(string()))).toBe(true)
    expect(isNullable(undefinedable(string()))).toBe(true)
  })

  it('should preserve only values accepted by final non-* wrappers', () => {
    expect(isNullable(nonOptional(nullable(optional(string()))))).toBe(true)
    expect(isNullable(nonNullable(nullable(optional(string()))))).toBe(true)
    expect(isNullable(nonNullish(nullable(optional(string()))))).toBe(false)
  })

  it('should return true when nullable is in a pipe', () => {
    const schema = pipe(string(), nullable(string()) as never)
    expect(isNullable(schema)).toBe(true)
  })

  it('should return true when optional is in a pipe', () => {
    const schema = pipe(string(), optional(string()) as never)
    expect(isNullable(schema)).toBe(true)
  })

  it('should return true when nullish is in a pipe', () => {
    const schema = pipe(string(), nullish(string()) as never)
    expect(isNullable(schema)).toBe(true)
  })

  it('should return false for object schema', () => {
    const schema = object({ name: string() })
    expect(isNullable(schema)).toBe(false)
  })

  it('should return false for string in a pipe without nullable actions', () => {
    const schema = pipe(string(), title('test'))
    expect(isNullable(schema)).toBe(false)
  })
})
