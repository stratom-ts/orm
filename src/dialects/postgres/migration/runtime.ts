import type { MigrationRuntimeOptions } from '@/ddl/migrationProgram'
import type { MigrationCleanupFailure, MigrationExecutionStage } from '@/utils/error'
import { MigrationError } from '@/utils/error'

import type { CancellationState } from './coordination'
import {
  MIGRATION_SESSION_CALL_TIMEOUT_MS,
  MigrationCancellationError,
  MigrationLockTimeoutError,
  MigrationSignalAbortedError,
  acquireCoordination,
  assertPrecondition,
  releaseCoordination,
  runCancellable,
} from './coordination'

/** Reads the primary cause through an existing structured migration error. */
function primaryCause(cause: unknown): unknown {
  if (cause instanceof MigrationError && cause.cause !== undefined) {
    return cause.cause
  }
  return cause
}

/** Creates a structured execution failure while preserving the primary cause. */
function executionError(options: {
  cause: unknown
  stage: MigrationExecutionStage
  outcome: 'unchanged' | 'rolledBack' | 'applied' | 'unknown'
  retryable: boolean
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
  cleanupFailures?: readonly MigrationCleanupFailure[]
}): MigrationError {
  const { cause } = options
  const structured = cause instanceof MigrationError ? cause : undefined
  const actionIndex = options.actionIndex ?? structured?.actionIndex
  const sourceStepIndexes = options.sourceStepIndexes ?? structured?.sourceStepIndexes
  const cleanupFailures = [
    ...(structured?.cleanupFailures ?? []),
    ...(options.cleanupFailures ?? []),
  ]
  let retryable = structured?.retryable ?? options.retryable
  if (options.outcome === 'unknown') retryable = false

  return new MigrationError({
    message: cause instanceof Error ? cause.message : 'Migration failed',
    cause: primaryCause(cause),
    stage: structured?.stage ?? options.stage,
    outcome: options.outcome,
    retryable,
    ...(actionIndex === undefined ? {} : { actionIndex }),
    ...(sourceStepIndexes === undefined ? {} : { sourceStepIndexes }),
    ...(cleanupFailures.length ? { cleanupFailures } : {}),
  })
}

/** Uses the cancellation stage when cancellation interrupted a database phase. */
function cancellationStage(
  cause: unknown,
  fallback: MigrationExecutionStage,
): MigrationExecutionStage {
  if (cause instanceof MigrationCancellationError) return cause.stage
  return fallback
}

/** Preserves a structured stage reported by preparation or lowering. */
function reportedStage(
  cause: unknown,
  fallback: MigrationExecutionStage,
): MigrationExecutionStage {
  if (cause instanceof MigrationCancellationError) return cause.stage
  if (cause instanceof MigrationError && cause.stage !== undefined) return cause.stage
  return fallback
}

/** Classifies the database effect after a failed migration execution. */
function failureOutcome(
  stage: MigrationExecutionStage,
  ddlStarted: boolean,
  rollbackAcknowledged: boolean,
): 'unchanged' | 'rolledBack' | 'unknown' {
  if (stage === 'commit') return 'unknown'
  if (!ddlStarted) return 'unchanged'
  if (rollbackAcknowledged) return 'rolledBack'
  return 'unknown'
}

/** Classifies the database effect after an acknowledged commit. */
function successfulOutcome(
  committed: boolean,
  ddlStarted: boolean,
): 'applied' | 'unchanged' {
  return committed && ddlStarted ? 'applied' : 'unchanged'
}

/**
 * Runs one PostgreSQL migration under coordination and an authoritative repeatable-read
 * transaction. Commit acknowledgement is a hard uncertainty boundary: it is never
 * followed by rollback or compensation.
 */
export async function executePostgresMigration(
  options: MigrationRuntimeOptions,
): Promise<{ outcome: 'applied' | 'unchanged' }> {
  let lockAcquired = false
  const cancellation: CancellationState = { cancelled: false }
  try {
    await acquireCoordination(options, cancellation)
    lockAcquired = true
  } catch (cause) {
    const knownSafeFailure =
      cause instanceof MigrationLockTimeoutError ||
      cause instanceof MigrationSignalAbortedError
    if (!knownSafeFailure) options.discard()
    throw executionError({
      cause,
      stage: 'lock',
      outcome: 'unchanged',
      retryable: knownSafeFailure,
      cleanupFailures:
        cause instanceof MigrationCancellationError ? cause.cleanupFailures : [],
    })
  }

  let transactionOpen = false
  let ddlStarted = false
  let rollbackAcknowledged = false
  let committed = false
  let primary:
    | {
        cause: unknown
        stage: MigrationExecutionStage
        actionIndex?: number
        sourceStepIndexes?: readonly number[]
      }
    | undefined
  const cleanupFailures: MigrationCleanupFailure[] = []

  try {
    try {
      await runCancellable({
        runtime: options,
        state: cancellation,
        stage: 'transaction',
        operation: () =>
          options.executor.run({
            sql: 'begin isolation level repeatable read',
            params: [],
          }),
      })
      transactionOpen = true
    } catch (cause) {
      options.discard()
      primary = {
        cause,
        stage: cancellationStage(cause, 'transaction'),
      }
      if (cause instanceof MigrationCancellationError) {
        cleanupFailures.push(...cause.cleanupFailures)
      }
    }

    let program
    if (!primary) {
      try {
        program = await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'introspection',
          operation: options.prepare,
        })
        if (program.atomicity !== 'plan-atomic') {
          throw new MigrationError({
            message: `Migration execution requires plan-atomic programs; received ${program.atomicity}`,
            stage: 'lowering',
            outcome: 'unchanged',
            retryable: false,
          })
        }
        const invalidAction = program.actions.find(
          (action) => action.transaction !== 'required',
        )
        if (invalidAction) {
          throw new MigrationError({
            message: `Plan-atomic PostgreSQL actions must require a transaction; received ${invalidAction.transaction}`,
            stage: 'lowering',
            outcome: 'unchanged',
            retryable: false,
          })
        }
      } catch (cause) {
        primary = {
          cause,
          stage: reportedStage(cause, 'lowering'),
        }
        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    }

    if (!primary && program) {
      for (const precondition of program.preconditions) {
        try {
          await runCancellable({
            runtime: options,
            state: cancellation,
            stage: 'precondition',
            operation: () => assertPrecondition(options, precondition),
          })
        } catch (cause) {
          primary = {
            cause,
            stage: cancellationStage(cause, 'precondition'),
            sourceStepIndexes: precondition.sourceStepIndexes,
          }
          if (cause instanceof MigrationCancellationError) {
            cleanupFailures.push(...cause.cleanupFailures)
          }
          break
        }
      }
    }

    if (!primary && program) {
      for (let actionIndex = 0; actionIndex < program.actions.length; actionIndex++) {
        const action = program.actions[actionIndex]!
        try {
          ddlStarted = true
          for (const statement of action.statements) {
            await runCancellable({
              runtime: options,
              state: cancellation,
              stage: 'ddl',
              operation: () => options.executor.run(statement),
            })
          }
        } catch (cause) {
          primary = {
            cause,
            stage: 'ddl',
            actionIndex,
            sourceStepIndexes: action.sourceStepIndexes,
          }
          if (cause instanceof MigrationCancellationError) {
            cleanupFailures.push(...cause.cleanupFailures)
          }
          break
        }
      }
    }

    if (!primary) {
      try {
        await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'commit',
          operation: () => options.executor.run({ sql: 'commit', params: [] }),
        })
        transactionOpen = false
        committed = true
      } catch (cause) {
        transactionOpen = false
        options.discard()
        primary = {
          cause,
          stage: cancellationStage(cause, 'commit'),
        }
        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    } else if (transactionOpen && !cancellation.cancelled) {
      try {
        await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'rollback',
          operation: () => options.executor.run({ sql: 'rollback', params: [] }),
        })
        transactionOpen = false
        rollbackAcknowledged = true
      } catch (cause) {
        transactionOpen = false
        options.discard()
        cleanupFailures.push({ stage: 'rollback', cause })
        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    }
  } finally {
    if (lockAcquired && !cancellation.cancelled) {
      try {
        await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'unlock',
          timeoutMs: MIGRATION_SESSION_CALL_TIMEOUT_MS,
          timeoutMessage: `Timed out waiting ${MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for migration advisory lock release verification`,
          operation: () => releaseCoordination(options),
        })
      } catch (cause) {
        options.discard()
        cleanupFailures.push({ stage: 'unlock', cause })
        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    }
  }

  if (primary) {
    const outcome = failureOutcome(primary.stage, ddlStarted, rollbackAcknowledged)
    throw executionError({
      ...primary,
      outcome,
      retryable:
        outcome !== 'unknown' && primary.cause instanceof MigrationCancellationError,
      cleanupFailures,
    })
  }

  if (cleanupFailures.length > 0) {
    const cause = cleanupFailures[0]!.cause
    throw executionError({
      cause,
      stage: 'unlock',
      outcome: successfulOutcome(committed, ddlStarted),
      retryable: false,
      cleanupFailures,
    })
  }

  return { outcome: successfulOutcome(committed, ddlStarted) }
}
