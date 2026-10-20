import { describe, expect, it } from 'vitest'

import { postgresClassifyDriverError } from '@/dialects/postgres/classifyDriverError'
import { sqliteClassifyDriverError } from '@/dialects/sqlite/classifyDriverError'

describe('PostgreSQL native failure classification', () => {
  it.each([
    ['23505', 'uniqueViolation', false],
    ['23503', 'foreignKeyViolation', false],
    ['23502', 'notNullViolation', false],
    ['23514', 'checkViolation', false],
    ['40P01', 'transient', true],
    ['40001', 'transient', true],
    ['08000', 'transient', true],
    ['08001', 'transient', true],
    ['08003', 'transient', true],
    ['08006', 'transient', true],
    ['57P01', 'transient', true],
    ['ECONNRESET', 'transient', true],
    ['08004', 'unknown', false],
    ['08007', 'unknown', false],
    ['08P01', 'unknown', false],
    ['08garbage', 'unknown', false],
    ['XX000', 'unknown', false],
  ] as const)('should map SQLSTATE or network code %s', (code, kind, retryable) => {
    expect(postgresClassifyDriverError({ code })).toMatchObject({ kind, retryable })
  })

  it('should include only native PostgreSQL relation and column diagnostics', () => {
    expect(
      postgresClassifyDriverError({
        code: '23502',
        constraint: 'records_label_check',
        table: 'records',
        column: 'label',
        detail: 'another column is mentioned here',
      }),
    ).toEqual({
      kind: 'notNullViolation',
      retryable: false,
      constraint: 'records_label_check',
      table: 'records',
      columns: ['label'],
    })
  })
})

describe('SQLite native failure classification', () => {
  it.each([
    ['SQLITE_CONSTRAINT_UNIQUE', 'uniqueViolation', false],
    ['SQLITE_CONSTRAINT_PRIMARYKEY', 'uniqueViolation', false],
    ['SQLITE_CONSTRAINT_FOREIGNKEY', 'foreignKeyViolation', false],
    ['SQLITE_CONSTRAINT_NOTNULL', 'notNullViolation', false],
    ['SQLITE_CONSTRAINT_CHECK', 'checkViolation', false],
    ['SQLITE_BUSY_SNAPSHOT', 'transient', true],
    ['SQLITE_LOCKED_SHAREDCACHE', 'transient', true],
    ['SQLITE_CONSTRAINT', 'unknown', false],
  ] as const)('should map native code %s', (code, kind, retryable) => {
    expect(sqliteClassifyDriverError({ code })).toEqual({ kind, retryable })
  })

  it.each([
    [2067, 'uniqueViolation', false],
    [1555, 'uniqueViolation', false],
    [787, 'foreignKeyViolation', false],
    [1299, 'notNullViolation', false],
    [275, 'checkViolation', false],
    [5, 'transient', true],
    [517, 'transient', true],
    [6, 'transient', true],
    [262, 'transient', true],
    [19, 'unknown', false],
  ] as const)('should map node:sqlite errcode %i', (errcode, kind, retryable) => {
    expect(sqliteClassifyDriverError({ code: 'ERR_SQLITE_ERROR', errcode })).toEqual({
      kind,
      retryable,
    })
  })
})

it.each([postgresClassifyDriverError, sqliteClassifyDriverError])(
  'should find nested native codes without inferring from messages',
  (classify) => {
    const native: { code: string; cause?: unknown } = {
      code: classify === sqliteClassifyDriverError ? 'SQLITE_CONSTRAINT_UNIQUE' : '23505',
    }

    const outer: { cause?: unknown; message: string } = {
      message: '23505 SQLITE_CONSTRAINT_UNIQUE',
      cause: native,
    }

    expect(classify(outer)).toEqual({ kind: 'uniqueViolation', retryable: false })

    expect(classify({ message: '23505 SQLITE_BUSY' })).toEqual({
      kind: 'unknown',
      retryable: false,
    })
  },
)

it.each([postgresClassifyDriverError, sqliteClassifyDriverError])(
  'should terminate unknown cyclic and hostile cause chains',
  (classify) => {
    const self: { code: string; cause?: unknown } = { code: 'unrecognized' }
    self.cause = self

    const first: { code: string; cause?: unknown } = { code: 'unrecognized' }
    const second: { code: string; cause?: unknown } = { code: 'also-unrecognized' }
    first.cause = second
    second.cause = first

    const hostile = Object.defineProperty({ code: 'unrecognized' }, 'cause', {
      get: () => {
        throw new Error('hostile cause getter')
      },
    })

    for (const cause of [self, first, hostile])
      expect(classify(cause)).toEqual({ kind: 'unknown', retryable: false })
  },
)

it('should ignore hostile PostgreSQL code and metadata getters while finding a nested failure', () => {
  const native = Object.defineProperties(
    { code: '23505' },
    Object.fromEntries(
      ['constraint', 'table', 'column'].map((field) => [
        field,
        {
          get: () => {
            throw new Error(`${field} getter failed`)
          },
        },
      ]),
    ),
  )

  const outer = Object.defineProperty({ cause: native }, 'code', {
    get: () => {
      throw new Error('code getter failed')
    },
  })

  expect(postgresClassifyDriverError(outer)).toEqual({
    kind: 'uniqueViolation',
    retryable: false,
  })
})

it('should ignore hostile SQLite code and errcode getters while finding an extended code', () => {
  const native = Object.defineProperty(
    { code: 'ERR_SQLITE_ERROR', extendedErrcode: 2067 },
    'errcode',
    {
      get: () => {
        throw new Error('errcode getter failed')
      },
    },
  )

  const outer = Object.defineProperty({ cause: native }, 'code', {
    get: () => {
      throw new Error('code getter failed')
    },
  })

  expect(sqliteClassifyDriverError(outer)).toEqual({
    kind: 'uniqueViolation',
    retryable: false,
  })
})
