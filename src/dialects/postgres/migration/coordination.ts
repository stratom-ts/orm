import { createHash } from 'node:crypto'

import type {
  MigrationPrecondition,
  MigrationRuntimeOptions,
} from '@/ddl/migrationProgram'
import {
  createMigrationCoordinationScope,
  migrationLockAcquisitionOrder,
} from '@/migrations/coordinationScope'
import type { MigrationCoordinationLockIdentity } from '@/migrations/coordinationScope'
import type { MigrationCleanupFailure, MigrationExecutionStage } from '@/utils/error'
import { InvariantError, TaggedError } from '@/utils/error'

import { MIGRATE_ADVISORY_LOCK_CLASS, MIGRATE_ADVISORY_LOCK_ID } from './constants'
import { schemaFromNamespace } from './targets'

/** PostgreSQL runtime input after the member has resolved coordination defaults. */
export type PostgresMigrationRuntimeOptions = MigrationRuntimeOptions &
  Readonly<{ lockTimeoutMs: number }>

export class MigrationCancellationError extends TaggedError(
  'MigrationCancellationError',
)<{
  message: string
  stage: MigrationExecutionStage
  cleanupFailures: readonly MigrationCleanupFailure[]
}> {
  /**
   * Creates a cancellation failure with its observed stage and cleanup failures.
   *
   * @param message - Human-readable cancellation description.
   * @param stage - Migration stage interrupted by cancellation.
   * @param cleanupFailures - Secondary failures encountered while cancelling.
   */
  constructor(
    message: string,
    stage: MigrationExecutionStage,
    cleanupFailures: readonly MigrationCleanupFailure[] = [],
  ) {
    super({ message, stage, cleanupFailures })
  }
}

export class MigrationLockTimeoutError extends MigrationCancellationError {}
export class MigrationSignalAbortedError extends MigrationCancellationError {}

export type CancellationState = {
  cancelled: boolean
  /** True when cancellation occurred during an in-flight physical call. */
  sessionUncertain?: boolean
}

export type PostgresAdvisoryLockIdentity = Readonly<{
  kind: 'database' | 'scoped'
  classId: number
  lockId: number
  canonicalIdentity: string
}>

/**
 * Maps a portable coordination identity to PostgreSQL's two-int32 key space.
 *
 * @example
 *   const key = postgresAdvisoryLockIdentity(identity)
 *
 * @param identity - Canonical portable identity to map to an advisory-lock key.
 */
export function postgresAdvisoryLockIdentity(
  identity: MigrationCoordinationLockIdentity,
): PostgresAdvisoryLockIdentity {
  if (identity.kind === 'database') {
    return {
      kind: 'database',
      classId: MIGRATE_ADVISORY_LOCK_CLASS,
      lockId: MIGRATE_ADVISORY_LOCK_ID,
      canonicalIdentity: identity.canonicalIdentity,
    }
  }

  const digest = createHash('sha256').update(identity.canonicalIdentity, 'utf8').digest()
  return {
    kind: 'scoped',
    classId: digest.readInt32BE(0),
    lockId: digest.readInt32BE(4),
    canonicalIdentity: identity.canonicalIdentity,
  }
}

const MIGRATION_LOCK_POLL_INTERVAL_MS = 100
export const MIGRATION_SESSION_CALL_TIMEOUT_MS = 5_000

/** Describes whether a lock attempt reached its configured deadline or watchdog. */
function lockAttemptTimeoutMessage(
  lockTimeoutMs: number,
  deadlineRemaining: number,
): string {
  if (lockTimeoutMs !== 0 && deadlineRemaining <= MIGRATION_SESSION_CALL_TIMEOUT_MS) {
    return `Timed out acquiring the migration advisory lock after ${lockTimeoutMs}ms`
  }

  return `Timed out waiting ${MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for a migration lock attempt response`
}

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
  options: PostgresMigrationRuntimeOptions,
  state: CancellationState,
  inFlight?: Promise<unknown>,
): Promise<MigrationCleanupFailure[]> {
  state.cancelled = true

  if (inFlight !== undefined) state.sessionUncertain = true

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
  runtime: PostgresMigrationRuntimeOptions
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
 * @param acquired - Confirmed locks to release in reverse order before cancellation.
 */
async function stopCancelled(
  options: PostgresMigrationRuntimeOptions,
  state: CancellationState,
  stage: MigrationExecutionStage,
  timeout: boolean,
  acquired: readonly PostgresAdvisoryLockIdentity[] = [],
): Promise<never> {
  const cleanupFailures: MigrationCleanupFailure[] = []
  let sessionCancelled = false

  if (!state.sessionUncertain) {
    for (const identity of [...acquired].reverse()) {
      try {
        const failures = await runCancellable({
          runtime: options,
          state,
          stage: 'unlock',
          timeoutMs: MIGRATION_SESSION_CALL_TIMEOUT_MS,
          timeoutMessage: `Timed out waiting ${MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for partial migration lock release`,
          operation: () => releaseCoordinationFailures(options, [identity]),
        })
        cleanupFailures.push(...failures)
      } catch (cause) {
        cleanupFailures.push({ stage: 'unlock', cause })

        if (cause instanceof MigrationCancellationError) {
          sessionCancelled = true
          cleanupFailures.push(...cause.cleanupFailures)
          break
        }
      }
    }
  }

  if (!sessionCancelled) cleanupFailures.push(...(await cancelSession(options, state)))

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
 * Acquires all PostgreSQL migration advisory locks under one monotonic deadline.
 *
 * @example
 *   const acquired = await acquireCoordination(runtime, { cancelled: false })
 *
 * @param options - Runtime session and lock configuration.
 * @param state - Shared cancellation and session-certainty state.
 */
export async function acquireCoordination(
  options: PostgresMigrationRuntimeOptions,
  state: CancellationState,
): Promise<readonly PostgresAdvisoryLockIdentity[]> {
  const scope = createMigrationCoordinationScope({
    dialect: 'postgresql',
    database: options.databaseIdentity,
    ...(options.applicationId === undefined
      ? {}
      : { applicationId: options.applicationId }),
  })
  const identities = migrationLockAcquisitionOrder(scope).map(
    postgresAdvisoryLockIdentity,
  )
  const acquired: PostgresAdvisoryLockIdentity[] = []
  const deadline = performance.now() + options.lockTimeoutMs

  for (const identity of identities) {
    let firstAttempt = true

    while (true) {
      const deadlineRemaining = Math.max(0, deadline - performance.now())
      const timeout =
        options.lockTimeoutMs === 0
          ? MIGRATION_SESSION_CALL_TIMEOUT_MS
          : Math.min(MIGRATION_SESSION_CALL_TIMEOUT_MS, deadlineRemaining)

      if (!firstAttempt && performance.now() >= deadline) {
        await stopCancelled(options, state, 'lock', true, acquired)
      }

      if (options.signal?.aborted) {
        await stopCancelled(options, state, 'lock', false, acquired)
      }

      let row

      try {
        ;[row] = await runCancellable({
          runtime: options,
          state,
          stage: 'lock',
          timeoutMs: timeout,
          timeoutMessage: lockAttemptTimeoutMessage(
            options.lockTimeoutMs,
            deadlineRemaining,
          ),
          operation: () =>
            options.executor.execute({
              sql: 'select pg_try_advisory_lock($1, $2) as "locked"',
              params: [identity.classId, identity.lockId],
            }),
        })
      } catch (cause) {
        // A query can have reached PostgreSQL before its error was observed.
        state.sessionUncertain = true
        throw cause
      }

      firstAttempt = false

      if (typeof row !== 'object' || row === null || !('locked' in row)) {
        state.sessionUncertain = true
        throw new InvariantError(
          'PostgreSQL did not return a migration advisory lock result',
        )
      }

      if (row.locked === true) {
        acquired.push(identity)
        break
      }

      if (row.locked !== false) {
        state.sessionUncertain = true
        throw new InvariantError(
          'PostgreSQL returned an invalid migration advisory lock result',
        )
      }

      if (options.lockTimeoutMs === 0) {
        await stopCancelled(options, state, 'lock', true, acquired)
      }

      if (options.signal?.aborted) {
        await stopCancelled(options, state, 'lock', false, acquired)
      }

      const waitRemaining = deadline - performance.now()

      if (waitRemaining <= 0) {
        await stopCancelled(options, state, 'lock', true, acquired)
      }

      const wait = new Promise<'elapsed' | 'aborted'>((resolve) => {
        const timer = setTimeout(
          () => {
            options.signal?.removeEventListener('abort', abort)
            resolve('elapsed')
          },
          Math.min(MIGRATION_LOCK_POLL_INTERVAL_MS, waitRemaining),
        )

        const abort = () => {
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', abort)
          resolve('aborted')
        }

        options.signal?.addEventListener('abort', abort, { once: true })
      })

      if ((await wait) === 'aborted') {
        await stopCancelled(options, state, 'lock', false, acquired)
      }
    }
  }

  return acquired
}

/**
 * Releases and verifies acquired PostgreSQL advisory locks in reverse order.
 *
 * @example
 *   await releaseCoordination(runtime, acquired)
 *
 * @param options - Runtime capabilities for the locked session.
 * @param identities - Confirmed locks to release in reverse acquisition order.
 */
export async function releaseCoordination(
  options: PostgresMigrationRuntimeOptions,
  identities: readonly PostgresAdvisoryLockIdentity[] = [
    {
      kind: 'database',
      classId: MIGRATE_ADVISORY_LOCK_CLASS,
      lockId: MIGRATE_ADVISORY_LOCK_ID,
      canonicalIdentity: 'stratom/migration/database/postgresql',
    },
  ],
): Promise<void> {
  const failures = await releaseCoordinationFailures(options, identities)

  if (failures.length > 0) throw failures[0]!.cause
}

/**
 * Attempts every advisory-lock release and retains each verification failure.
 *
 * @example
 *   const failures = await releaseCoordinationFailures(runtime, acquired)
 *
 * @param options - Runtime capabilities for the locked session.
 * @param identities - Confirmed locks to release in reverse acquisition order.
 */
export async function releaseCoordinationFailures(
  options: PostgresMigrationRuntimeOptions,
  identities: readonly PostgresAdvisoryLockIdentity[] = [
    {
      kind: 'database',
      classId: MIGRATE_ADVISORY_LOCK_CLASS,
      lockId: MIGRATE_ADVISORY_LOCK_ID,
      canonicalIdentity: 'stratom/migration/database/postgresql',
    },
  ],
): Promise<MigrationCleanupFailure[]> {
  const failures: MigrationCleanupFailure[] = []

  for (const identity of [...identities].reverse()) {
    try {
      const [row] = await options.executor.execute({
        sql: 'select pg_advisory_unlock($1, $2) as "unlocked"',
        params: [identity.classId, identity.lockId],
      })

      if (
        typeof row !== 'object' ||
        row === null ||
        !('unlocked' in row) ||
        row.unlocked !== true
      ) {
        throw new InvariantError(
          'PostgreSQL did not verify migration advisory lock release',
        )
      }
    } catch (cause) {
      failures.push({ stage: 'unlock', cause })
    }
  }

  return failures
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
  options: PostgresMigrationRuntimeOptions,
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
    throw new InvariantError(
      `Cannot set column '${schema}.${precondition.relation.relation.spelling}.${precondition.column}' as NOT NULL - column has NULL values`,
    )
  }
}
