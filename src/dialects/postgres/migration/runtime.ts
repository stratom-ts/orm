import type { MigrationProgram, MigrationRuntimeOptions } from '@/ddl/migrationProgram'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import { migrationExecutionError } from '@/migrations/migrationDiagnostics'
import { MigrationOwnershipSchemaError } from '@/migrations/migrationOwnership'
import type { MigrationCleanupFailure, MigrationExecutionStage } from '@/utils/error'
import { InvariantError, MigrationError, isErrorTag } from '@/utils/error'

import type {
  CancellationState,
  PostgresAdvisoryLockIdentity,
  PostgresMigrationRuntimeOptions,
} from './coordination'
import {
  POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS,
  PostgresMigrationCancellationError,
  PostgresMigrationLockTimeoutError,
  PostgresMigrationSignalAbortedError,
  acquireCoordination,
  assertPrecondition,
  releaseCoordinationFailures,
  runCancellable,
} from './coordination'
import { schemaFromNamespace } from './targets'

const DEFAULT_POSTGRES_MIGRATION_LOCK_TIMEOUT_MS = 30_000

/** Formats operation context and only retains detail from recognized errors. */
function executionMessage(
  cause: unknown,
  stage: MigrationExecutionStage,
  actionIndex: number | undefined,
  structured: MigrationError | undefined,
): string {
  const detail =
    structured?.message ??
    (cause instanceof PostgresMigrationCancellationError ||
    isErrorTag(cause, 'InvariantError')
      ? cause.message
      : undefined)

  const action = actionIndex === undefined ? '' : ` during action ${actionIndex + 1}`
  return `PostgreSQL migration ${stage} failed${action}${detail === undefined ? '' : `: ${detail}`}`
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
  const structured = isErrorTag(cause, 'MigrationError') ? cause : undefined
  const stage = structured?.stage ?? options.stage

  return migrationExecutionError(cause, {
    message: (actionIndex) => executionMessage(cause, stage, actionIndex, structured),
    defect:
      !(cause instanceof PostgresMigrationCancellationError) &&
      !isErrorTag(cause, 'QueryError') &&
      !isErrorTag(cause, 'DriverError') &&
      !isErrorTag(cause, 'SchemaError'),
    stage,
    outcome: options.outcome,
    retryable: options.retryable,
    ...(options.actionIndex === undefined ? {} : { actionIndex: options.actionIndex }),
    ...(options.sourceStepIndexes === undefined
      ? {}
      : { sourceStepIndexes: options.sourceStepIndexes }),
    ...(options.capabilityIssues === undefined
      ? {}
      : { capabilityIssues: options.capabilityIssues }),
    ...(options.cleanupFailures?.length
      ? { cleanupFailures: options.cleanupFailures }
      : {}),
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
  if (cause instanceof PostgresMigrationCancellationError) return cause.stage

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
  if (cause instanceof PostgresMigrationCancellationError) return cause.stage
  if (isErrorTag(cause, 'MigrationError') && cause.stage !== undefined) return cause.stage
  if (cause instanceof MigrationOwnershipSchemaError) return 'planning'

  return fallback
}

/** Appends cancellation cleanup evidence without replacing the primary migration failure. */
function retainCancellationFailures(
  failures: MigrationCleanupFailure[],
  cause: unknown,
): void {
  if (cause instanceof PostgresMigrationCancellationError) {
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
      timeoutMs: POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS,
      timeoutMessage: `Timed out waiting ${POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for migration advisory lock release verification`,
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
      cause instanceof PostgresMigrationLockTimeoutError ||
      cause instanceof PostgresMigrationSignalAbortedError

    if (!knownSafeFailure) options.discard()

    throw executionError({
      cause,
      stage: 'lock',
      outcome: 'unchanged',
      retryable: knownSafeFailure,
      cleanupFailures:
        cause instanceof PostgresMigrationCancellationError ? cause.cleanupFailures : [],
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
      operation: () => options.executor.run(statement, { source: 'ddl' }),
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
async function executePostgresMigration(
  input: MigrationRuntimeOptions,
): Promise<{ outcome: 'applied' | 'unchanged' }> {
  const options: PostgresMigrationRuntimeOptions = {
    ...input,
    lockTimeoutMs: input.lockTimeoutMs ?? DEFAULT_POSTGRES_MIGRATION_LOCK_TIMEOUT_MS,
    lockDeadline:
      performance.now() +
      (input.lockTimeoutMs ?? DEFAULT_POSTGRES_MIGRATION_LOCK_TIMEOUT_MS),
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

    if (
      isErrorTag(primary.cause, 'SchemaError') &&
      outcome === 'unchanged' &&
      cleanupFailures.length === 0
    )
      throw primary.cause

    throw executionError({
      ...primary,
      outcome,
      retryable:
        outcome !== 'unknown' &&
        (primary.cause instanceof PostgresMigrationCancellationError ||
          (primary.stage === 'lock' &&
            isErrorTag(primary.cause, 'DriverError') &&
            primary.cause.code === '55P03')),
      cleanupFailures,
    })
  }

  if (cleanupFailures.length > 0) {
    const cause = cleanupFailures[0].cause
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
    const action = program.actions[actionIndex]

    try {
      await applyRenameDeadline(program, action, options, cancellation)

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

function isRenameAction(
  program: MigrationProgram,
  action: MigrationProgram['actions'][number],
): boolean {
  return program.preconditions.some(
    (condition) =>
      condition.kind === 'column_rename' &&
      condition.sourceStepIndexes.some((index) =>
        action.sourceStepIndexes.includes(index),
      ),
  )
}

/** Carries the remaining coordination deadline into native rename lock waits. */
async function applyRenameDeadline(
  program: MigrationProgram,
  action: MigrationProgram['actions'][number],
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
): Promise<void> {
  if (!isRenameAction(program, action)) return

  const remaining =
    options.lockTimeoutMs === 0
      ? 1
      : Math.max(
          0,
          Math.ceil((options.lockDeadline ?? performance.now()) - performance.now()),
        )

  if (remaining === 0)
    throw new PostgresMigrationLockTimeoutError(
      'Timed out before column rename',
      'ddl',
      [],
    )

  await runCancellable({
    runtime: options,
    state: cancellation,
    stage: 'ddl',
    operation: () =>
      options.executor.run(
        { sql: `set local lock_timeout = '${remaining}ms'`, params: [] },
        { source: 'lifecycle' },
      ),
  })
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
  const provisional = await prepareMigrationProgram(
    state,
    options,
    cancellation,
    cleanupFailures,
  )

  if (!provisional) return

  await beginMigrationTransaction(options, cancellation, state, cleanupFailures)

  if (!state.primary)
    await lockGuardedRelations(provisional, state, options, cancellation, cleanupFailures)

  const program = await prepareMigrationProgram(
    state,
    options,
    cancellation,
    cleanupFailures,
  )

  if (program && !state.primary) assertLockedTargets(program, provisional, state)

  if (program && !state.primary)
    state.primary = await executePreconditions(
      program,
      options,
      cancellation,
      cleanupFailures,
    )

  if (program)
    await executeProgramActions(program, state, options, cancellation, cleanupFailures)

  if (program && !state.primary)
    await validateMigrationResult(state, options, cancellation, cleanupFailures)

  await completeMigrationTransaction(state, options, cancellation, cleanupFailures)
}

function assertLockedTargets(
  program: MigrationProgram,
  provisional: MigrationProgram,
  state: MigrationTransactionState,
): void {
  const locked = guardedRelations(provisional)

  const unlocked = guardedRelations(program).find(
    (relation) => !locked.some((item) => compareRelations(item, relation) === 0),
  )

  if (unlocked)
    state.primary = {
      cause: new MigrationError({
        message:
          'Authoritative migration target names a relation outside the provisional lock set; retry migration',
        stage: 'precondition',
        outcome: 'unchanged',
        retryable: true,
      }),
      stage: 'precondition',
    }
}

/** Runs final validation before committing, retaining failure and cleanup evidence. */
async function validateMigrationResult(
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanupFailures: MigrationCleanupFailure[],
): Promise<void> {
  try {
    await runCancellable({
      runtime: options,
      state: cancellation,
      stage: 'validation',
      operation: async () => {
        await options.validate?.()
      },
    })
  } catch (cause) {
    state.primary = { cause, stage: cancellationStage(cause, 'validation') }
    retainCancellationFailures(cleanupFailures, cause)
  }
}

/** Canonical relation order uses structured namespace roles and identifiers. */
function compareRelations(
  left: CanonicalRelationIdentity,
  right: CanonicalRelationIdentity,
): number {
  const leftParts = left.namespace.flatMap((segment) => [
    segment.role,
    segment.identifier.comparisonKey,
  ])

  const rightParts = right.namespace.flatMap((segment) => [
    segment.role,
    segment.identifier.comparisonKey,
  ])

  leftParts.push(left.relation.comparisonKey)
  rightParts.push(right.relation.comparisonKey)

  for (let index = 0; index < leftParts.length; index++) {
    const a = leftParts[index]
    const b = rightParts[index]

    if (a !== b) return a < b ? -1 : 1
  }

  return leftParts.length === rightParts.length ? 0 : -1
}

function guardedRelations(program: MigrationProgram): CanonicalRelationIdentity[] {
  const relations = program.preconditions.flatMap((condition) =>
    condition.kind === 'column_has_only_nulls' || condition.kind === 'column_rename'
      ? [condition.target.relation]
      : [],
  )

  return relations
    .sort(compareRelations)
    .filter(
      (relation, index, ordered) =>
        index === 0 || compareRelations(relation, ordered[index - 1]) !== 0,
    )
}

/** Acquires relation locks before the first snapshot-establishing statement. */
async function lockGuardedRelations(
  program: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanupFailures: MigrationCleanupFailure[],
): Promise<void> {
  const relations = guardedRelations(program)

  if (relations.length === 0) return

  let priorLockTimeout: string | undefined

  try {
    if (options.lockTimeoutMs !== 0)
      priorLockTimeout = await readLockTimeout(options, cancellation)

    for (const relation of relations) {
      await lockGuardedRelation(relation, options, cancellation)
    }
  } catch (cause) {
    state.primary = { cause, stage: cancellationStage(cause, 'lock') }
    retainCancellationFailures(cleanupFailures, cause)
    return
  }

  try {
    if (priorLockTimeout !== undefined)
      await restoreLockTimeout(priorLockTimeout, options, cancellation)

    await runCancellable({
      runtime: options,
      state: cancellation,
      stage: 'precondition',
      operation: () =>
        options.executor.run(
          { sql: 'set local row_security = off', params: [] },
          { source: 'lifecycle' },
        ),
    })
  } catch (cause) {
    state.primary = { cause, stage: cancellationStage(cause, 'precondition') }
    retainCancellationFailures(cleanupFailures, cause)
  }
}

/**
 * Reads the effective lock timeout without establishing the transaction snapshot.
 *
 * `show` is a utility statement, so unlike `select current_setting(...)` it does not take
 * the repeatable-read snapshot that must follow the relation locks.
 */
async function readLockTimeout(
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
): Promise<string> {
  const [row] = await runCancellable({
    runtime: options,
    state: cancellation,
    stage: 'lock',
    operation: () =>
      options.executor.execute(
        { sql: 'show lock_timeout', params: [] },
        { source: 'lifecycle' },
      ),
  })

  const value = (row as { lock_timeout?: unknown } | undefined)?.lock_timeout

  if (typeof value !== 'string')
    throw new InvariantError('PostgreSQL did not report the migration lock timeout')

  return value
}

/** Returns the transaction to the lock timeout in effect before relation locking. */
async function restoreLockTimeout(
  lockTimeout: string,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
): Promise<void> {
  await runCancellable({
    runtime: options,
    state: cancellation,
    stage: 'lock',
    operation: () =>
      options.executor.run(
        {
          sql: `set local lock_timeout = '${lockTimeout.replaceAll("'", "''")}'`,
          params: [],
        },
        { source: 'lifecycle' },
      ),
  })
}

/** Acquires one validated relation lock within the shared migration deadline. */
async function lockGuardedRelation(
  relation: CanonicalRelationIdentity,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
): Promise<void> {
  const remaining = Math.max(
    0,
    Math.ceil((options.lockDeadline ?? performance.now()) - performance.now()),
  )

  if (options.lockTimeoutMs !== 0 && remaining === 0)
    throw new PostgresMigrationLockTimeoutError(
      'Timed out acquiring migration relation locks',
      'lock',
      [],
    )

  if (options.lockTimeoutMs !== 0)
    await runCancellable({
      runtime: options,
      state: cancellation,
      stage: 'lock',
      operation: () =>
        options.executor.run(
          { sql: `set local lock_timeout = '${remaining}ms'`, params: [] },
          { source: 'lifecycle' },
        ),
    })

  const schema = schemaFromNamespace(relation.namespace)
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`
  await runCancellable({
    runtime: options,
    state: cancellation,
    stage: 'lock',
    timeoutMs:
      options.lockTimeoutMs === 0
        ? POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS
        : remaining,
    operation: () =>
      options.executor.run(
        {
          sql: `lock table ${quote(schema)}.${quote(relation.relation.spelling)} in access exclusive mode${options.lockTimeoutMs === 0 ? ' nowait' : ''}`,
          params: [],
        },
        { source: 'lifecycle' },
      ),
  })
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
        operation: () =>
          options.executor.run(
            {
              sql: 'rollback',
              params: [],
            },
            { source: 'lifecycle' },
          ),
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
      operation: () =>
        options.executor.run({ sql: 'commit', params: [] }, { source: 'lifecycle' }),
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
        stage: reportedStage(cause, 'introspection'),
      }

      retainCancellationFailures(cleanupFailures, cause)
    }
  }

  return state.primary ? undefined : program
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
        options.executor.run(
          {
            sql: 'begin isolation level repeatable read',
            params: [],
          },
          { source: 'lifecycle' },
        ),
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

export { executePostgresMigration }
