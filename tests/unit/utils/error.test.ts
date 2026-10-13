import { describe, expect, it } from 'vitest'

import {
  DriverError,
  InvariantError,
  MigrationError,
  QueryError,
  SchemaError,
  TaggedError,
  ValidationError,
  catchTag,
  catchTags,
} from '@/index'
import { driverError } from '@/utils/error'

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

describe('SchemaError', () => {
  it('should be a TaggedError with tag SchemaError', () => {
    const error = new SchemaError({ message: 'invalid metadata' })
    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('SchemaError')
    expect(error.message).toBe('invalid metadata')
  })
})

describe('QueryError', () => {
  it('should be a TaggedError with tag QueryError', () => {
    const error = new QueryError({ message: 'closed' })
    expect(error._tag).toBe('QueryError')
    expect(error.message).toBe('closed')
  })
})

describe('DriverError', () => {
  const classifyUnknown = () => ({ kind: 'unknown' as const, retryable: false })

  it('keeps an object whose diagnostic getters throw as the cause', () => {
    const cause = Object.defineProperties(
      {},
      {
        message: {
          get: () => {
            throw new Error('message getter failed')
          },
        },
        code: {
          get: () => {
            throw new Error('code getter failed')
          },
        },
      },
    )

    const error = driverError(cause, 'sqlite', 'select 1', classifyUnknown)

    expect(error.cause).toBe(cause)
    expect(error.message).toBe('Database operation failed')
    expect(error.code).toBeUndefined()
  })

  it.each([
    {
      cause: Object.assign(new Error('duplicate value'), { code: '23505' }),
      code: '23505',
    },
    { cause: { code: 'SQLITE_CONSTRAINT_UNIQUE' }, code: 'SQLITE_CONSTRAINT_UNIQUE' },
    { cause: null, code: undefined },
    { cause: undefined, code: undefined },
    { cause: 0, code: undefined },
  ])(
    'retains thrown value %# and exposes only native code and SQL text',
    ({ cause, code }) => {
      const sql = 'insert into records (value) values ($1)'
      const error = driverError(cause, 'selected-dialect', sql, classifyUnknown)

      expect(error).toBeInstanceOf(DriverError)

      expect(error).toMatchObject({
        _tag: 'DriverError',
        dialect: 'selected-dialect',
        sql,
      })

      expect(error.cause).toBe(cause)
      expect(error.code).toBe(code)
      expect(error).not.toHaveProperty('params')
    },
  )
})

describe('ValidationError', () => {
  it('should be a TaggedError with tag ValidationError', () => {
    const error = new ValidationError({
      message: 'bad insert',
      issues: [{ message: 'required' }],
    })

    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('ValidationError')
    expect(error.message).toBe('bad insert')
    expect(error.issues).toEqual([{ message: 'required' }])
  })
})

describe('InvariantError', () => {
  it('should be a TaggedError with tag InvariantError', () => {
    const error = new InvariantError('internal contract failed')
    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('InvariantError')
    expect(error.message).toBe('internal contract failed')
  })
})

describe('catchTag', () => {
  it('should catch a tagged error and return the callback result', () => {
    const error = new MigrationError({ message: 'fail' })
    const result = catchTag(error, 'MigrationError', (e) => `caught: ${e.message}`)
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
    const result = catchTag(value, 'MigrationError', (e) => `caught: ${e.message}`)
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
      /**
       * Handles the tagged migration-error branch and exposes its message to the
       * assertion.
       */
      MigrationError: (e: MyError) => `handled: ${e.message}`,
    } as never)

    expect(result).toBe('handled: custom error')
  })

  it('should pass through a non-matching error', () => {
    const error = new Error('generic')
    const result = catchTags(error, {
      /** Handles the custom tagged-error branch for dispatch checks. */
      MyError: () => 'handled',
    } as never)

    expect(result).toBe(error)
  })

  it('should pass through a non-error value', () => {
    const result = catchTags('hello', {
      /** Handles the custom tagged-error branch for dispatch checks. */
      MyError: () => 'handled',
    } as never)

    expect(result).toBe('hello')
  })
})
