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
import { InvariantError, TaggedError, attempt } from '@/utils/error'

import { schemaFromNamespace } from './targets'

/** Database-wide PostgreSQL migration advisory-lock identity. */
const POSTGRES_MIGRATION_ADVISORY_LOCK_CLASS = 0x7363_686d // 'schm'
const POSTGRES_MIGRATION_ADVISORY_LOCK_ID = 0x6f72_6d00 // 'orm\0'

/** PostgreSQL runtime input after the member has resolved coordination defaults. */
type PostgresMigrationRuntimeOptions = MigrationRuntimeOptions &
  Readonly<{ lockTimeoutMs: number }>

class PostgresMigrationCancellationError extends TaggedError(
  'PostgresMigrationCancellationError',
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

class PostgresMigrationLockTimeoutError extends PostgresMigrationCancellationError {}
class PostgresMigrationSignalAbortedError extends PostgresMigrationCancellationError {}

type CancellationState = {
  cancelled: boolean
  /** True when cancellation occurred during an in-flight physical call. */
  sessionUncertain?: boolean
}

type PostgresAdvisoryLockIdentity = Readonly<{
  kind: 'database' | 'scoped'
  classId: number
  lockId: number
  canonicalIdentity: string
}>

/**
 * Maps a portable coordination identity to PostgreSQL's two-int32 key space.
 *
 * @example
 *   const key = mapPostgresAdvisoryLockIdentity(identity)
 *
 * @param identity - Canonical portable identity to map to an advisory-lock key.
 */
function mapPostgresAdvisoryLockIdentity(
  identity: MigrationCoordinationLockIdentity,
): PostgresAdvisoryLockIdentity {
  if (identity.kind === 'database') {
    return {
      kind: 'database',
      classId: POSTGRES_MIGRATION_ADVISORY_LOCK_CLASS,
      lockId: POSTGRES_MIGRATION_ADVISORY_LOCK_ID,
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
const POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS = 5_000

/** Describes whether a lock attempt reached its configured deadline or watchdog. */
function lockAttemptTimeoutMessage(
  lockTimeoutMs: number,
  deadlineRemaining: number,
): string {
  if (
    lockTimeoutMs !== 0 &&
    deadlineRemaining <= POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS
  ) {
    return `Timed out acquiring the migration advisory lock after ${lockTimeoutMs}ms`
  }

  return `Timed out waiting ${POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for a migration lock attempt response`
}

/**
 * Quotes a PostgreSQL identifier.
 *
 * @param identifier - Identifier spelling to quote.
 */
function quoteIdentifier(identifier: string): string {
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
 *
 * @returns The operation value, or rejection with cancellation and cleanup evidence.
 */
async function runCancellable<T>(options: {
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
    throw new PostgresMigrationSignalAbortedError(
      'Migration execution was aborted',
      stage,
      cleanupFailures,
    )
  }

  const operation = options.operation()

  const { interrupted, timer, abort } = armOperationInterruption(timeoutMs, runtime)
  const settled = operation.then(
    (value) => ({ kind: 'value' as const, value }),
    (cause: unknown) => ({ kind: 'error' as const, cause }),
  )

  const result = await Promise.race([settled, interrupted])

  if (timer) clearTimeout(timer)
  if (abort) runtime.signal?.removeEventListener('abort', abort)

  if (result === 'timeout' || result === 'abort')
    return rejectInterruptedOperation(result, runtime, state, operation, options, stage)

  if (result.kind === 'error') throw result.cause

  return result.value
}

/**
 * Cancels interrupted work and reports its observed stage and cleanup evidence.
 *
 * @param result - Captured execution result or validated input whose outcome is being
 *   interpreted.
 * @param runtime - Active operation and interruption controls shared by this run.
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param operation - Work to run within the current session or error boundary.
 * @param options - Configuration and dependencies for this operation.
 * @param stage - Execution phase used to classify cancellation or migration failure.
 */
async function rejectInterruptedOperation<T>(
  result: 'timeout' | 'abort',
  runtime: PostgresMigrationRuntimeOptions,
  state: CancellationState,
  operation: Promise<T>,
  options: {
    runtime: PostgresMigrationRuntimeOptions
    state: CancellationState
    /** Runs one physical-session operation. */
    operation: () => Promise<T>
    stage: MigrationExecutionStage
    timeoutMs?: number
    timeoutMessage?: string
  },
  stage: MigrationExecutionStage,
): Promise<never> {
  const cleanupFailures = await cancelSession(runtime, state, operation)

  if (result === 'timeout') {
    throw new PostgresMigrationLockTimeoutError(
      options.timeoutMessage ??
        `Timed out acquiring the migration advisory lock after ${runtime.lockTimeoutMs}ms`,
      stage,
      cleanupFailures,
    )
  }

  throw new PostgresMigrationSignalAbortedError(
    'Migration execution was aborted',
    stage,
    cleanupFailures,
  )
}

/**
 * Creates and clears the watchdog timer used to interrupt a physical operation.
 *
 * @param timeoutMs - Milliseconds before the current operation's watchdog interrupts it.
 * @param runtime - Active operation and interruption controls shared by this run.
 *
 * @returns Controls for the operation watchdog and abort listener, including their
 *   cleanup.
 */
function armOperationInterruption(
  timeoutMs: number | undefined,
  runtime: PostgresMigrationRuntimeOptions,
) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const interrupted = new Promise<'timeout' | 'abort'>((resolve) => {
    if (timeoutMs !== undefined) timer = setTimeout(() => resolve('timeout'), timeoutMs)

    if (runtime.signal) {
      abort = () => resolve('abort')
      runtime.signal.addEventListener('abort', abort, { once: true })
    }
  })

  return { interrupted, timer, abort }
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

  sessionCancelled = await releaseCancelledLocks(
    state,
    acquired,
    options,
    cleanupFailures,
    sessionCancelled,
  )

  if (!sessionCancelled) cleanupFailures.push(...(await cancelSession(options, state)))

  if (timeout) {
    throw new PostgresMigrationLockTimeoutError(
      options.lockTimeoutMs === 0
        ? 'Migration advisory lock was not available after one no-wait try'
        : `Timed out acquiring the migration advisory lock after ${options.lockTimeoutMs}ms`,
      stage,
      cleanupFailures,
    )
  }

  throw new PostgresMigrationSignalAbortedError(
    'Migration execution was aborted',
    stage,
    cleanupFailures,
  )
}

/**
 * Attempts acquired-lock cleanup after cancellation and retains every cleanup failure.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param acquired - Confirmed advisory-lock identities recorded in acquisition order.
 * @param options - Configuration and dependencies for this operation.
 * @param cleanupFailures - Mutable cleanup evidence accumulated without replacing the
 *   primary rejection.
 * @param sessionCancelled - Whether active physical-session work has already been
 *   canceled.
 *
 * @returns True when release cancelled locks applies to the supplied input.
 */
async function releaseCancelledLocks(
  state: CancellationState,
  acquired: readonly Readonly<{
    kind: 'database' | 'scoped'
    classId: number
    lockId: number
    canonicalIdentity: string
  }>[],
  options: PostgresMigrationRuntimeOptions,
  cleanupFailures: Readonly<{
    stage: 'rollback' | 'unlock' | 'sessionCleanup'
    cause: unknown
  }>[],
  sessionCancelled: boolean,
) {
  const releasable = state.sessionUncertain ? [] : [...acquired].reverse()

  for (const identity of releasable) {
    try {
      const failures = await runCancellable({
        runtime: options,
        state,
        stage: 'unlock',
        timeoutMs: POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS,
        timeoutMessage: `Timed out waiting ${POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS}ms for partial migration lock release`,
        /** Releases confirmed advisory locks with cancellation controls. */
        operation: () => releaseCoordinationFailures(options, [identity]),
      })

      cleanupFailures.push(...failures)
    } catch (cause) {
      cleanupFailures.push({ stage: 'unlock', cause })

      cleanupFailures.push(
        ...(cause instanceof PostgresMigrationCancellationError
          ? cause.cleanupFailures
          : []),
      )

      sessionCancelled = cause instanceof PostgresMigrationCancellationError
    }

    if (sessionCancelled) break
  }

  return sessionCancelled
}

/**
 * Polls one advisory lock under the shared deadline and records confirmed acquisition.
 *
 * @param options - Configuration and dependencies for this operation.
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param acquired - Confirmed advisory-lock identities recorded in acquisition order.
 * @param deadline - Monotonic time at which the overall lock-acquisition wait expires.
 */
async function acquireCoordinationLock(
  options: PostgresMigrationRuntimeOptions,
  state: CancellationState,
  identity: PostgresAdvisoryLockIdentity,
  acquired: PostgresAdvisoryLockIdentity[],
  deadline: number,
): Promise<void> {
  let firstAttempt = true

  for (;;) {
    const { timeout, deadlineRemaining } = await coordinationAttemptTimeout(
      deadline,
      options,
      firstAttempt,
      state,
      acquired,
    )

    const row = await attemptCoordinationLock(
      options,
      state,
      timeout,
      deadlineRemaining,
      identity,
    )

    firstAttempt = false

    if (typeof row !== 'object' || row === null || !('locked' in row)) {
      state.sessionUncertain = true
      throw new InvariantError(
        'PostgreSQL did not return a migration advisory lock result',
      )
    }

    if (row.locked === true) {
      acquired.push(identity)
      return
    }

    if (row.locked !== false) {
      state.sessionUncertain = true
      throw new InvariantError(
        'PostgreSQL returned an invalid migration advisory lock result',
      )
    }

    await awaitCoordinationRetry(options, state, acquired, deadline)
  }
}

/**
 * Computes the next lock-attempt timeout without extending the overall deadline.
 *
 * @param deadline - Monotonic time at which the overall lock-acquisition wait expires.
 * @param options - Configuration and dependencies for this operation.
 * @param firstAttempt - Whether acquisition is making its initial nonblocking lock
 *   attempt.
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param acquired - Confirmed advisory-lock identities recorded in acquisition order.
 *
 * @returns The next lock-attempt timeout in milliseconds within the shared deadline.
 */
async function coordinationAttemptTimeout(
  deadline: number,
  options: PostgresMigrationRuntimeOptions,
  firstAttempt: boolean,
  state: CancellationState,
  acquired: Readonly<{
    kind: 'database' | 'scoped'
    classId: number
    lockId: number
    canonicalIdentity: string
  }>[],
) {
  const deadlineRemaining = Math.max(0, deadline - performance.now())
  const timeout =
    options.lockTimeoutMs === 0
      ? POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS
      : Math.min(POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS, deadlineRemaining)

  if (!firstAttempt && performance.now() >= deadline) {
    await stopCancelled(options, state, 'lock', true, acquired)
  }

  if (options.signal?.aborted) {
    await stopCancelled(options, state, 'lock', false, acquired)
  }

  return { timeout, deadlineRemaining }
}

/**
 * Waits between lock attempts while honoring cancellation and the shared deadline.
 *
 * @param options - Configuration and dependencies for this operation.
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param acquired - Confirmed advisory-lock identities recorded in acquisition order.
 * @param deadline - Monotonic time at which the overall lock-acquisition wait expires.
 */
async function awaitCoordinationRetry(
  options: PostgresMigrationRuntimeOptions,
  state: CancellationState,
  acquired: Readonly<{
    kind: 'database' | 'scoped'
    classId: number
    lockId: number
    canonicalIdentity: string
  }>[],
  deadline: number,
) {
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

  const wait = waitForLockPoll(options.signal, waitRemaining)

  if ((await wait) === 'aborted') {
    await stopCancelled(options, state, 'lock', false, acquired)
  }
}

/**
 * Runs one cancellable advisory-lock acquisition and validates its native result.
 *
 * @param options - Configuration and dependencies for this operation.
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param timeout - Whether the current operation exhausted its deadline.
 * @param deadlineRemaining - Milliseconds remaining before the shared lock deadline.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns Whether the native advisory-lock attempt acquired the requested lock.
 */
async function attemptCoordinationLock(
  options: PostgresMigrationRuntimeOptions,
  state: CancellationState,
  timeout: number,
  deadlineRemaining: number,
  identity: Readonly<{
    kind: 'database' | 'scoped'
    classId: number
    lockId: number
    canonicalIdentity: string
  }>,
) {
  let row

  try {
    ;[row] = await runCancellable({
      runtime: options,
      state,
      stage: 'lock',
      timeoutMs: timeout,
      timeoutMessage: lockAttemptTimeoutMessage(options.lockTimeoutMs, deadlineRemaining),
      /** Attempts nonblocking advisory-lock acquisition with cancellation controls. */
      operation: () =>
        options.executor.execute(
          {
            sql: 'select pg_try_advisory_lock($1, $2) as "locked"',
            params: [identity.classId, identity.lockId],
          },
          { source: 'coordination' },
        ),
    })
  } catch (cause) {
    // A query can have reached PostgreSQL before its error was observed.
    state.sessionUncertain = true
    throw cause
  }

  return row
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
async function acquireCoordination(
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
    mapPostgresAdvisoryLockIdentity,
  )

  const acquired: PostgresAdvisoryLockIdentity[] = []
  const deadline = performance.now() + options.lockTimeoutMs

  for (const identity of identities) {
    await acquireCoordinationLock(options, state, identity, acquired, deadline)
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
async function releaseCoordination(
  options: PostgresMigrationRuntimeOptions,
  identities: readonly PostgresAdvisoryLockIdentity[] = [
    {
      kind: 'database',
      classId: POSTGRES_MIGRATION_ADVISORY_LOCK_CLASS,
      lockId: POSTGRES_MIGRATION_ADVISORY_LOCK_ID,
      canonicalIdentity: 'stratom/migration/database/postgresql',
    },
  ],
): Promise<void> {
  const failures = await releaseCoordinationFailures(options, identities)

  if (failures.length > 0) throw failures[0].cause
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
async function releaseCoordinationFailures(
  options: PostgresMigrationRuntimeOptions,
  identities: readonly PostgresAdvisoryLockIdentity[] = [
    {
      kind: 'database',
      classId: POSTGRES_MIGRATION_ADVISORY_LOCK_CLASS,
      lockId: POSTGRES_MIGRATION_ADVISORY_LOCK_ID,
      canonicalIdentity: 'stratom/migration/database/postgresql',
    },
  ],
): Promise<MigrationCleanupFailure[]> {
  const failures: MigrationCleanupFailure[] = []

  for (const identity of [...identities].reverse()) {
    const release = await attempt(async () => {
      const [row] = await options.executor.execute(
        {
          sql: 'select pg_advisory_unlock($1, $2) as "unlocked"',
          params: [identity.classId, identity.lockId],
        },
        { source: 'coordination' },
      )

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
    })

    if (!release.ok) failures.push({ stage: 'unlock', cause: release.error })
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
async function assertPrecondition(
  options: PostgresMigrationRuntimeOptions,
  precondition: MigrationPrecondition,
): Promise<void> {
  const schema = schemaFromNamespace(precondition.relation.namespace)
  const relation = `${quoteIdentifier(schema)}.${quoteIdentifier(precondition.relation.relation.spelling)}`
  const [row] = await options.executor.execute(
    {
      sql: `select count(*)::int as count from ${relation} where ${quoteIdentifier(precondition.column)} is null`,
      params: [],
    },
    { source: 'catalog' },
  )

  const count = Number((row as { count?: unknown } | undefined)?.count ?? 0)

  if (count > 0) {
    throw new InvariantError(
      `Cannot set column '${schema}.${precondition.relation.relation.spelling}.${precondition.column}' as NOT NULL - column has NULL values`,
    )
  }
}

/**
 * Waits until the next lock poll or rejects promptly when the signal aborts.
 *
 * @param signal - Abort signal that interrupts lock waits or active physical work.
 * @param waitRemaining - Milliseconds to wait before the next advisory-lock attempt.
 *
 * @returns Elapsed or aborted status after the poll timer or abort signal settles.
 */
function waitForLockPoll(
  signal: AbortSignal | undefined,
  waitRemaining: number,
): Promise<'elapsed' | 'aborted'> {
  return new Promise<'elapsed' | 'aborted'>((resolve) => {
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', abort)
        resolve('elapsed')
      },
      Math.min(MIGRATION_LOCK_POLL_INTERVAL_MS, waitRemaining),
    )

    /** Rejects the pending lock-poll wait when cancellation is signaled. */
    const abort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      resolve('aborted')
    }

    signal?.addEventListener('abort', abort, { once: true })
  })
}

export type {
  PostgresMigrationRuntimeOptions,
  CancellationState,
  PostgresAdvisoryLockIdentity,
}

export {
  PostgresMigrationCancellationError,
  PostgresMigrationLockTimeoutError,
  PostgresMigrationSignalAbortedError,
  mapPostgresAdvisoryLockIdentity,
  POSTGRES_MIGRATION_SESSION_CALL_TIMEOUT_MS,
  runCancellable,
  acquireCoordination,
  releaseCoordination,
  releaseCoordinationFailures,
  assertPrecondition,
}
