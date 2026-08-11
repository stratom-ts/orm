import type {
  MigrationPrecondition,
  MigrationRuntimeOptions,
} from '@/ddl/migrationProgram'
import {
  MIGRATE_ADVISORY_LOCK_CLASS,
  MIGRATE_ADVISORY_LOCK_ID,
  createMigrationCoordinationScope,
} from '@/migrations/coordinationScope'
import type { MigrationCleanupFailure, MigrationExecutionStage } from '@/utils/error'

import { schemaFromNamespace } from './targets'

export class MigrationCancellationError extends Error {
  /**
   * Creates a cancellation failure with its observed stage and cleanup failures.
   *
   * @param message - Human-readable cancellation description.
   * @param stage - Migration stage interrupted by cancellation.
   * @param cleanupFailures - Secondary failures encountered while cancelling.
   */
  constructor(
    message: string,
    readonly stage: MigrationExecutionStage,
    readonly cleanupFailures: readonly MigrationCleanupFailure[] = [],
  ) {
    super(message)
  }
}

export class MigrationLockTimeoutError extends MigrationCancellationError {}
export class MigrationSignalAbortedError extends MigrationCancellationError {}

export type CancellationState = {
  cancelled: boolean
}

const MIGRATION_LOCK_POLL_INTERVAL_MS = 100
export const MIGRATION_SESSION_CALL_TIMEOUT_MS = 5_000

/**
 * Quotes a PostgreSQL identifier.
 *
 * @param identifier - Identifier spelling to quote.
 */
function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/**
 * Cancels and drains an in-flight session operation without leaking its rejection.
 *
 * @param options - Runtime capabilities for the physical session.
 * @param state - Shared cancellation state to mark.
 * @param inFlight - Optional session operation whose settlement must be drained.
 */
async function cancelSession(
  options: MigrationRuntimeOptions,
  state: CancellationState,
  inFlight?: Promise<unknown>,
): Promise<MigrationCleanupFailure[]> {
  state.cancelled = true
  options.discard()
  const cleanupFailures: MigrationCleanupFailure[] = []
  let cancelSucceeded = true
  try {
    await options.cancel()
  } catch (cause) {
    cancelSucceeded = false
    cleanupFailures.push({ stage: 'sessionCleanup', cause })
  }
  const settled = inFlight?.then(
    () => undefined,
    () => undefined,
  )
  if (cancelSucceeded) await settled
  return cleanupFailures
}

/**
 * Races one physical-session operation against cancellation and an optional deadline.
 *
 * @example
 *   const rows = await runCancellable({
 *     runtime,
 *     state,
 *     stage: 'lock',
 *     operation: () => runtime.executor.execute(query),
 *   })
 *
 * @param options - Runtime, shared state, operation, stage, and optional deadline.
 * @param options.runtime - Runtime capabilities for the physical session.
 * @param options.state - Shared cancellation state.
 * @param options.operation - Physical-session operation to run.
 * @param options.stage - Migration stage reported on interruption.
 * @param options.timeoutMs - Optional interruption deadline in milliseconds.
 * @param options.timeoutMessage - Optional message reported when the deadline expires.
 */
export async function runCancellable<T>(options: {
  runtime: MigrationRuntimeOptions
  state: CancellationState

  /** Runs one physical-session operation. */
  operation: () => Promise<T>
  stage: MigrationExecutionStage
  timeoutMs?: number
  timeoutMessage?: string
}): Promise<T> {
  const { runtime, state, stage, timeoutMs } = options
  if (runtime.signal?.aborted) {
    const cleanupFailures = await cancelSession(runtime, state)
    throw new MigrationSignalAbortedError(
      'Migration execution was aborted',
      stage,
      cleanupFailures,
    )
  }
  const operation = options.operation()

  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const interrupted = new Promise<'timeout' | 'abort'>((resolve) => {
    if (timeoutMs !== undefined) timer = setTimeout(() => resolve('timeout'), timeoutMs)
    if (runtime.signal) {
      abort = () => resolve('abort')
      runtime.signal.addEventListener('abort', abort, { once: true })
    }
  })
  const settled = operation.then(
    (value) => ({ kind: 'value' as const, value }),
    (cause) => ({ kind: 'error' as const, cause }),
  )
  const result = await Promise.race([settled, interrupted])
  if (timer) clearTimeout(timer)
  if (abort) runtime.signal?.removeEventListener('abort', abort)
  if (result === 'timeout' || result === 'abort') {
    const cleanupFailures = await cancelSession(runtime, state, operation)
    if (result === 'timeout') {
      throw new MigrationLockTimeoutError(
        options.timeoutMessage ??
          `Timed out acquiring the migration advisory lock after ${runtime.lockTimeoutMs}ms`,
        stage,
        cleanupFailures,
      )
    }
    throw new MigrationSignalAbortedError(
      'Migration execution was aborted',
      stage,
      cleanupFailures,
    )
  }
  if (result.kind === 'error') throw result.cause
  return result.value
}

/**
 * Cancels immediately when a deadline or signal is observed between SQL calls.
 *
 * @param options - Runtime capabilities for the physical session.
 * @param state - Shared cancellation state to mark.
 * @param stage - Migration stage interrupted by cancellation.
 * @param timeout - Whether a deadline, rather than an abort signal, was observed.
 */
async function stopCancelled(
  options: MigrationRuntimeOptions,
  state: CancellationState,
  stage: MigrationExecutionStage,
  timeout: boolean,
): Promise<never> {
  const cleanupFailures = await cancelSession(options, state)
  if (timeout) {
    throw new MigrationLockTimeoutError(
      options.lockTimeoutMs === 0
        ? 'Migration advisory lock was not available after one no-wait try'
        : `Timed out acquiring the migration advisory lock after ${options.lockTimeoutMs}ms`,
      stage,
      cleanupFailures,
    )
  }
  throw new MigrationSignalAbortedError(
    'Migration execution was aborted',
    stage,
    cleanupFailures,
  )
}

/**
 * Acquires the stable session advisory lock with a finite monotonic deadline.
 *
 * @example
 *   await acquireCoordination(runtime, { cancelled: false })
 *
 * @param options - Runtime session and lock configuration.
 * @param state - Shared cancellation state.
 */
export async function acquireCoordination(
  options: MigrationRuntimeOptions,
  state: CancellationState,
): Promise<void> {
  createMigrationCoordinationScope(options.databaseIdentity, options.applicationId)
  const deadline = performance.now() + options.lockTimeoutMs
  let firstAttempt = true
  while (true) {
    if (options.signal?.aborted) {
      await stopCancelled(options, state, 'lock', false)
    }
    if (!firstAttempt && performance.now() >= deadline) {
      await stopCancelled(options, state, 'lock', true)
    }
    const remaining = Math.max(0, deadline - performance.now())
    const [row] = await runCancellable({
      runtime: options,
      state,
      stage: 'lock',
      timeoutMs:
        options.lockTimeoutMs === 0
          ? MIGRATION_SESSION_CALL_TIMEOUT_MS
          : Math.min(MIGRATION_SESSION_CALL_TIMEOUT_MS, remaining),
      timeoutMessage: `Timed out waiting ${MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for a migration lock attempt response`,
      operation: () =>
        options.executor.execute({
          sql: `select pg_try_advisory_lock(${MIGRATE_ADVISORY_LOCK_CLASS}, ${MIGRATE_ADVISORY_LOCK_ID}) as "locked"`,
          params: [],
        }),
    })
    firstAttempt = false
    if (typeof row !== 'object' || row === null || !('locked' in row)) {
      throw new Error('PostgreSQL did not return a migration advisory lock result')
    }
    if (row.locked === true) return
    if (row.locked !== false) {
      throw new Error('PostgreSQL returned an invalid migration advisory lock result')
    }
    if (options.signal?.aborted) {
      await stopCancelled(options, state, 'lock', false)
    }
    const waitRemaining = deadline - performance.now()
    if (waitRemaining <= 0) {
      await stopCancelled(options, state, 'lock', true)
    }
    await runCancellable({
      runtime: options,
      state,
      stage: 'lock',
      timeoutMs: waitRemaining,
      operation: () =>
        new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(MIGRATION_LOCK_POLL_INTERVAL_MS, waitRemaining)),
        ),
    })
  }
}

/**
 * Releases and verifies the stable session advisory lock.
 *
 * @example
 *   await releaseCoordination(runtime)
 *
 * @param options - Runtime capabilities for the locked session.
 */
export async function releaseCoordination(
  options: MigrationRuntimeOptions,
): Promise<void> {
  const [row] = await options.executor.execute({
    sql: `select pg_advisory_unlock(${MIGRATE_ADVISORY_LOCK_CLASS}, ${MIGRATE_ADVISORY_LOCK_ID}) as "unlocked"`,
    params: [],
  })
  if (
    typeof row !== 'object' ||
    row === null ||
    !('unlocked' in row) ||
    row.unlocked !== true
  ) {
    throw new Error('PostgreSQL did not verify migration advisory lock release')
  }
}

/**
 * Evaluates one semantic precondition in the authoritative transaction.
 *
 * @example
 *   await assertPrecondition(runtime, precondition)
 *
 * @param options - Runtime capabilities for the transaction session.
 * @param precondition - Semantic assertion to evaluate.
 */
export async function assertPrecondition(
  options: MigrationRuntimeOptions,
  precondition: MigrationPrecondition,
): Promise<void> {
  const schema = schemaFromNamespace(precondition.relation.namespace)
  const relation = `${quoteIdent(schema)}.${quoteIdent(precondition.relation.relation.spelling)}`
  const [row] = await options.executor.execute({
    sql: `select count(*)::int as count from ${relation} where ${quoteIdent(precondition.column)} is null`,
    params: [],
  })
  const count = Number((row as { count?: unknown } | undefined)?.count ?? 0)
  if (count > 0) {
    throw new Error(
      `Cannot set column '${schema}.${precondition.relation.relation.spelling}.${precondition.column}' as NOT NULL - column has NULL values`,
    )
  }
}
