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
 *
 * @returns A structured migration error retaining the primary cause and known execution
 *   outcome.
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

/** Appends cancellation cleanup evidence without replacing the primary migration failure. */
function retainCancellationFailures(
  failures: MigrationCleanupFailure[],
  cause: unknown,
): void {
  if (cause instanceof MigrationCancellationError) {
    failures.push(...cause.cleanupFailures)
  }
}

/**
 * Rejects migration programs that cannot run atomically in one transaction.
 *
 * @param program - Lowered physical actions, preconditions, and transaction atomicity
 *   requirements.
 */
function assertPlanAtomicProgram(program: MigrationProgram): void {
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

/** Releases the confirmed locks after the caller verifies session safety. */
async function releaseConfirmedLocks(
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  acquiredLocks: readonly PostgresAdvisoryLockIdentity[],
  cleanupFailures: MigrationCleanupFailure[],
): Promise<void> {
  try {
    const failures = await runCancellable({
      runtime: options,
      state: cancellation,
      stage: 'unlock',
      timeoutMs: MIGRATION_SESSION_CALL_TIMEOUT_MS,
      timeoutMessage: `Timed out waiting ${MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for migration advisory lock release verification`,
      /** Releases confirmed advisory locks with cancellation controls. */
      operation: () => releaseCoordinationFailures(options, acquiredLocks),
    })

    if (failures.length > 0) {
      options.discard()
      cleanupFailures.push(...failures)
    }
  } catch (cause) {
    options.discard()
    cleanupFailures.push({ stage: 'unlock', cause })
    retainCancellationFailures(cleanupFailures, cause)
  }
}

type MigrationExecutionFailure = {
  cause: unknown
  stage: MigrationExecutionStage
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
}

/** Verifies every program precondition in the authoritative transaction. */
async function executePreconditions(
  program: MigrationProgram,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanupFailures: MigrationCleanupFailure[],
): Promise<MigrationExecutionFailure | undefined> {
  for (const precondition of program.preconditions) {
    try {
      await runCancellable({
        runtime: options,
        state: cancellation,
        stage: 'precondition',
        /** Checks the migration precondition with cancellation controls. */
        operation: () => assertPrecondition(options, precondition),
      })
    } catch (cause) {
      const primary: MigrationExecutionFailure = {
        cause,
        stage: cancellationStage(cause, 'precondition'),
        sourceStepIndexes: precondition.sourceStepIndexes,
      }

      retainCancellationFailures(cleanupFailures, cause)

      return primary
    }
  }

  return undefined
}

/** Acquires coordination and reports acquisition failures with their known outcome. */
async function acquireMigrationCoordination(
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
): Promise<readonly PostgresAdvisoryLockIdentity[]> {
  try {
    return await acquireCoordination(options, cancellation)
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
}

/** Executes each statement for one physical migration action. */
async function executeActionStatements(
  action: MigrationProgram['actions'][number],
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
): Promise<void> {
  for (const statement of action.statements) {
    await runCancellable({
      runtime: options,
      state: cancellation,
      stage: 'ddl',
      /** Executes the current physical migration statement with cancellation controls. */
      operation: () => options.executor.run(statement),
    })
  }
}

/** Executes the authoritative transaction and retains its acknowledged outcome. */
async function executeMigrationTransaction(
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanupFailures: MigrationCleanupFailure[],
) {
  const state: MigrationTransactionState = {
    transactionOpen: false,
    ddlStarted: false,
    rollbackAcknowledged: false,
    committed: false,
    primary: undefined,
  }

  await executeTransaction(state, options, cancellation, cleanupFailures)
  return {
    ddlStarted: state.ddlStarted,
    rollbackAcknowledged: state.rollbackAcknowledged,
    committed: state.committed,
    primary: state.primary,
  }
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

  const cancellation: CancellationState = { cancelled: false }

  const acquiredLocks = await acquireMigrationCoordination(options, cancellation)

  const cleanupFailures: MigrationCleanupFailure[] = []
  let result: Awaited<ReturnType<typeof executeMigrationTransaction>>

  /** Releases every confirmed coordination lock and retains cleanup evidence. */
  async function releaseLock(): Promise<void> {
    if (
      acquiredLocks.length > 0 &&
      !cancellation.cancelled &&
      !cancellation.sessionUncertain
    ) {
      return releaseConfirmedLocks(options, cancellation, acquiredLocks, cleanupFailures)
    }
  }

  try {
    result = await executeMigrationTransaction(options, cancellation, cleanupFailures)
  } finally {
    await releaseLock()
  }

  return migrationExecutionOutcome(result, cleanupFailures)
}

type MigrationTransactionState = {
  transactionOpen: boolean
  ddlStarted: boolean
  rollbackAcknowledged: boolean
  committed: boolean
  primary: MigrationExecutionFailure | undefined
}

/**
 * Preserves acknowledged migration outcomes while reporting transaction cleanup failures.
 *
 * @param result - Captured execution result or validated input whose outcome is being
 *   interpreted.
 * @param cleanupFailures - Mutable cleanup evidence accumulated without replacing the
 *   primary rejection.
 *
 * @returns The acknowledged outcome combined with retained transaction-cleanup evidence.
 */
function migrationExecutionOutcome(
  result: {
    ddlStarted: boolean
    rollbackAcknowledged: boolean
    committed: boolean
    primary: MigrationExecutionFailure | undefined
  },
  cleanupFailures: Readonly<{
    stage: 'rollback' | 'unlock' | 'sessionCleanup'
    cause: unknown
  }>[],
) {
  const { primary, ddlStarted, rollbackAcknowledged, committed } = result

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

/**
 * Verifies preconditions and executes physical actions inside the authoritative
 * transaction.
 *
 * @param program - Lowered physical actions, preconditions, and transaction atomicity
 *   requirements.
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param options - Configuration and dependencies for this operation.
 * @param cancellation - Shared cancellation state used across migration phases.
 * @param cleanupFailures - Mutable cleanup evidence accumulated without replacing the
 *   primary rejection.
 */
async function executeProgramActions(
  program: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanupFailures: MigrationCleanupFailure[],
): Promise<void> {
  if (state.primary) return

  for (let actionIndex = 0; actionIndex < program.actions.length; actionIndex++) {
    const action = program.actions[actionIndex]!

    try {
      state.ddlStarted = true
      await executeActionStatements(action, options, cancellation)
    } catch (cause) {
      state.primary = {
        cause,
        stage: 'ddl',
        actionIndex,
        sourceStepIndexes: action.sourceStepIndexes,
      }

      retainCancellationFailures(cleanupFailures, cause)

      break
    }
  }
}

/**
 * Prepares and executes the migration, then commits or rolls back its authoritative
 * transaction.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param options - Configuration and dependencies for this operation.
 * @param cancellation - Shared cancellation state used across migration phases.
 * @param cleanupFailures - Mutable cleanup evidence accumulated without replacing the
 *   primary rejection.
 */
async function executeTransaction(
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanupFailures: MigrationCleanupFailure[],
): Promise<void> {
  await beginMigrationTransaction(options, cancellation, state, cleanupFailures)

  const program = await prepareMigrationProgram(
    state,
    options,
    cancellation,
    cleanupFailures,
  )

  if (program && !state.primary)
    state.primary = await executePreconditions(
      program,
      options,
      cancellation,
      cleanupFailures,
    )

  if (program)
    await executeProgramActions(program, state, options, cancellation, cleanupFailures)

  await completeMigrationTransaction(state, options, cancellation, cleanupFailures)
}

/**
 * Commits successful work or rolls back failures while retaining cleanup evidence.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param options - Configuration and dependencies for this operation.
 * @param cancellation - Shared cancellation state used across migration phases.
 * @param cleanupFailures - Mutable cleanup evidence accumulated without replacing the
 *   primary rejection.
 */
async function completeMigrationTransaction(
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanupFailures: Readonly<{
    stage: 'rollback' | 'unlock' | 'sessionCleanup'
    cause: unknown
  }>[],
) {
  if (!state.primary) {
    await commitMigrationTransaction(options, cancellation, state, cleanupFailures)
  } else if (state.transactionOpen && !cancellation.cancelled) {
    try {
      await runCancellable({
        runtime: options,
        state: cancellation,
        stage: 'rollback',
        /** Rolls back within the migration cancellation boundary. */
        operation: () => options.executor.run({ sql: 'rollback', params: [] }),
      })

      state.transactionOpen = false
      state.rollbackAcknowledged = true
    } catch (cause) {
      state.transactionOpen = false
      options.discard()
      cleanupFailures.push({ stage: 'rollback', cause })

      retainCancellationFailures(cleanupFailures, cause)
    }
  }
}

/**
 * Commits the authoritative transaction and retains cancellation or commit failures.
 *
 * @param options - Native executor and session interruption controls.
 * @param cancellation - Shared cancellation state for this migration.
 * @param state - Mutable transaction outcome and primary failure evidence.
 * @param cleanupFailures - Cleanup evidence retained after interruption.
 */
async function commitMigrationTransaction(
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  state: MigrationTransactionState,
  cleanupFailures: Readonly<{
    stage: 'rollback' | 'unlock' | 'sessionCleanup'
    cause: unknown
  }>[],
) {
  try {
    await runCancellable({
      runtime: options,
      state: cancellation,
      stage: 'commit',
      /** Commits within the migration cancellation boundary. */
      operation: () => options.executor.run({ sql: 'commit', params: [] }),
    })

    state.transactionOpen = false
    state.committed = true
  } catch (cause) {
    state.transactionOpen = false
    options.discard()
    state.primary = {
      cause,
      stage: cancellationStage(cause, 'commit'),
    }

    retainCancellationFailures(cleanupFailures, cause)
  }
}

/**
 * Builds and validates the authoritative migration program inside the current snapshot.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param options - Configuration and dependencies for this operation.
 * @param cancellation - Shared cancellation state used across migration phases.
 * @param cleanupFailures - Mutable cleanup evidence accumulated without replacing the
 *   primary rejection.
 *
 * @returns The validated authoritative physical program built inside the transaction
 *   snapshot.
 */
async function prepareMigrationProgram(
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanupFailures: Readonly<{
    stage: 'rollback' | 'unlock' | 'sessionCleanup'
    cause: unknown
  }>[],
) {
  let program

  if (!state.primary) {
    try {
      program = await runCancellable({
        runtime: options,
        state: cancellation,
        stage: 'introspection',
        operation: options.prepare,
      })
      assertPlanAtomicProgram(program)
    } catch (cause) {
      state.primary = {
        cause,
        stage: reportedStage(cause, 'lowering'),
      }

      retainCancellationFailures(cleanupFailures, cause)
    }
  }

  return program
}

/**
 * Starts the repeatable-read transaction before authoritative migration preparation.
 *
 * @param options - Configuration and dependencies for this operation.
 * @param cancellation - Shared cancellation state used across migration phases.
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param cleanupFailures - Mutable cleanup evidence accumulated without replacing the
 *   primary rejection.
 */
async function beginMigrationTransaction(
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  state: MigrationTransactionState,
  cleanupFailures: Readonly<{
    stage: 'rollback' | 'unlock' | 'sessionCleanup'
    cause: unknown
  }>[],
) {
  try {
    await runCancellable({
      runtime: options,
      state: cancellation,
      stage: 'transaction',
      /** Starts repeatable-read transaction with cancellation controls. */
      operation: () =>
        options.executor.run({
          sql: 'begin isolation level repeatable read',
          params: [],
        }),
    })

    state.transactionOpen = true
  } catch (cause) {
    options.discard()
    state.primary = {
      cause,
      stage: cancellationStage(cause, 'transaction'),
    }

    retainCancellationFailures(cleanupFailures, cause)
  }
}
