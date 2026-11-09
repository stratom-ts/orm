import type {
  MigrationAction,
  MigrationPhase,
  MigrationProgram,
  MigrationRuntimeOptions,
  MigrationRuntimeSuccess,
} from '@/ddl/migrationProgram'
import { migrationProgramPhases } from '@/ddl/migrationProgram'
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
  outcome: NonNullable<MigrationError['outcome']>
  retryable: boolean
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
  completedActions?: MigrationError['completedActions']
  rolledBackActions?: MigrationError['rolledBackActions']
  recovery?: MigrationError['recovery']
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
    ...(options.completedActions ? { completedActions: options.completedActions } : {}),
    ...(options.rolledBackActions
      ? { rolledBackActions: options.rolledBackActions }
      : {}),
    ...(options.recovery ? { recovery: options.recovery } : {}),
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

/** The atomic contract is unchanged; mixed execution always needs explicit consent. */
function assertExecutableProgram(
  program: MigrationProgram,
  options: PostgresMigrationRuntimeOptions,
): void {
  if (!program.actions.some((action) => action.transaction === 'forbidden'))
    return assertPlanAtomicProgram(program)

  if (program.atomicity !== 'non-atomic' || !options.allowPartialApplication)
    throw new MigrationError({
      message:
        'Transaction-forbidden actions require a non-atomic program and allowPartialApplication()',
      stage: 'permission',
      outcome: 'unchanged',
      retryable: false,
    })

  if (program.actions.some((action) => action.transaction === 'allowed'))
    throw new MigrationError({
      message: 'Mixed PostgreSQL programs require explicit transaction requirements',
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
    })
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
    ...(state.progress ? { progress: state.progress } : {}),
  }
}

/**
 * Runs one PostgreSQL migration under session advisory coordination. Atomic programs
 * use an authoritative repeatable-read transaction; mixed programs commit explicit
 * phases. Commit acknowledgment is never followed by compensation.
 *
 * @example
 *   const result = await executePostgresMigration(runtime)
 *
 * @param input - Runtime session capabilities and migration preparation callback.
 */
async function executePostgresMigration(
  input: MigrationRuntimeOptions,
): Promise<MigrationRuntimeSuccess> {
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
  progress?: MixedProgress
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
    progress?: MixedProgress
  },
  cleanupFailures: Readonly<{
    stage: 'rollback' | 'unlock' | 'sessionCleanup'
    cause: unknown
  }>[],
) {
  const { primary, ddlStarted, rollbackAcknowledged, committed, progress } = result

  if (primary) {
    const outcome =
      progress?.outcome ?? failureOutcome(primary.stage, ddlStarted, rollbackAcknowledged)

    if (
      isErrorTag(primary.cause, 'SchemaError') &&
      outcome === 'unchanged' &&
      cleanupFailures.length === 0
    )
      throw primary.cause

    throw executionError({
      ...primary,
      ...progressFacts(progress),
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
    throw executionError({
      cause: cleanupFailures[0].cause,
      stage: 'unlock',
      ...progressFacts(progress),
      outcome: successfulOutcome(committed, ddlStarted),
      retryable: false,
      cleanupFailures,
    })
  }

  return mixedSuccess(committed, ddlStarted, progress)
}

function mixedSuccess(
  committed: boolean,
  ddlStarted: boolean,
  progress: MixedProgress | undefined,
): MigrationRuntimeSuccess {
  return {
    outcome: successfulOutcome(committed, ddlStarted),
    ...(progress ? { completedActions: progress.completedActions } : {}),
  }
}

function progressFacts(progress: MixedProgress | undefined) {
  return progress
    ? {
        completedActions: progress.completedActions,
        rolledBackActions: progress.rolledBackActions,
        ...(progress.recovery ? { recovery: progress.recovery } : {}),
      }
    : {}
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
  const provisional = await prepareMigrationProgram(
    state,
    options,
    cancellation,
    cleanupFailures,
  )

  if (!provisional) return

  if (provisional.actions.some((action) => action.transaction === 'forbidden')) {
    await executeMixedProgram(provisional, state, options, cancellation, cleanupFailures)
    return
  }

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
): boolean {
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

  return !unlocked
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
      assertExecutableProgram(program, options)
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

type CompletedAction = NonNullable<MigrationError['completedActions']>[number]

type MixedProgress = {
  completedActions: CompletedAction[]
  rolledBackActions: CompletedAction[]
  recovery?: MigrationError['recovery']
  outcome?: NonNullable<MigrationError['outcome']>
}

/** Retains original program indexes even as subsequent observations produce smaller plans. */
function actionEvidence(program: MigrationProgram, actionIndex: number): CompletedAction {
  const action = program.actions[actionIndex]
  return {
    actionIndex,
    sourceStepIndexes: action.sourceStepIndexes,
    ...(action.target ? { target: action.target } : {}),
  }
}

/** Compares executable intent, not transient source-step indexes or repair annotations. */
function assertRemainingProgram(
  current: MigrationProgram,
  approved: MigrationProgram,
  start: number,
): void {
  const signature = (actions: readonly MigrationAction[]) =>
    JSON.stringify(
      actions.map((action) => ({
        transaction: action.transaction,
        statements: action.statements,
      })),
    )

  if (signature(current.actions) !== signature(approved.actions.slice(start)))
    throw new MigrationError({
      message:
        'Migration catalog drift changed the approved physical program; inspect and replan',
      stage: 'precondition',
      retryable: false,
    })
}

/** Takes only the current phase's guards; later phases must use their own fresh snapshots. */
function transactionalPrefix(program: MigrationProgram, count: number): MigrationProgram {
  const actions = program.actions.slice(0, count)
  const sources = new Set(actions.flatMap((action) => action.sourceStepIndexes))
  return {
    atomicity: 'plan-atomic',
    actions,
    preconditions: program.preconditions.filter((condition) =>
      condition.sourceStepIndexes.some((index) => sources.has(index)),
    ),
  }
}

/** Acknowledged phases survive later failures; no compensation or automatic replay occurs. */
async function executeMixedProgram(
  approved: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
): Promise<void> {
  state.progress = { completedActions: [], rolledBackActions: [] }

  for (const phase of migrationProgramPhases(approved.actions)) {
    await executeMixedPhase(phase, approved, state, options, cancellation, cleanup)

    if (state.primary) break
  }

  if (!state.primary) await validateMigrationResult(state, options, cancellation, cleanup)

  if (state.primary && state.progress.outcome === undefined)
    state.progress.outcome = completedFailureOutcome(state, approved.actions.length)
}

/** Cleanup changes session safety, not an already acknowledged schema effect. */
function completedFailureOutcome(
  state: MigrationTransactionState,
  actionCount: number,
): 'applied' | 'partial' | 'unchanged' {
  const completed = state.progress!.completedActions.length

  if (state.primary?.stage === 'sessionCleanup' && completed === actionCount)
    return 'applied'

  return completed ? 'partial' : 'unchanged'
}

/** Reobserves under the same session advisory locks before each physical phase. */
async function executeMixedPhase(
  phase: MigrationPhase,
  approved: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
): Promise<void> {
  try {
    const current = await prepareMigrationProgram(state, options, cancellation, cleanup)

    if (!current) return

    assertRemainingProgram(current, approved, phase.actionIndexes[0])

    if (phase.transaction === 'forbidden') {
      await executeForbiddenAction(
        phase.actionIndexes[0],
        approved,
        state,
        options,
        cancellation,
        cleanup,
      )

      return
    }

    await executeMixedGroup(
      phase,
      current,
      approved,
      state,
      options,
      cancellation,
      cleanup,
    )
  } catch (cause) {
    state.primary ??= { cause, stage: reportedStage(cause, 'precondition') }
    retainCancellationFailures(cleanup, cause)
  }
}

/**
 * Locks guards before the authoritative snapshot, then commits just this transactional
 * group.
 */
async function executeMixedGroup(
  phase: MigrationPhase,
  provisional: MigrationProgram,
  approved: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
): Promise<void> {
  state.rollbackAcknowledged = false
  await beginMigrationTransaction(options, cancellation, state, cleanup)

  await prepareMixedGroup(
    phase,
    provisional,
    approved,
    state,
    options,
    cancellation,
    cleanup,
  )

  const attempted: CompletedAction[] = []

  if (!state.primary)
    await executeGroupActions(
      phase,
      approved,
      state,
      options,
      cancellation,
      cleanup,
      attempted,
    )

  const last = phase.actionIndexes.at(-1) === approved.actions.length - 1

  if (last && !state.primary)
    await validateMigrationResult(state, options, cancellation, cleanup)

  await completeMigrationTransaction(state, options, cancellation, cleanup)
  recordGroupOutcome(state, attempted)
}

/** Whole-program preparation still precedes every write, including each later transaction. */
async function prepareMixedGroup(
  phase: MigrationPhase,
  provisional: MigrationProgram,
  approved: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
): Promise<void> {
  if (state.primary) return

  const group = transactionalPrefix(provisional, phase.actionIndexes.length)
  await lockGuardedRelations(
    group,
    state,
    { ...options, lockDeadline: performance.now() + options.lockTimeoutMs },
    cancellation,
    cleanup,
  )

  const authoritative = await prepareMigrationProgram(
    state,
    options,
    cancellation,
    cleanup,
  )

  if (!authoritative) return

  try {
    assertRemainingProgram(authoritative, approved, phase.actionIndexes[0])
    const current = transactionalPrefix(authoritative, phase.actionIndexes.length)

    if (assertLockedTargets(current, group, state))
      state.primary = await executePreconditions(current, options, cancellation, cleanup)
  } catch (cause) {
    state.primary = { cause, stage: reportedStage(cause, 'precondition') }
  }
}

/** Executes the approved original actions and preserves their global provenance. */
async function executeGroupActions(
  phase: MigrationPhase,
  approved: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
  attempted: CompletedAction[],
): Promise<void> {
  for (const index of phase.actionIndexes) {
    attempted.push(actionEvidence(approved, index))
    state.ddlStarted = true

    try {
      await executeActionStatements(approved.actions[index], options, cancellation)
    } catch (cause) {
      state.primary = {
        cause,
        stage: cancellationStage(cause, 'ddl'),
        actionIndex: index,
        sourceStepIndexes: approved.actions[index].sourceStepIndexes,
      }
      retainCancellationFailures(cleanup, cause)
      return
    }
  }
}

/** Only commit acknowledgments add actions to committed progress. */
function recordGroupOutcome(
  state: MigrationTransactionState,
  attempted: readonly CompletedAction[],
): void {
  const progress = state.progress!

  if (!state.primary) {
    progress.completedActions.push(...attempted)
    return
  }

  if (
    state.primary.stage === 'commit' ||
    (attempted.length > 0 && !state.rollbackAcknowledged)
  )
    progress.outcome = 'unknown'
  else if (state.rollbackAcknowledged) {
    progress.rolledBackActions.push(...attempted)
    progress.outcome = progress.completedActions.length
      ? 'partial'
      : attempted.length
        ? 'rolledBack'
        : 'unchanged'
  }
}

/**
 * PostgreSQL command errors acknowledge failure; connection loss and arbitrary failures
 * do not.
 */
function acknowledgedCommandFailure(cause: unknown): boolean {
  const seen = new Set<unknown>()
  while (cause && !seen.has(cause)) {
    seen.add(cause)

    if (isErrorTag(cause, 'DriverError'))
      return (
        /^[0-9A-Z]{5}$/.test(cause.code ?? '') &&
        !cause.code?.startsWith('08') &&
        !['57P01', '57P02', '57P03'].includes(cause.code ?? '')
      )

    if (!isErrorTag(cause, 'QueryError') && !isErrorTag(cause, 'MigrationError'))
      return false

    cause = cause.cause
  }

  return false
}

/** Changes only an explicitly supplied statement timeout, never the lock deadline. */
async function setStatementTimeout(
  value: string,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
): Promise<void> {
  await runCancellable({
    runtime: options,
    state: cancellation,
    stage: 'precondition',
    operation: () =>
      options.executor.run(
        { sql: "select set_config('statement_timeout', $1, false)", params: [value] },
        { source: 'lifecycle' },
      ),
  })
}

async function saveStatementTimeout(
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
): Promise<string | undefined> {
  if (options.statementTimeoutMs === undefined) return undefined

  const [row] = await runCancellable({
    runtime: options,
    state: cancellation,
    stage: 'precondition',
    operation: () =>
      options.executor.execute(
        { sql: 'show statement_timeout', params: [] },
        { source: 'lifecycle' },
      ),
  })

  const value = (row as { statement_timeout?: unknown } | undefined)?.statement_timeout

  if (typeof value !== 'string')
    throw new InvariantError('PostgreSQL did not report the statement timeout')

  return value
}

/**
 * Runs a single concurrent statement outside any transaction, with bounded settings
 * cleanup.
 */
async function executeForbiddenAction(
  index: number,
  approved: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
): Promise<void> {
  const action = approved.actions[index]
  let prior: string | undefined
  try {
    prior = await saveStatementTimeout(options, cancellation)

    if (options.statementTimeoutMs !== undefined)
      await setStatementTimeout(`${options.statementTimeoutMs}ms`, options, cancellation)

    await executeConcurrentCommand(index, approved, state, options, cancellation, cleanup)
  } catch (cause) {
    state.primary ??= {
      cause,
      stage: reportedStage(cause, 'precondition'),
      actionIndex: index,
      sourceStepIndexes: action.sourceStepIndexes,
    }
    options.discard()
    cancellation.sessionUncertain = true
    retainCancellationFailures(cleanup, cause)
  } finally {
    await restoreStatementTimeout(prior, state, options, cancellation, cleanup)
  }
}

/** Settings failures cannot erase a primary error or any acknowledged index action. */
async function restoreStatementTimeout(
  prior: string | undefined,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
): Promise<void> {
  if (prior === undefined || cancellation.cancelled || cancellation.sessionUncertain)
    return

  try {
    await setStatementTimeout(prior, options, cancellation)
  } catch (cause) {
    options.discard()
    cancellation.sessionUncertain = true
    cleanup.push({ stage: 'sessionCleanup', cause })
    state.primary ??= { cause, stage: 'sessionCleanup' }
    retainCancellationFailures(cleanup, cause)
  }
}

async function executeConcurrentCommand(
  index: number,
  approved: MigrationProgram,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
): Promise<void> {
  const action = approved.actions[index]
  state.ddlStarted = true

  try {
    await executeActionStatements(action, options, cancellation)
    state.committed = true
    state.progress!.completedActions.push(actionEvidence(approved, index))
  } catch (cause) {
    const known = acknowledgedCommandFailure(cause) && !cancellation.sessionUncertain
    state.primary = {
      cause,
      stage: cancellationStage(cause, 'ddl'),
      actionIndex: index,
      sourceStepIndexes: action.sourceStepIndexes,
    }
    state.progress!.outcome = known ? 'partial' : 'unknown'
    retainCancellationFailures(cleanup, cause)
    await retainIndexRecovery(action, known, state, options, cancellation, cleanup)

    if (!known) {
      options.discard()
      cancellation.sessionUncertain = true
    }
  }
}

/** Recovery evidence reports observation, never assumes residue is absent after failure. */
async function retainIndexRecovery(
  action: MigrationAction,
  known: boolean,
  state: MigrationTransactionState,
  options: PostgresMigrationRuntimeOptions,
  cancellation: CancellationState,
  cleanup: MigrationCleanupFailure[],
): Promise<void> {
  if (action.target?.kind !== 'index') return

  const target = action.target
  const operation = action.statements[0].sql.startsWith('drop ') ? 'drop' : 'create'
  state.progress!.recovery = {
    target,
    operation,
    status: known ? 'possibleResidue' : 'unknown',
    requires: 'inspectAndReplan',
    repairPermission: 'repairInvalidIndex',
  }

  if (!known || cancellation.cancelled) return

  try {
    const rows = await runCancellable({
      runtime: options,
      state: cancellation,
      stage: 'introspection',
      operation: () =>
        options.executor.execute(
          {
            sql: 'select i.indisvalid and i.indisready as valid from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid = i.indexrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2',
            params: [
              schemaFromNamespace(target.relation.namespace),
              target.index.spelling,
            ],
          },
          { source: 'catalog' },
        ),
    })

    const validity = rows.length === 0 ? 'absent' : (rows[0] as { valid?: unknown }).valid

    if (validity === 'absent' || typeof validity === 'boolean')
      state.progress!.recovery = {
        ...state.progress!.recovery,
        observedValidity:
          validity === 'absent' ? 'absent' : validity ? 'valid' : 'invalid',
      }
  } catch (cause) {
    cleanup.push({ stage: 'sessionCleanup', cause })
    retainCancellationFailures(cleanup, cause)
    options.discard()
    cancellation.sessionUncertain = true
  }
}

export { executePostgresMigration }
