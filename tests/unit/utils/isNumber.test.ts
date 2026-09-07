import { describe, expect, it } from 'vitest'

import { isNumber } from '@/index'

describe('isNumber', () => {
  it('should return true for a number', () => {
    expect(isNumber(42)).toBe(true)
  })

  it('should return true for zero', () => {
    expect(isNumber(0)).toBe(true)
  })

  it('should return true for negative numbers', () => {
    expect(isNumber(-1)).toBe(true)
  })

  it('should return true for floating point numbers', () => {
    expect(isNumber(3.14)).toBe(true)
  })

  it('should return false for a string', () => {
    expect(isNumber('42')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isNumber(null)).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(isNumber(undefined)).toBe(false)
  })

  it('should return false for an object', () => {
    expect(isNumber({})).toBe(false)
  })

  it('should return false for a boolean', () => {
    expect(isNumber(true)).toBe(false)
  })
})
