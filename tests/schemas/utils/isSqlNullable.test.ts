import { nullable, nullish, optional, pipe, string, title } from 'valibot'
import { describe, expect, it } from 'vitest'

import { isSqlNullable } from '@/schemas'

describe('isSqlNullable', () => {
  it('is false for plain and optional-only schemas', () => {
    expect(isSqlNullable(string())).toBe(false)
    expect(isSqlNullable(optional(string()))).toBe(false)
    expect(isSqlNullable(pipe(string(), title('x')))).toBe(false)
  })

  it('is true for nullable and nullish', () => {
    expect(isSqlNullable(nullable(string()))).toBe(true)
    expect(isSqlNullable(nullish(string()))).toBe(true)
  })
})
