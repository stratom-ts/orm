import { flatten, getDotPath } from 'valibot'
import { expect, expectTypeOf, it } from 'vitest'

import type { StratomError } from '@/index'
import {
  DriverError,
  MigrationError,
  QueryError,
  ValidationError,
  isErrorTag,
  isStratomError,
} from '@/index'

/** Uses the same structured fields as the README catch examples. */
function describeCaughtError(error: unknown): string {
  if (isErrorTag(error, 'QueryError')) {
    expectTypeOf(error).toEqualTypeOf<QueryError>()
    return error.message
  }

  if (isErrorTag(error, 'DriverError')) {
    expectTypeOf(error).toEqualTypeOf<DriverError>()
    return error.kind === 'uniqueViolation'
      ? 'conflict'
      : error.retryable
        ? `retry ${error.code ?? ''}`
        : 'database failure'
  }

  if (isErrorTag(error, 'ValidationError')) {
    expectTypeOf(error).toEqualTypeOf<ValidationError>()
    const paths = error.issues.map((issue) => getDotPath(issue))
    return `${error.table}: ${paths.join(', ')} ${JSON.stringify(flatten(error.issues))}`
  }

  if (isErrorTag(error, 'MigrationError')) {
    expectTypeOf(error).toEqualTypeOf<MigrationError>()
    return `${error.stage}: ${error.capabilityIssues?.map((issue) => issue.code).join(', ')}`
  }

  if (isStratomError(error)) {
    expectTypeOf(error).toEqualTypeOf<StratomError>()
    return error._tag
  }

  return 'unknown'
}

it('narrows missing rows and database conflicts from unknown', () => {
  expect(describeCaughtError(new QueryError({ message: 'No rows returned' }))).toBe(
    'No rows returned',
  )

  expect(
    describeCaughtError(
      new DriverError({
        message: 'insert failed',
        dialect: 'sqlite',
        sql: 'insert into users (email) values (?)',
        cause: null,
        kind: 'uniqueViolation',
        retryable: false,
      }),
    ),
  ).toBe('conflict')
})

it('narrows retryable failures and blocked migrations from unknown', () => {
  expect(
    describeCaughtError(
      new DriverError({
        message: 'select failed',
        dialect: 'postgres',
        sql: 'select * from users',
        cause: null,
        code: '40001',
        kind: 'transient',
        retryable: true,
      }),
    ),
  ).toBe('retry 40001')

  expect(
    describeCaughtError(
      new MigrationError({
        message: 'blocked',
        stage: 'lowering',
        capabilityIssues: [
          { code: 'compile_failure', message: 'unsupported', sourceStepIndexes: [0] },
        ],
      }),
    ),
  ).toBe('lowering: compile_failure')
})

it('narrows structured validation issues from unknown', () => {
  expect(
    describeCaughtError(
      new ValidationError({
        table: 'users',
        operation: 'insert',
        issues: [
          {
            kind: 'schema',
            type: 'string',
            input: 7,
            expected: 'string',
            received: 'number',
            message: 'invalid email',
          },
        ],
      }),
    ),
  ).toContain('users:')
})
