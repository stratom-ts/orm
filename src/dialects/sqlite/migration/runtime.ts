import type {
  MigrationPrecondition,
  MigrationProgram,
  MigrationRuntimeOptions,
} from '@/ddl/migrationProgram'
import { migrationExecutionError } from '@/migrations/migrationDiagnostics'
import { MigrationOwnershipSchemaError } from '@/migrations/migrationOwnership'
import type { MigrationCleanupFailure, MigrationExecutionStage } from '@/utils/error'
import {
  DriverError,
  InvariantError,
  MigrationError,
  QueryError,
  SchemaError,
} from '@/utils/error'

import { sqliteClassifyDriverError } from '../classifyDriverError'
import { asciiFoldSqliteIdentifier } from '../identity'

import { SqliteMigrationCapabilityError } from './error'

const DEFAULT_LOCK_TIMEOUT_MS = 30_000
const RETRY_WAIT_MS = 10

type Failure = {
  cause: unknown
  stage: MigrationExecutionStage
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
}

type State = {
  transactionOpen: boolean
  ddlStarted: boolean
  committed: boolean
  commitAttempted: boolean
  rollbackAcknowledged: boolean
  uncertain: boolean
  busyTimeout?: number
  foreignKeys?: number
  primary?: Failure
  cleanupFailures: MigrationCleanupFailure[]
}

/** Keeps stage selection separate from outcome and provenance reconstruction. */
function failureStage(
  error: Failure,
  structured: MigrationError | undefined,
): MigrationExecutionStage {
  return error.stage === 'validation' ? 'validation' : (structured?.stage ?? error.stage)
}

/** Formats stage/action context and recognized diagnostics without native text. */
function failureMessage(
  error: Failure,
  stage: MigrationExecutionStage,
  actionIndex: number | undefined,
  structured: MigrationError | undefined,
): string {
  const cause = error.cause
  const detail =
    structured?.message ??
    (cause instanceof InvariantError || cause instanceof SqliteMigrationCapabilityError
      ? cause.message
      : undefined)

  const action = actionIndex === undefined ? '' : ` during action ${actionIndex + 1}`
  return `SQLite migration ${stage} failed${action}${detail === undefined ? '' : `: ${detail}`}`
}

/** Retains structured provenance while applying the known SQLite transaction outcome. */
function failure(
  error: Failure,
  outcome: 'unchanged' | 'rolledBack' | 'applied' | 'unknown',
  cleanupFailures: readonly MigrationCleanupFailure[],
  retryable = false,
): MigrationError {
  const structured = error.cause instanceof MigrationError ? error.cause : undefined
  const stage = failureStage(error, structured)

  return migrationExecutionError(error.cause, {
    message: (actionIndex) => failureMessage(error, stage, actionIndex, structured),
    defect:
      !(error.cause instanceof QueryError) &&
      !(error.cause instanceof DriverError) &&
      !(error.cause instanceof SchemaError),
    stage,
    outcome,
    retryable,
    actionIndex: error.actionIndex,
    sourceStepIndexes: error.sourceStepIndexes,
    capabilityIssues: undefined,
    cleanupFailures: cleanupFailures.length ? cleanupFailures : undefined,
  })
}

/** Reports an abort only between synchronous native calls. */
function assertNotAborted(
  options: MigrationRuntimeOptions,
  stage: MigrationExecutionStage,
): void {
  if (options.signal?.aborted)
    throw new MigrationError({
      message: 'SQLite migration was aborted',
      stage,
      outcome: 'unchanged',
      retryable: true,
    })
}

/** Waits briefly for a competing writer, or returns promptly on abort. */
async function retryWait(
  options: MigrationRuntimeOptions,
  deadline: number,
): Promise<void> {
  const duration = Math.min(RETRY_WAIT_MS, Math.max(0, deadline - performance.now()))

  if (!duration) return

  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', finish)
      resolve()
    }

    const timer = setTimeout(finish, duration)
    options.signal?.addEventListener('abort', finish, { once: true })
  })
}

/** Executes one SQL command on the pinned session. */
async function run(options: MigrationRuntimeOptions, sql: string): Promise<void> {
  await options.executor.run({ sql, params: [] })
}

/** Reads the current native busy policy before temporarily using nonblocking attempts. */
async function readBusyTimeout(options: MigrationRuntimeOptions): Promise<number> {
  const rows = await options.executor.execute({ sql: 'pragma busy_timeout', params: [] })
  const value = (rows[0] as { timeout?: unknown } | undefined)?.timeout

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvariantError('SQLite did not report a valid busy_timeout')
  }

  return value
}

/** Attempts one nonblocking BEGIN and classifies BUSY separately. */
async function tryBegin(
  options: MigrationRuntimeOptions,
): Promise<{ busy: false } | { busy: true; cause: unknown }> {
  try {
    await run(options, 'begin immediate')
    return { busy: false }
  } catch (cause) {
    if (sqliteClassifyDriverError(cause).kind !== 'transient') throw cause

    return { busy: true, cause }
  }
}

/** Retries only BUSY or LOCKED failures until one monotonic deadline. */
async function attemptBegin(
  options: MigrationRuntimeOptions,
  deadline: number,
): Promise<void> {
  let attempted = false
  let lastBusy: unknown

  for (;;) {
    assertNotAborted(options, 'lock')

    if (attempted && performance.now() >= deadline)
      throw failure({ cause: lastBusy, stage: 'lock' }, 'unchanged', [], true)

    const result = await tryBegin(options)

    if (!result.busy) return

    attempted = true
    lastBusy = result.cause
    await retryWait(options, deadline)
  }
}

/** Takes the plan-atomic writer transaction before any preparation or DDL. */
async function acquire(options: MigrationRuntimeOptions, state: State): Promise<void> {
  const timeout = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS

  if (!Number.isFinite(timeout) || timeout < 0) {
    state.primary = {
      cause: new InvariantError('Invalid SQLite lock timeout'),
      stage: 'lock',
    }
    return
  }

  const deadline = performance.now() + timeout
  try {
    assertNotAborted(options, 'lock')
    state.busyTimeout = await readBusyTimeout(options)
    state.foreignKeys = await readForeignKeys(options)
    await run(options, 'pragma foreign_keys=off')

    if ((await readForeignKeys(options)) !== 0)
      throw new InvariantError('SQLite FK enforcement could not be disabled before BEGIN')

    await run(options, 'pragma busy_timeout=0')
    await attemptBegin(options, deadline)
    state.transactionOpen = true
  } catch (cause) {
    state.primary = { cause, stage: 'lock' }

    if (!(cause instanceof MigrationError && cause.retryable)) {
      state.uncertain = true
      options.discard()
    }
  }
}

/** Rejects programs whose actions cannot run in the writer transaction. */
function validateProgram(program: MigrationProgram): void {
  if (program.atomicity !== 'plan-atomic')
    throw new MigrationError({
      message: 'SQLite migration requires plan-atomic programs',
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
    })

  for (const action of program.actions) {
    if (action.transaction !== 'required' && action.transaction !== 'allowed') {
      throw new MigrationError({
        message: 'SQLite migration action cannot run in a transaction',
        stage: 'lowering',
        outcome: 'unchanged',
        retryable: false,
        sourceStepIndexes: action.sourceStepIndexes,
      })
    }
  }
}

/** Quotes one identifier without treating dots or quotes as separators. */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/** Checks the structured main relation target and its authoritative NULL count. */
async function assertPrecondition(
  options: MigrationRuntimeOptions,
  precondition: MigrationPrecondition,
): Promise<void> {
  const segment = precondition.relation.namespace[0]
  const table = precondition.relation.relation.spelling

  if (
    precondition.relation.namespace.length !== 1 ||
    segment.role !== 'database' ||
    asciiFoldSqliteIdentifier(segment.identifier.spelling) !== 'main' ||
    segment.identifier.comparisonKey !== 'main' ||
    precondition.relation.relation.comparisonKey !== asciiFoldSqliteIdentifier(table) ||
    !table ||
    !precondition.column
  ) {
    throw new MigrationError({
      message: 'Invalid SQLite main relation precondition target',
      stage: 'precondition',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes: precondition.sourceStepIndexes,
    })
  }

  const rows = await options.executor.execute({
    sql: `select count(*) as count from "main".${quoteIdentifier(table)} where ${quoteIdentifier(precondition.column)} is null`,
    params: [],
  })

  const count = (rows[0] as { count?: unknown } | undefined)?.count

  if (typeof count !== 'number' && typeof count !== 'bigint')
    throw new InvariantError('SQLite returned an invalid NULL count')

  if (count < 0 || !Number.isSafeInteger(Number(count)))
    throw new InvariantError('SQLite returned an invalid NULL count')

  if (count > 0)
    throw new MigrationError({
      message: `Column ${quoteIdentifier(precondition.column)} contains NULL values`,
      stage: 'precondition',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes: precondition.sourceStepIndexes,
    })
}

/** Runs all statements of one physical action in order. */
async function runAction(
  options: MigrationRuntimeOptions,
  state: State,
  action: MigrationProgram['actions'][number],
): Promise<void> {
  for (const statement of action.statements) {
    assertNotAborted(options, 'ddl')
    state.ddlStarted = true
    await options.executor.run(statement)
  }
}

/** Runs preconditions and ordered DDL after whole-program validation. */
async function executeProgram(
  options: MigrationRuntimeOptions,
  state: State,
  program: MigrationProgram,
): Promise<void> {
  for (const precondition of program.preconditions) {
    try {
      assertNotAborted(options, 'precondition')
      await assertPrecondition(options, precondition)
    } catch (cause) {
      state.primary = {
        cause,
        stage: 'precondition',
        sourceStepIndexes: precondition.sourceStepIndexes,
      }
      return
    }
  }

  for (const [actionIndex, action] of program.actions.entries()) {
    try {
      await runAction(options, state, action)
    } catch (cause) {
      state.primary = {
        cause,
        stage: 'ddl',
        actionIndex,
        sourceStepIndexes: action.sourceStepIndexes,
      }
      return
    }
  }
}

/** Prepares inside the transaction and executes only a validated program. */
async function prepareAndExecute(
  options: MigrationRuntimeOptions,
  state: State,
): Promise<void> {
  if (state.primary) return

  try {
    assertNotAborted(options, 'introspection')
    const program = await options.prepare()
    assertNotAborted(options, 'introspection')
    validateProgram(program)
    await executeProgram(options, state, program)
    await validateFinalState(options, state, program)
  } catch (cause) {
    state.primary = {
      cause,
      stage:
        cause instanceof MigrationError && cause.stage
          ? cause.stage
          : cause instanceof MigrationOwnershipSchemaError
            ? 'planning'
            : 'introspection',
    }
  }
}

/** Reads the native FK policy before following SQLite's documented rebuild sequence. */
async function readForeignKeys(options: MigrationRuntimeOptions): Promise<number> {
  const rows = await options.executor.execute({ sql: 'pragma foreign_keys', params: [] })
  const value = (rows[0] as { foreign_keys?: unknown } | undefined)?.foreign_keys

  if (value !== 0 && value !== 1)
    throw new InvariantError('SQLite did not report a valid foreign_keys policy')

  return value
}

/**
 * Checks referential integrity, storage integrity and desired-state convergence before
 * commit.
 */
async function validateFinalState(
  options: MigrationRuntimeOptions,
  state: State,
  program: MigrationProgram,
): Promise<void> {
  if (state.primary) return

  try {
    assertNotAborted(options, 'validation')
    const foreign = await options.executor.execute({
      sql: 'pragma main.foreign_key_check',
      params: [],
    })

    if (foreign.length) throw new InvariantError('SQLite foreign_key_check failed')

    const integrity = await options.executor.execute({
      sql: 'pragma main.integrity_check',
      params: [],
    })

    if (
      integrity.length !== 1 ||
      (integrity[0] as { integrity_check?: unknown }).integrity_check !== 'ok'
    )
      throw new InvariantError('SQLite integrity_check failed')

    await options.validate?.()
  } catch (cause) {
    state.primary = {
      cause,
      stage: 'validation',
      sourceStepIndexes: [
        ...new Set(program.actions.flatMap((action) => action.sourceStepIndexes)),
      ].sort((left, right) => left - right),
    }
  }
}

/** Attempts commit once and marks uncertain acknowledgement without rollback. */
async function attemptCommit(
  options: MigrationRuntimeOptions,
  state: State,
): Promise<void> {
  try {
    assertNotAborted(options, 'commit')
    state.commitAttempted = true
    await run(options, 'commit')
    state.committed = true
    state.transactionOpen = false
  } catch (cause) {
    if (state.commitAttempted) {
      state.uncertain = true
      state.transactionOpen = false
      options.discard()
    }

    state.primary = { cause, stage: 'commit' }
  }
}

/** A commit failure crosses the outcome boundary; rollback is then unsafe. */
async function finishTransaction(
  options: MigrationRuntimeOptions,
  state: State,
): Promise<void> {
  if (!state.transactionOpen) return
  if (!state.primary) await attemptCommit(options, state)
  if (state.committed || state.uncertain) return

  try {
    await run(options, 'rollback')
    state.rollbackAcknowledged = true
    state.transactionOpen = false
  } catch (cause) {
    state.uncertain = true
    state.transactionOpen = false
    state.cleanupFailures.push({ stage: 'rollback', cause })
    options.discard()
  }
}

/** Restores busy policy only while the native session remains safe to use. */
async function restoreBusyTimeout(
  options: MigrationRuntimeOptions,
  state: State,
): Promise<void> {
  if (
    state.busyTimeout === undefined ||
    state.uncertain ||
    options.signal?.aborted ||
    state.transactionOpen
  )
    return

  try {
    await run(options, `pragma busy_timeout=${state.busyTimeout}`)
  } catch (cause) {
    state.cleanupFailures.push({ stage: 'sessionCleanup', cause })
    options.discard()
  }
}

/** Restores the original FK policy only after a known commit or rollback acknowledgement. */
async function restoreForeignKeys(
  options: MigrationRuntimeOptions,
  state: State,
): Promise<void> {
  if (
    state.foreignKeys === undefined ||
    state.uncertain ||
    options.signal?.aborted ||
    state.transactionOpen
  )
    return

  try {
    await run(options, `pragma foreign_keys=${state.foreignKeys}`)

    if ((await readForeignKeys(options)) !== state.foreignKeys)
      throw new InvariantError('SQLite FK policy restoration failed')
  } catch (cause) {
    state.cleanupFailures.push({ stage: 'sessionCleanup', cause })
    options.discard()
  }
}

/** Classifies the known effect and preserves primary and cleanup evidence. */
function outcome(state: State): { outcome: 'applied' | 'unchanged' } {
  const success = state.committed && state.ddlStarted ? 'applied' : 'unchanged'

  if (state.primary) {
    const effect =
      state.commitAttempted || (state.ddlStarted && !state.rollbackAcknowledged)
        ? 'unknown'
        : state.ddlStarted
          ? 'rolledBack'
          : 'unchanged'

    if (
      state.primary.cause instanceof SchemaError &&
      effect === 'unchanged' &&
      state.cleanupFailures.length === 0
    )
      throw state.primary.cause

    throw failure(state.primary, effect, state.cleanupFailures)
  }

  if (state.cleanupFailures.length) {
    const cleanup = state.cleanupFailures[0]!
    throw failure(
      { cause: cleanup.cause, stage: cleanup.stage },
      success,
      state.cleanupFailures,
    )
  }

  return { outcome: success }
}

/** Runs one plan-atomic SQLite migration under BEGIN IMMEDIATE coordination. */
export async function executeSqliteMigration(
  options: MigrationRuntimeOptions,
): Promise<{ outcome: 'applied' | 'unchanged' }> {
  const state: State = {
    transactionOpen: false,
    ddlStarted: false,
    committed: false,
    commitAttempted: false,
    rollbackAcknowledged: false,
    uncertain: false,
    cleanupFailures: [],
  }

  await acquire(options, state)
  await prepareAndExecute(options, state)
  await finishTransaction(options, state)

  if (options.signal?.aborted) {
    options.discard()

    await options.cancel().catch((cause: unknown) => {
      state.cleanupFailures.push({ stage: 'sessionCleanup', cause })
    })
  }

  await restoreBusyTimeout(options, state)
  await restoreForeignKeys(options, state)
  return outcome(state)
}
