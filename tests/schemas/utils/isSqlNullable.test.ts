import { nullable, nullish, optional, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import { isSqlNullable } from '@/index'

describe('isSqlNullable', () => {
  it('should return false for plain and optional-only schemas', () => {
    expect(isSqlNullable(string())).toBe(false)
    expect(isSqlNullable(optional(string()))).toBe(false)
    expect(isSqlNullable(pipe(string(), title('x')))).toBe(false)
  })

  it('should return true for nullable and nullish', () => {
    expect(isSqlNullable(nullable(string()))).toBe(true)
    expect(isSqlNullable(nullish(string()))).toBe(true)
  })

  it('should return true for optional wrapping nullable', () => {
    expect(isSqlNullable(optional(nullable(string())))).toBe(true)
    expect(isSqlNullable(optional(nullish(string())))).toBe(true)
  })
})
