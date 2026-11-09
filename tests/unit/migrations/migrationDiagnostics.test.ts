import { expect, it, vi } from 'vitest'

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

it('should preserve guarded-drop diagnostics through phase, execution, cleanup and JSON', () => {
  const target = {
    kind: 'column' as const,
    relation: {
      namespace: [
        {
          role: 'database' as const,
          identifier: { spelling: 'main', comparisonKey: 'main' },
        },
      ],
      relation: { spelling: 'events', comparisonKey: 'events' },
    },
    column: { spelling: 'payload', comparisonKey: 'payload' },
  }

  const preconditionFailure = { target, reason: 'contains_non_null_values' as const }

  const original = new MigrationError({
    message: 'data present',
    stage: 'precondition',
    preconditionFailure,
    sourceStepIndexes: [2],
  })

  const enriched = enrichMigrationError(original, {
    cleanupFailures: [{ stage: 'rollback', cause: new Error('rollback failed') }],
  })

  const executed = migrationExecutionError(enriched, {
    ...executionFacts,
    stage: 'precondition',
    outcome: 'unchanged',
  })

  expect(executed.preconditionFailure).toEqual(preconditionFailure)
  expect(executed.sourceStepIndexes).toEqual([2])
  expect(executed.cleanupFailures?.map((failure) => failure.stage)).toEqual(['rollback'])

  expect(JSON.parse(JSON.stringify(executed))).toMatchObject({
    preconditionFailure,
    sourceStepIndexes: [2],
  })
})

it.each([0, 2])(
  'should keep an absent primary cause absent and action index %i through phase enrichment',
  (actionIndex) => {
    const issues = [
      { code: 'invalid_target' as const, message: 'invalid', sourceStepIndexes: [4] },
    ]

    const indexes = [4]
    const existing = new MigrationError({
      message: 'invalid target',
      defect: true,
      outcome: 'unchanged',
      retryable: true,
      actionIndex,
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
      actionIndex,
    })

    expect(result.sourceStepIndexes).toBe(indexes)
    expect(result.capabilityIssues).toBe(issues)
  },
)

it.each([null, undefined])('should retain an explicitly present %s cause', (cause) => {
  const existing = new MigrationError({ message: 'failure', cause })
  const result = enrichMigrationError(existing, { stage: 'planning' })

  expect(Object.hasOwn(result, 'cause')).toBe(true)
  expect(result.cause).toBe(cause)
  expect(Object.hasOwn(result, 'defect')).toBe(false)

  const executed = migrationExecutionError(result, executionFacts)
  expect(Object.hasOwn(executed, 'cause')).toBe(true)
  expect(executed.cause).toBe(cause)
})

it.each([
  { name: 'phase', changes: { stage: 'planning' as const } },
  {
    name: 'cleanup',
    changes: {
      cleanupFailures: [{ stage: 'unlock' as const, cause: new Error('unlock') }],
    },
  },
])('should not promote an inherited cause during $name enrichment', ({ changes }) => {
  const inheritedCause = new Error('inherited')
  class InheritedCauseMigrationError extends MigrationError {}

  Object.defineProperty(InheritedCauseMigrationError.prototype, 'cause', {
    value: inheritedCause,
  })

  const existing = new InheritedCauseMigrationError({ message: 'failure' })
  expect(existing.cause).toBe(inheritedCause)
  expect(Object.hasOwn(existing, 'cause')).toBe(false)

  const enriched = enrichMigrationError(existing, changes)
  expect(Object.hasOwn(enriched, 'cause')).toBe(false)

  const executed = migrationExecutionError(enriched, executionFacts)
  expect(executed.cause).toBe(enriched)
})

it.each([0, 2])(
  'should append cleanup in order and keep action index %i',
  (actionIndex) => {
    const first = new Error('first')
    const second = new Error('second')
    const existing = new MigrationError({
      message: 'failure',
      actionIndex,
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

    expect(result.actionIndex).toBe(actionIndex)

    expect(existing.cleanupFailures).toEqual([{ stage: 'rollback', cause: first }])
  },
)

it('should retain an existing empty cleanup array when no cleanup is added', () => {
  const empty: readonly never[] = []
  const result = enrichMigrationError(
    new MigrationError({ message: 'failure', cleanupFailures: empty }),
    { stage: 'planning' },
  )

  expect(Object.hasOwn(result, 'cleanupFailures')).toBe(true)
  expect(result.cleanupFailures).toBe(empty)
})

it('should use the structured error itself when it has no own cause', () => {
  const existing = new MigrationError({ message: 'expected', retryable: true })
  const result = migrationExecutionError(existing, { ...executionFacts, defect: true })

  expect(result.cause).toBe(existing)
  expect(result.defect).toBeUndefined()
  expect(Object.hasOwn(result, 'defect')).toBe(false)
  expect(result.retryable).toBe(true)
})

it.each([null, undefined])('should retain a structured %s primary cause', (cause) => {
  const existing = new MigrationError({ message: 'expected', cause })
  const result = migrationExecutionError(existing, executionFacts)

  expect(Object.hasOwn(result, 'cause')).toBe(true)
  expect(result.cause).toBe(cause)
})

it('should preserve a defect cause and its original stack', () => {
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

it('should prefer supplied action provenance and retain missing provenance', () => {
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

it('should prefer supplied source indexes and capability issues while retaining missing values', () => {
  const retainedIssues = [
    { code: 'invalid_target' as const, message: 'retained', sourceStepIndexes: [2] },
  ]

  const suppliedIssues = [
    { code: 'invalid_target' as const, message: 'supplied', sourceStepIndexes: [5] },
  ]

  const existing = new MigrationError({
    message: 'expected',
    sourceStepIndexes: [2],
    capabilityIssues: retainedIssues,
  })

  const supplied = migrationExecutionError(existing, {
    ...executionFacts,
    sourceStepIndexes: [5],
    capabilityIssues: suppliedIssues,
  })

  expect(supplied.sourceStepIndexes).toEqual([5])
  expect(supplied.capabilityIssues).toBe(suppliedIssues)

  const retained = migrationExecutionError(existing, executionFacts)
  expect(retained.sourceStepIndexes).toBe(existing.sourceStepIndexes)
  expect(retained.capabilityIssues).toBe(retainedIssues)
})

it('should use structured retryability except when the database outcome is unknown', () => {
  const existing = new MigrationError({ message: 'retry', retryable: true })
  expect(migrationExecutionError(existing, executionFacts).retryable).toBe(true)

  const nonRetryable = new MigrationError({ message: 'final', retryable: false })
  expect(
    migrationExecutionError(nonRetryable, { ...executionFacts, retryable: true })
      .retryable,
  ).toBe(false)

  expect(
    migrationExecutionError(existing, { ...executionFacts, outcome: 'unknown' })
      .retryable,
  ).toBe(false)
})

it('should merge cleanup in order and omit unavailable optional diagnostics', () => {
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
  expect(Object.hasOwn(result, 'actionIndex')).toBe(false)
  expect(Object.hasOwn(result, 'sourceStepIndexes')).toBe(false)
  expect(Object.hasOwn(result, 'capabilityIssues')).toBe(false)

  const empty = migrationExecutionError(new Error('failure'), {
    ...executionFacts,
    cleanupFailures: undefined,
  })

  expect(Object.hasOwn(empty, 'cleanupFailures')).toBe(false)
  expect(empty.cleanupFailures).toBeUndefined()

  const absent = migrationExecutionError(new Error('failure'), executionFacts)
  expect(Object.hasOwn(absent, 'cleanupFailures')).toBe(false)
  expect(Object.hasOwn(absent, 'actionIndex')).toBe(false)

  const structuredEmpty = new MigrationError({ message: 'expected', cleanupFailures: [] })
  const omitted = migrationExecutionError(structuredEmpty, executionFacts)
  expect(Object.hasOwn(omitted, 'cleanupFailures')).toBe(false)

  const suppliedEmpty = migrationExecutionError(structuredEmpty, {
    ...executionFacts,
    cleanupFailures: undefined,
  })

  expect(Object.hasOwn(suppliedEmpty, 'cleanupFailures')).toBe(false)
  expect(suppliedEmpty.cleanupFailures).toBeUndefined()
})

it('should retain expected migration diagnostics from another package copy', async () => {
  vi.resetModules()
  const { MigrationError: ForeignMigrationError } = await import('@/utils/error')
  const native = new Error('native failure')
  const foreign = new ForeignMigrationError({
    message: 'expected failure',
    cause: native,
    actionIndex: 0,
    sourceStepIndexes: [3],
    capabilityIssues: [
      { code: 'invalid_target', message: 'invalid', sourceStepIndexes: [3] },
    ],
    retryable: true,
  })

  expect(foreign).not.toBeInstanceOf(MigrationError)
  const result = migrationExecutionError(foreign, { ...executionFacts, defect: true })
  expect(result.defect).toBeUndefined()
  expect(result.cause).toBe(native)
  expect(result.actionIndex).toBe(0)
  expect(result.sourceStepIndexes).toEqual([3])
  expect(result.capabilityIssues).toBe(foreign.capabilityIssues)
  expect(result.retryable).toBe(true)
})
