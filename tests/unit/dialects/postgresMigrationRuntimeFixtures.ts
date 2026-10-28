import { vi } from 'vitest'

import type { MigrationProgram } from '@/ddl/migrationProgram'
import { executePostgresMigration } from '@/dialects/postgres/migration'
import type { Executor } from '@/query'

import type {
  CoordinationContractEvent,
  CoordinationContractLockManager,
} from './migrationCoordinationContract'

/** Builds a plan-atomic PostgreSQL migration program with optional scenario overrides. */
export function postgresMigrationProgram(
  overrides: Partial<MigrationProgram> = {},
): MigrationProgram {
  return {
    atomicity: 'plan-atomic',
    preconditions: [],
    actions: [
      {
        sourceStepIndexes: [4],
        transaction: 'required',
        statements: [{ sql: 'create table events (id integer)', params: [] }],
      },
    ],
    ...overrides,
  }
}

/** Validates and serializes the two numeric advisory-lock parameters. */
function advisoryLockKey(params: unknown[]): string {
  const [classId, lockId] = params

  if (typeof classId !== 'number' || typeof lockId !== 'number') {
    throw new TypeError('PostgreSQL advisory lock parameters must be numbers')
  }

  return `${classId}:${lockId}`
}

/**
 * Creates a PostgreSQL migration runtime with semantic events and controlled coordination
 * outcomes.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A PostgreSQL migration runtime with semantic events and controlled
 *   coordination outcomes.
 */
export function createPostgresMigrationRuntime(
  options: MigrationRuntimeFixtureOptions = {},
) {
  const calls: string[] = []
  const queries: { sql: string; params: unknown[] }[] = []
  const discard = vi.fn<() => void>()
  const prepare = vi.fn<(program: MigrationProgram) => Promise<MigrationProgram>>(
    async (migrationProgram: MigrationProgram) => migrationProgram,
  )

  const { held, releaseHold } = createRuntimeHold(options)
  const { hang, cancel } = createInFlightCancellation()

  /** Applies the fixture's configured lock-acquisition outcome. */
  const acquire = (query: { sql: string; params: unknown[] }) =>
    acquireFixtureLock(query, options)

  /** Releases the fixture lease with configured cleanup behavior. */
  const release = (query: { sql: string; params: unknown[] }) =>
    releaseFixtureLock(query, options)

  const executor: Executor = createMigrationRuntimeExecutor(
    calls,
    queries,
    held,
    options,
    hang,
    acquire,
    release,
  )

  const execute = createRuntimeFixtureRunner(options, executor, discard, cancel, prepare)

  const semanticEvent = classifyFixtureEvent

  /** Returns semantic operation events recorded by the fixture. */
  const events = () => queries.map(semanticEvent)
  return {
    calls,
    queries,
    cancel,
    discard,
    execute,
    prepare,
    events,
    /** Releases the fixture transaction's synchronization hold. */
    releaseHold: () => releaseHold?.(),
    /** Waits until the fixture records the requested semantic coordination event. */
    waitFor: (event: CoordinationContractEvent) =>
      waitForCoordinationEvent(events, event),
  }
}

/**
 * Creates a deterministic transaction hold and exposes its release callback.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A deterministic transaction hold and exposes its release callback.
 */
function createRuntimeHold(options: MigrationRuntimeFixtureOptions) {
  let releaseHold: (() => void) | undefined
  const held = options.holdAfterTransaction
    ? new Promise<void>((resolve) => {
        releaseHold = resolve
      })
    : undefined

  return { held, releaseHold }
}

/**
 * Creates runtime controls that expose protected-work order and held transaction phases.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param discard - Callback that prevents reuse of the current physical session.
 * @param cancel - Callback that interrupts the current physical-session operation.
 * @param prepare - Callback that supplies a db0 statement for native SQL execution.
 *
 * @returns Runtime controls that expose protected-work order and held transaction phases.
 */
function createRuntimeFixtureRunner(
  options: MigrationRuntimeFixtureOptions,
  executor: Executor,
  discard: () => void,
  cancel: () => Promise<void>,
  prepare: (program: MigrationProgram) => Promise<MigrationProgram>,
) {
  return (
    migrationProgram = options.noWork
      ? postgresMigrationProgram({ actions: [] })
      : postgresMigrationProgram(),
    runtimeOptions: { signal?: AbortSignal; lockTimeoutMs?: number } = {},
  ) =>
    executePostgresMigration({
      executor,
      databaseIdentity: 'test',
      ...(options.applicationId === undefined
        ? {}
        : { applicationId: options.applicationId }),
      lockTimeoutMs: runtimeOptions.lockTimeoutMs ?? 1000,
      ...(runtimeOptions.signal === undefined ? {} : { signal: runtimeOptions.signal }),
      discard,
      cancel,
      /** Prepares the fixture statement for the supplied SQL. */
      prepare: () => {
        if (Object.hasOwn(options, 'prepareFailure')) throw options.prepareFailure

        return prepare(migrationProgram)
      },
    })
}

/**
 * Supplies physical query results and records runtime events for the migration fixture.
 *
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 * @param queries - Native catalog queries or recorded executor calls in observation
 *   order.
 * @param held - Whether fixture coordination is configured to remain held.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param hang - Callback that starts work suspended until cancellation.
 * @param acquire - Callback implementing fixture advisory-lock acquisition.
 * @param release - Callback that releases the fixture hold or lock.
 *
 * @returns Physical query results and records runtime events for the migration fixture.
 */
function createMigrationRuntimeExecutor(
  calls: string[],
  queries: { sql: string; params: unknown[] }[],
  held: Promise<void> | undefined,
  options: MigrationRuntimeFixtureOptions,
  hang: () => Promise<never>,
  acquire: (query: { sql: string; params: unknown[] }) => Promise<{ locked: boolean }[]>,
  release: (query: { sql: string; params: unknown[] }) => { unlocked: boolean }[],
): Executor {
  return {
    /** Runs a fixture statement with configured outcomes. */
    async run(query) {
      calls.push(query.sql)
      queries.push(query)

      if (/^begin\b/i.test(query.sql) && held !== undefined) await held
      if (options.hangRun?.test(query.sql)) await hang()
      if (options.failRun?.test(query.sql)) throw new Error(`failed: ${query.sql}`)
    },
    /** Executes fixture SQL with the configured native observations. */
    execute: (query) =>
      executeRuntimeFixture(query, calls, queries, options, hang, acquire, release),
  }
}

/**
 * Creates fixture controls for hanging native work until cancellation arrives.
 *
 * @returns Fixture controls for hanging native work until cancellation arrives.
 */
function createInFlightCancellation() {
  let rejectInFlight: ((cause: Error) => void) | undefined
  /** Starts native work that remains pending until fixture cancellation rejects it. */
  const hang = () =>
    new Promise<never>((_, reject) => {
      rejectInFlight = reject
    })

  const cancel = vi.fn<() => Promise<void>>(async () => {
    rejectInFlight?.(new Error('physical session cancelled'))
  })

  return { hang, cancel }
}

/**
 * Applies configured or shared fixture ownership rules to a migration lock attempt.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A native row reporting the configured or shared-manager lock outcome.
 */
async function acquireFixtureLock(
  query: { sql: string; params: unknown[] },
  options: NonNullable<Parameters<typeof createPostgresMigrationRuntime>[0]>,
) {
  if (options.lockGate !== undefined) await options.lockGate

  if (options.lockDelayMs !== undefined) {
    await new Promise((resolve) => setTimeout(resolve, options.lockDelayMs))
  }

  const configured = options.lockResults?.shift()
  const result =
    configured ??
    options.sharedLockManager?.tryAcquire(
      options.clientId ?? 'client',
      advisoryLockKey(query.params),
    ) ??
    true

  if (result instanceof Error) throw result

  return [{ locked: result }]
}

/**
 * Applies configured fixture release results and updates shared lock ownership.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A native row reporting the unlock outcome after shared ownership is released.
 */
function releaseFixtureLock(
  query: { sql: string; params: unknown[] },
  options: NonNullable<Parameters<typeof createPostgresMigrationRuntime>[0]>,
) {
  if (options.failUnlock) throw new Error('unlock failed')

  const result = options.releaseResults?.shift() ?? options.unlockResults?.shift()

  if (result instanceof Error) throw result

  options.sharedLockManager?.release(
    options.clientId ?? 'client',
    advisoryLockKey(query.params),
  )

  return [{ unlocked: result ?? true }]
}

/**
 * Maps physical SQL to the semantic events asserted by the coordination contract.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 *
 * @returns Physical SQL to the semantic events asserted by the coordination contract.
 */
function classifyFixtureEvent(query: { sql: string }): CoordinationContractEvent {
  if (/pg_try_advisory_lock/i.test(query.sql)) return 'acquire'
  if (/pg_advisory_unlock/i.test(query.sql)) return 'release'
  if (/^\s*(?:begin|commit|rollback)\b/i.test(query.sql)) return 'transaction'
  if (/count\(\*\)/i.test(query.sql)) return 'introspection'
  if (/create table/i.test(query.sql)) return 'ddl'

  return 'unclassified'
}

type MigrationRuntimeFixtureOptions = {
  prepareFailure?: unknown
  failRun?: RegExp
  failUnlock?: boolean
  unlockResults?: (boolean | Error)[]
  releaseResults?: (boolean | Error)[]
  applicationId?: string
  clientId?: string
  noWork?: boolean
  holdAfterTransaction?: boolean
  sharedLockManager?: CoordinationContractLockManager
  nullCount?: number
  lockResults?: (boolean | Error)[]
  lockGate?: Promise<void>
  lockDelayMs?: number
  hangQuery?: RegExp
  hangRun?: RegExp
}

/**
 * Executes the fixture migration and records its semantic coordination events.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 * @param queries - Native catalog queries or recorded executor calls in observation
 *   order.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param hang - Callback that starts work suspended until cancellation.
 * @param acquire - Callback implementing fixture advisory-lock acquisition.
 * @param release - Callback that releases the fixture hold or lock.
 *
 * @returns Fixture rows or command result after recording the semantic event.
 */
async function executeRuntimeFixture(
  query: Parameters<Executor['execute']>[0],
  calls: string[],
  queries: { sql: string; params: unknown[] }[],
  options: MigrationRuntimeFixtureOptions,
  hang: () => Promise<never>,
  acquire: (query: { sql: string; params: unknown[] }) => Promise<{ locked: boolean }[]>,
  release: (query: { sql: string; params: unknown[] }) => { unlocked: boolean }[],
) {
  calls.push(query.sql)
  queries.push(query)

  if (options.hangQuery?.test(query.sql)) await hang()

  if (/pg_try_advisory_lock/i.test(query.sql)) return acquire(query)
  if (/pg_advisory_unlock/i.test(query.sql)) return release(query)
  if (/count\(\*\)/i.test(query.sql)) return [{ count: options.nullCount ?? 0 }]

  return []
}

/**
 * Waits until the runtime records the requested coordination event.
 *
 * @param events - Reads the current semantic event sequence.
 * @param event - Event required before the scenario may proceed.
 */
async function waitForCoordinationEvent(
  events: () => (CoordinationContractEvent | undefined)[],
  event: CoordinationContractEvent,
): Promise<void> {
  while (!events().includes(event)) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}
