import { integer, maxValue, minValue, number, pipe, safeInteger } from 'valibot'
import { describe, expect, it } from 'vitest'

import { getNumberConstraints } from '@/index'

describe('getNumberConstraints', () => {
  it('should return empty constraints for a plain number schema', () => {
    const schema = number()
    expect(getNumberConstraints(schema)).toEqual({})
  })

  it('should extract minValue', () => {
    const schema = pipe(number(), minValue(10))
    expect(getNumberConstraints(schema)).toEqual({ minValue: 10 })
  })

  it('should extract maxValue', () => {
    const schema = pipe(number(), maxValue(100))
    expect(getNumberConstraints(schema)).toEqual({ maxValue: 100 })
  })

  it('should extract both minValue and maxValue', () => {
    const schema = pipe(number(), minValue(10), maxValue(100))
    expect(getNumberConstraints(schema)).toEqual({
      minValue: 10,
      maxValue: 100,
    })
  })

  it('should extract isInteger from integer action', () => {
    const schema = pipe(number(), integer())
    expect(getNumberConstraints(schema)).toEqual({ isInteger: true })
  })

  it('should extract isInteger from safeInteger action', () => {
    const schema = pipe(number(), safeInteger())
    expect(getNumberConstraints(schema)).toEqual({ isInteger: true })
  })

  it('should combine all constraints', () => {
    const schema = pipe(number(), minValue(1), maxValue(50), integer())
    expect(getNumberConstraints(schema)).toEqual({
      minValue: 1,
      maxValue: 50,
      isInteger: true,
    })
  })
})
