import { describe, expect, it } from 'vitest'

import { catchTag, catchTags, MigrationError, TaggedError } from '@/utils'

describe('TaggedError', () => {
  it('should create a tagged error class with the given tag', () => {
    const MyError = TaggedError('MyError')<{ message: string }>
    const error = new MyError({ message: 'something went wrong' })
    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('MyError')
    expect(error.message).toBe('something went wrong')
  })

  it('should set the error name to the tag', () => {
    const MyError = TaggedError('CustomError')<{ code: number }>
    const error = new MyError({ code: 42 })
    expect(error.name).toBe('CustomError')
  })

  it('should support errors without extra args', () => {
    const SimpleError = TaggedError('SimpleError')<Record<string, unknown>>
    const error = new SimpleError()
    expect(error._tag).toBe('SimpleError')
  })
})

describe('MigrationError', () => {
  it('should be a TaggedError with tag MigrationError', () => {
    const error = new MigrationError({ message: 'migration failed' })
    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('MigrationError')
    expect(error.message).toBe('migration failed')
  })
})

describe('catchTag', () => {
  it('should catch a tagged error and return the callback result', () => {
    const error = new MigrationError({ message: 'fail' })
    const result = catchTag(
      error,
      'MigrationError',
      (e) => `caught: ${e.message}`,
    )
    expect(result).toBe('caught: fail')
  })

  it('should pass through a non-matching error', () => {
    const error = new Error('generic')
    const result = catchTag(error, 'MigrationError' as never, () => 'caught')
    expect(result).toBe(error)
  })

  it('should pass through a non-error value', () => {
    const result = catchTag('hello', 'MigrationError' as never, () => 'caught')
    expect(result).toBe('hello')
  })

  it('should pass through a matching tag on non-Error objects', () => {
    const value = { _tag: 'MigrationError' as const, message: 'test' }
    const result = catchTag(
      value,
      'MigrationError',
      (e) => `caught: ${e.message}`,
    )
    expect(result).toBe(value)
  })
})

describe('catchTags', () => {
  it('should catch an error matching one of the handlers', () => {
    class MyError extends TaggedError('MigrationError')<{
      message: string
    }> {}
    const error = new MyError({ message: 'custom error' })
    const result = catchTags(error, {
      MigrationError: (e: MyError) => `handled: ${e.message}`,
    } as never)
    expect(result).toBe('handled: custom error')
  })

  it('should pass through a non-matching error', () => {
    const error = new Error('generic')
    const result = catchTags(error, {
      MyError: () => 'handled',
    } as never)
    expect(result).toBe(error)
  })

  it('should pass through a non-error value', () => {
    const result = catchTags('hello', {
      MyError: () => 'handled',
    } as never)
    expect(result).toBe('hello')
  })
})
