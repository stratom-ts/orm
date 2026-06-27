import { length, maxLength, minLength, pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { getStringConstraints } from '@/schemas'

describe('getStringConstraints', () => {
  it('should return empty constraints for a plain string schema', () => {
    const schema = string()
    expect(getStringConstraints(schema)).toEqual({})
  })

  it('should extract minLength', () => {
    const schema = pipe(string(), minLength(3))
    expect(getStringConstraints(schema)).toEqual({ minLength: 3 })
  })

  it('should extract maxLength', () => {
    const schema = pipe(string(), maxLength(255))
    expect(getStringConstraints(schema)).toEqual({ maxLength: 255 })
  })

  it('should extract both minLength and maxLength', () => {
    const schema = pipe(string(), minLength(3), maxLength(100))
    expect(getStringConstraints(schema)).toEqual({
      minLength: 3,
      maxLength: 100,
    })
  })

  it('should extract length as both min and max', () => {
    const schema = pipe(string(), length(10))
    expect(getStringConstraints(schema)).toEqual({
      minLength: 10,
      maxLength: 10,
    })
  })
})
