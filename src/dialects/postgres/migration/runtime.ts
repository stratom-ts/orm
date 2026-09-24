import type { MigrationProgram, MigrationRuntimeOptions } from '@/ddl/migrationProgram'
import type { MigrationCleanupFailure, MigrationExecutionStage } from '@/utils/error'
import { MigrationError } from '@/utils/error'

import type {
  CancellationState,
  PostgresAdvisoryLockIdentity,
  PostgresMigrationRuntimeOptions,
} from './coordination'
import {
  MIGRATION_SESSION_CALL_TIMEOUT_MS,
  MigrationCancellationError,
  MigrationLockTimeoutError,
  MigrationSignalAbortedError,
  acquireCoordination,
  assertPrecondition,
  releaseCoordinationFailures,
  runCancellable,
} from './coordination'

const DEFAULT_POSTGRES_MIGRATION_LOCK_TIMEOUT_MS = 30_000

/**
 * Reads the primary cause through an existing structured migration error.
 *
 * @param cause - Failure whose primary cause is requested.
 */
function primaryCause(cause: unknown): unknown {
  if (cause instanceof MigrationError && cause.cause !== undefined) {
    return cause.cause
  }

  return cause
}

/** Resolves retryability while treating an unknown database outcome as final. */
function executionRetryable(
  structured: MigrationError | undefined,
  options: Readonly<{
    outcome: 'unchanged' | 'rolledBack' | 'applied' | 'unknown'
    retryable: boolean
  }>,
): boolean {
  if (options.outcome === 'unknown') return false
  return structured?.retryable ?? options.retryable
}

/**
 * Creates a structured execution failure while preserving the primary cause.
 *
 * @param options - Failure stage, outcome, provenance, and cleanup details.
 * @param options.cause - Primary or already structured failure.
 * @param options.stage - Fallback stage that observed the failure.
 * @param options.outcome - Known database effect after the failure.
 * @param options.retryable - Whether a safe retry is permitted.
 * @param options.actionIndex - Optional physical action index that failed.
 * @param options.sourceStepIndexes - Optional semantic steps that produced the action.
 * @param options.capabilityIssues - Deterministic whole-plan lowering evidence to retain.
 * @param options.cleanupFailures - Secondary cleanup failures to retain.
 */
function executionError(options: {
  cause: unknown
  stage: MigrationExecutionStage
  outcome: 'unchanged' | 'rolledBack' | 'applied' | 'unknown'
  retryable: boolean
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
  capabilityIssues?: MigrationError['capabilityIssues']
  cleanupFailures?: readonly MigrationCleanupFailure[]
}): MigrationError {
  const { cause } = options
  const structured = cause instanceof MigrationError ? cause : undefined
  const actionIndex = options.actionIndex ?? structured?.actionIndex
  const sourceStepIndexes = options.sourceStepIndexes ?? structured?.sourceStepIndexes
  const capabilityIssues = options.capabilityIssues ?? structured?.capabilityIssues
  const cleanupFailures = [
    ...(structured?.cleanupFailures ?? []),
    ...(options.cleanupFailures ?? []),
  ]
  const retryable = executionRetryable(structured, options)

  return new MigrationError({
    message: cause instanceof Error ? cause.message : 'Migration failed',
    cause: primaryCause(cause),
    stage: structured?.stage ?? options.stage,
    outcome: options.outcome,
    retryable,
    ...(actionIndex === undefined ? {} : { actionIndex }),
    ...(sourceStepIndexes === undefined ? {} : { sourceStepIndexes }),
    ...(capabilityIssues === undefined ? {} : { capabilityIssues }),
    ...(cleanupFailures.length ? { cleanupFailures } : {}),
  })
}

/**
 * Uses the cancellation stage when cancellation interrupted a database phase.
 *
 * @param cause - Failure that may describe a cancellation stage.
 * @param fallback - Stage to use for non-cancellation failures.
 */
function cancellationStage(
  cause: unknown,
  fallback: MigrationExecutionStage,
): MigrationExecutionStage {
  if (cause instanceof MigrationCancellationError) return cause.stage
  return fallback
}

/**
 * Preserves a structured stage reported by preparation or lowering.
 *
 * @param cause - Failure that may report its own migration stage.
 * @param fallback - Stage to use when the failure has no structured stage.
 */
function reportedStage(
  cause: unknown,
  fallback: MigrationExecutionStage,
): MigrationExecutionStage {
  if (cause instanceof MigrationCancellationError) return cause.stage
  if (cause instanceof MigrationError && cause.stage !== undefined) return cause.stage
  return fallback
}

/**
 * Classifies the database effect after a failed migration execution.
 *
 * @param stage - Stage at which execution failed.
 * @param ddlStarted - Whether execution attempted any DDL.
 * @param rollbackAcknowledged - Whether PostgreSQL acknowledged rollback.
 */
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

/**
 * Classifies the database effect after an acknowledged commit.
 *
 * @param committed - Whether PostgreSQL acknowledged commit.
 * @param ddlStarted - Whether execution attempted any DDL.
 */
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
 *
 * @example
 *   const result = await executePostgresMigration(runtime)
 *
 * @param input - Runtime session capabilities and migration preparation callback.
 */
export async function executePostgresMigration(
  input: MigrationRuntimeOptions,
): Promise<{ outcome: 'applied' | 'unchanged' }> {
  const options: PostgresMigrationRuntimeOptions = {
    ...input,
    lockTimeoutMs: input.lockTimeoutMs ?? DEFAULT_POSTGRES_MIGRATION_LOCK_TIMEOUT_MS,
  }
  let acquiredLocks: readonly PostgresAdvisoryLockIdentity[] = []
  const cancellation: CancellationState = { cancelled: false }

  try {
    acquiredLocks = await acquireCoordination(options, cancellation)
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

  /** Verifies every program precondition in the authoritative transaction. */
  async function executePreconditions(program: MigrationProgram): Promise<void> {
    if (primary) return

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

  /** Executes every physical program action in source order. */
  async function executeActions(program: MigrationProgram): Promise<void> {
    if (primary) return

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

  /** Executes the authoritative migration transaction after coordination succeeds. */
  async function executeTransaction(): Promise<void> {
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

    if (program) await executePreconditions(program)
    if (program) await executeActions(program)

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
  }

  /** Releases every confirmed coordination lock and retains cleanup evidence. */
  async function releaseLock(): Promise<void> {
    if (
      acquiredLocks.length > 0 &&
      !cancellation.cancelled &&
      !cancellation.sessionUncertain
    ) {
      try {
        const failures = await runCancellable({
          runtime: options,
          state: cancellation,
          stage: 'unlock',
          timeoutMs: MIGRATION_SESSION_CALL_TIMEOUT_MS,
          timeoutMessage: `Timed out waiting ${MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for migration advisory lock release verification`,
          operation: () => releaseCoordinationFailures(options, acquiredLocks),
        })

        if (failures.length > 0) {
          options.discard()
          cleanupFailures.push(...failures)
        }
      } catch (cause) {
        options.discard()
        cleanupFailures.push({ stage: 'unlock', cause })

        if (cause instanceof MigrationCancellationError) {
          cleanupFailures.push(...cause.cleanupFailures)
        }
      }
    }
  }

  await executeTransaction().finally(releaseLock)

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
