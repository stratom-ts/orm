import { expect, it } from 'vitest'

import {
  enrichMigrationError,
  migrationExecutionError,
} from '@/migrations/migrationDiagnostics'
import { MigrationError } from '@/utils/error'

const executionFacts = {
  stage: 'ddl' as const,
  outcome: 'rolledBack' as const,
  retryable: false,
  defect: false,
  message: (actionIndex: number | undefined) =>
    `Execution failed${actionIndex === undefined ? '' : ` during action ${actionIndex + 1}`}`,
}

it('keeps an absent primary cause absent while preserving structured diagnostics', () => {
  const issues = [
    { code: 'invalid_target' as const, message: 'invalid', sourceStepIndexes: [4] },
  ]

  const indexes = [4]
  const existing = new MigrationError({
    message: 'invalid target',
    defect: true,
    outcome: 'unchanged',
    retryable: true,
    actionIndex: 2,
    sourceStepIndexes: indexes,
    capabilityIssues: issues,
  })

  const result = enrichMigrationError(existing, {
    message: 'Migration planning failed: invalid target',
    stage: 'planning',
    retryable: false,
  })

  expect(result.message).toBe('Migration planning failed: invalid target')
  expect(Object.hasOwn(result, 'cause')).toBe(false)

  expect(result).toMatchObject({
    defect: true,
    stage: 'planning',
    outcome: 'unchanged',
    retryable: false,
    actionIndex: 2,
  })

  expect(result.sourceStepIndexes).toBe(indexes)
  expect(result.capabilityIssues).toBe(issues)
})

it.each([null, undefined])('retains an explicitly present %s cause', (cause) => {
  const existing = new MigrationError({ message: 'failure', cause })
  const result = enrichMigrationError(existing, { stage: 'planning' })

  expect(Object.hasOwn(result, 'cause')).toBe(true)
  expect(result.cause).toBe(cause)
  expect(Object.hasOwn(result, 'defect')).toBe(false)
})

it('appends cleanup in order, retaining duplicates and existing evidence', () => {
  const first = new Error('first')
  const second = new Error('second')
  const existing = new MigrationError({
    message: 'failure',
    cleanupFailures: [{ stage: 'rollback', cause: first }],
  })

  const result = enrichMigrationError(existing, {
    cleanupFailures: [
      { stage: 'unlock', cause: second },
      { stage: 'unlock', cause: second },
    ],
  })

  expect(result.cleanupFailures).toEqual([
    { stage: 'rollback', cause: first },
    { stage: 'unlock', cause: second },
    { stage: 'unlock', cause: second },
  ])

  expect(existing.cleanupFailures).toEqual([{ stage: 'rollback', cause: first }])
})

it('retains an existing empty cleanup array when no cleanup is added', () => {
  const empty: readonly never[] = []
  const result = enrichMigrationError(
    new MigrationError({ message: 'failure', cleanupFailures: empty }),
    { stage: 'planning' },
  )

  expect(Object.hasOwn(result, 'cleanupFailures')).toBe(true)
  expect(result.cleanupFailures).toBe(empty)
})

it('uses the structured error itself when it has no own cause', () => {
  const existing = new MigrationError({ message: 'expected', retryable: true })
  const result = migrationExecutionError(existing, { ...executionFacts, defect: true })

  expect(result.cause).toBe(existing)
  expect(result.defect).toBeUndefined()
  expect(Object.hasOwn(result, 'defect')).toBe(false)
  expect(result.retryable).toBe(true)
})

it.each([null, undefined])('retains a structured %s primary cause', (cause) => {
  const existing = new MigrationError({ message: 'expected', cause })
  const result = migrationExecutionError(existing, executionFacts)

  expect(Object.hasOwn(result, 'cause')).toBe(true)
  expect(result.cause).toBe(cause)
})

it('preserves a defect cause and its original stack', () => {
  const cause = new TypeError('defect')
  const stack = cause.stack
  const existing = new MigrationError({
    message: 'wrapped defect',
    cause,
    defect: true,
  })

  const result = migrationExecutionError(existing, executionFacts)

  expect(result.defect).toBe(true)
  expect(result.cause).toBe(cause)
  expect((result.cause as Error).stack).toBe(stack)

  expect(migrationExecutionError(cause, { ...executionFacts, defect: true }).defect).toBe(
    true,
  )
})

it('prefers supplied action provenance and retains missing provenance', () => {
  const retainedIndexes = [3]
  const existing = new MigrationError({
    message: 'expected',
    actionIndex: 1,
    sourceStepIndexes: retainedIndexes,
  })

  const result = migrationExecutionError(existing, {
    ...executionFacts,
    actionIndex: 4,
  })

  expect(result.message).toBe('Execution failed during action 5')
  expect(result.actionIndex).toBe(4)
  expect(result.sourceStepIndexes).toBe(retainedIndexes)

  const retained = migrationExecutionError(existing, executionFacts)
  expect(retained.message).toBe('Execution failed during action 2')
  expect(retained.actionIndex).toBe(1)
})

it('uses structured retryability except when the database outcome is unknown', () => {
  const existing = new MigrationError({ message: 'retry', retryable: true })
  expect(migrationExecutionError(existing, executionFacts).retryable).toBe(true)

  expect(
    migrationExecutionError(existing, { ...executionFacts, outcome: 'unknown' })
      .retryable,
  ).toBe(false)
})

it('merges cleanup in order and preserves explicitly supplied undefined optionals', () => {
  const failure = { stage: 'unlock' as const, cause: new Error('unlock') }
  const existing = new MigrationError({
    message: 'expected',
    cleanupFailures: [failure],
  })

  const result = migrationExecutionError(existing, {
    ...executionFacts,
    actionIndex: undefined,
    sourceStepIndexes: undefined,
    capabilityIssues: undefined,
    cleanupFailures: [failure],
  })

  expect(result.cleanupFailures).toEqual([failure, failure])
  expect(Object.hasOwn(result, 'actionIndex')).toBe(true)
  expect(Object.hasOwn(result, 'sourceStepIndexes')).toBe(true)
  expect(Object.hasOwn(result, 'capabilityIssues')).toBe(true)

  const empty = migrationExecutionError(new Error('failure'), {
    ...executionFacts,
    cleanupFailures: undefined,
  })

  expect(Object.hasOwn(empty, 'cleanupFailures')).toBe(true)
  expect(empty.cleanupFailures).toBeUndefined()
})
