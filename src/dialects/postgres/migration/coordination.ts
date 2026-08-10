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

/** Quotes a PostgreSQL identifier. */
function quoteIdent(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/** Cancels and drains an in-flight session operation without leaking its rejection. */
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

/** Races one physical-session operation against cancellation and an optional deadline. */
export async function runCancellable<T>(options: {
  runtime: MigrationRuntimeOptions
  state: CancellationState
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

/** Cancels immediately when a deadline or signal is observed between SQL calls. */
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

/** Acquires the stable session advisory lock with a finite monotonic deadline. */
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

/** Releases and verifies the stable session advisory lock. */
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

/** Evaluates one semantic precondition in the authoritative transaction. */
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
