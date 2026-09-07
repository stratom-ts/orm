import { describe, expect, it } from 'vitest'

import { isTruthyFlag } from '@/index'

describe('isTruthyFlag', () => {
  it('should return true for true', () => {
    expect(isTruthyFlag(true)).toBe(true)
  })

  it('should return false for false', () => {
    expect(isTruthyFlag(false)).toBe(false)
  })

  it('should return true for non-zero numbers', () => {
    expect(isTruthyFlag(1)).toBe(true)
    expect(isTruthyFlag(-1)).toBe(true)
    expect(isTruthyFlag(42)).toBe(true)
  })

  it('should return false for zero', () => {
    expect(isTruthyFlag(0)).toBe(false)
  })

  it('should return false for NaN', () => {
    expect(isTruthyFlag(NaN)).toBe(false)
  })

  it('should return false for Infinity', () => {
    expect(isTruthyFlag(Infinity)).toBe(false)
  })

  it('should return true for truthy strings', () => {
    expect(isTruthyFlag('yes')).toBe(true)
    expect(isTruthyFlag('YES')).toBe(true)
    expect(isTruthyFlag('true')).toBe(true)
    expect(isTruthyFlag('TRUE')).toBe(true)
    expect(isTruthyFlag('t')).toBe(true)
    expect(isTruthyFlag('T')).toBe(true)
    expect(isTruthyFlag('1')).toBe(true)
  })

  it('should return false for falsy strings', () => {
    expect(isTruthyFlag('no')).toBe(false)
    expect(isTruthyFlag('false')).toBe(false)
    expect(isTruthyFlag('0')).toBe(false)
    expect(isTruthyFlag('')).toBe(false)
  })

  it('should return false for null', () => {
    expect(isTruthyFlag(null)).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(isTruthyFlag(undefined)).toBe(false)
  })

  it('should return false for objects', () => {
    expect(isTruthyFlag({})).toBe(false)
  })
})
