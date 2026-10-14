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

/** Builds nested diagnostics to verify the serializer's native Error traversal. */
function nestedErrorJson(): Record<string, unknown> {
  const native = new Error('constraint failed')
  Object.defineProperty(native, 'code', { value: '23505', enumerable: false })
  const driver = driverError(
    native,
    'postgres',
    'insert into records values ($1)',
    () => ({ kind: 'uniqueViolation', retryable: false }),
  )

  const shared = { note: 'same object' }
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const custom = new (class {
    readonly error = new Error('custom class failure')
  })()

  const migration = new MigrationError({
    message: 'Migration DDL failed',
    cause: driver,
    cleanupFailures: [
      { stage: 'rollback', cause: shared },
      { stage: 'unlock', cause: shared },
    ],
  })

  Object.assign(migration, {
    circular,
    details: {
      date: new Date('2026-01-02T00:00:00.000Z'),
      stack: 'structured stack data',
      custom,
      json: { toJSON: () => ({ rendered: 'custom JSON' }) },
    },
  })

  return JSON.parse(JSON.stringify(migration)) as Record<string, unknown>
}

/** Asserts the recursively serialized migration and driver diagnostics. */
function expectNestedErrorJson(json: Record<string, unknown>): void {
  expect(json).toMatchObject({
    _tag: 'MigrationError',
    message: 'Migration DDL failed',
    cause: {
      _tag: 'DriverError',
      message: 'postgres database session SQL execution failed',
      code: '23505',
      cause: { message: 'constraint failed', code: '23505' },
    },
    cleanupFailures: [
      { cause: { note: 'same object' } },
      { cause: { note: 'same object' } },
    ],
    circular: { self: '[Circular]' },
    details: {
      date: '2026-01-02T00:00:00.000Z',
      stack: 'structured stack data',
      custom: { error: { message: 'custom class failure' } },
      json: { rendered: 'custom JSON' },
    },
  })
}

/** Builds arbitrary diagnostics, including hostile getters and custom serializers. */
function arbitraryErrorJson(): readonly [
  Record<string, unknown>,
  Record<string, unknown>,
] {
  const nested = { reason: 'underlying cause' }
  const native = new Error('', { cause: nested })
  Object.defineProperty(native, 'message', {
    get: () => {
      throw new Error('message getter failed')
    },
  })

  const wrapper = new QueryError({ message: 'Query failed', cause: native })
  Object.assign(wrapper, {
    same: {
      value: 'same-instance JSON',
      toJSON() {
        return this
      },
    },
    throwing: {
      inner: new Error('fallback diagnostic'),
      toJSON() {
        throw new Error('custom serialization failed')
      },
    },
  })

  const bigInt = new MigrationError({ message: 'Migration failed', cause: 123n })
  return [
    JSON.parse(JSON.stringify(wrapper)) as Record<string, unknown>,
    JSON.parse(JSON.stringify(bigInt)) as Record<string, unknown>,
  ]
}

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

  it('uses native non-enumerable message and cause fields', () => {
    const cause = new Error('driver rejected the write')
    const error = new MigrationError({ message: 'Migration DDL failed', cause })

    expect(Object.getOwnPropertyDescriptor(error, 'message')?.enumerable).toBe(false)
    expect(Object.getOwnPropertyDescriptor(error, 'cause')?.enumerable).toBe(false)
    expect(error.stack).toMatch(/^MigrationError: Migration DDL failed/)
  })
})

describe('TaggedError serialization', () => {
  it('serializes nested driver diagnostics, shared causes, and cycles', () => {
    expect.assertions(1)
    expectNestedErrorJson(nestedErrorJson())
  })

  it('serializes arbitrary causes without mistaking access failures for cycles', () => {
    const [wrapper, bigInt] = arbitraryErrorJson()

    expect(wrapper).toMatchObject({
      _tag: 'QueryError',
      message: 'Query failed',
      cause: { name: 'Error', cause: { reason: 'underlying cause' } },
      same: { value: 'same-instance JSON' },
      throwing: { inner: { message: 'fallback diagnostic' } },
    })

    expect(bigInt).toMatchObject({
      _tag: 'MigrationError',
      cause: '123n',
    })
  })

  it('serializes non-enumerable diagnostics on class-valued causes and cycles', () => {
    class Diagnostic {
      readonly cause = new Error('nested class failure')
      readonly self = this

      constructor() {
        Object.defineProperties(this, {
          message: { value: 'class failure' },
          code: { value: 'ECLASS' },
        })
      }
    }

    const cause = new Diagnostic()
    const wrapper = new QueryError({ message: 'Query failed', cause })

    expect(JSON.parse(JSON.stringify(wrapper))).toMatchObject({
      cause: {
        message: 'class failure',
        code: 'ECLASS',
        cause: { message: 'nested class failure' },
        self: '[Circular]',
      },
    })
  })
})

describe('TaggedError serialization with special property names', () => {
  it('preserves own __proto__ diagnostics without changing the output prototype', () => {
    const cause = JSON.parse(
      '{"__proto__":{"reason":"structured detail"},"code":"E"}',
    ) as Record<string, unknown>

    const wrapper = new QueryError({ message: 'Query failed', cause })
    const json = JSON.parse(JSON.stringify(wrapper)) as {
      cause: Record<string, unknown>
    }

    expect(Object.getPrototypeOf(json.cause)).toBe(Object.prototype)
    expect(Object.hasOwn(json.cause, '__proto__')).toBe(true)
    expect(json.cause['__proto__']).toEqual({ reason: 'structured detail' })
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
    expect(error.message).toBe('sqlite database session SQL execution failed')
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
  it('derives its message from required structured issues', () => {
    const error = new ValidationError({
      table: 'users',
      operation: 'insert',
      issues: [
        {
          kind: 'schema',
          type: 'string',
          input: 1,
          expected: 'string',
          received: '1',
          message: 'expected string',
        },
      ],
    })

    expect(error).toBeInstanceOf(Error)
    expect(error._tag).toBe('ValidationError')
    expect(error.table).toBe('users')
    expect(error.operation).toBe('insert')
    expect(error.message).toBe('Invalid insert into "users": expected string')
    expect(error.issues[0].message).toBe('expected string')
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
