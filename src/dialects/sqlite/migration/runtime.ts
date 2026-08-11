import type {
  MigrationPrecondition,
  MigrationRuntimeOptions,
} from '@/ddl/migrationProgram'
import type { MigrationCleanupFailure, MigrationExecutionStage } from '@/utils/error'
import { MigrationError } from '@/utils/error'

const RETRY_WAIT_MS = 10

function primaryCause(cause: unknown): unknown {
  return cause instanceof MigrationError && cause.cause !== undefined
    ? cause.cause
    : cause
}

function executionError(options: {
  cause: unknown
  stage: MigrationExecutionStage
  outcome: 'unchanged' | 'rolledBack' | 'applied' | 'unknown'
  retryable: boolean
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
  cleanupFailures?: readonly MigrationCleanupFailure[]
}): MigrationError {
  const structured = options.cause instanceof MigrationError ? options.cause : undefined
  const cleanupFailures = [
    ...(structured?.cleanupFailures ?? []),
    ...(options.cleanupFailures ?? []),
  ]
  const outcome = options.outcome
  return new MigrationError({
    message:
      options.cause instanceof Error ? options.cause.message : 'SQLite migration failed',
    cause: primaryCause(options.cause),
    stage: structured?.stage ?? options.stage,
    outcome,
    retryable:
      outcome === 'unknown' ? false : (structured?.retryable ?? options.retryable),
    ...(options.actionIndex === undefined && structured?.actionIndex === undefined
      ? {}
      : { actionIndex: options.actionIndex ?? structured?.actionIndex }),
    ...(options.sourceStepIndexes === undefined &&
    structured?.sourceStepIndexes === undefined
      ? {}
      : {
          sourceStepIndexes: options.sourceStepIndexes ?? structured?.sourceStepIndexes,
        }),
    ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
  })
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function isBusy(cause: unknown): boolean {
  const seen = new Set<object>()
  let current: unknown = cause
  while (
    (typeof current === 'object' && current !== null) ||
    typeof current === 'function'
  ) {
    const object = current as Record<string, unknown>
    if (seen.has(object)) break
    seen.add(object)
    const code = object.code
    if (
      code === 'SQLITE_BUSY' ||
      code === 'SQLITE_LOCKED' ||
      code === 'SQLITE_BUSY_SNAPSHOT' ||
      code === 'SQLITE_LOCKED_SHAREDCACHE'
    ) {
      return true
    }
    for (const key of ['code', 'errcode', 'errno', 'sqliteCode', 'extendedErrcode']) {
      const numeric = object[key]
      if (
        typeof numeric === 'number' &&
        ((numeric & 0xff) === 5 || (numeric & 0xff) === 6)
      ) {
        return true
      }
    }
    current = object.cause
  }
  return false
}

function isCancelled(options: MigrationRuntimeOptions): boolean {
  return options.signal?.aborted === true
}

function cancelledError(stage: MigrationExecutionStage): MigrationError {
  return new MigrationError({
    message: 'SQLite migration was aborted',
    stage,
    outcome: 'unchanged',
    retryable: true,
  })
}

async function waitForRetry(
  options: MigrationRuntimeOptions,
  deadline: number,
): Promise<boolean> {
  const remaining = deadline - performance.now()
  if (remaining <= 0) return false
  if (isCancelled(options)) return false
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = setTimeout(finish, Math.min(RETRY_WAIT_MS, remaining))
    const abort = () => {
      clearTimeout(timer)
      finish()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
  })
  return !isCancelled(options) && performance.now() < deadline
}

function readBusyTimeout(rows: unknown[]): number {
  const value = (rows[0] as { timeout?: unknown } | undefined)?.timeout
  const timeout = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(timeout) || timeout < 0) {
    throw new Error('SQLite did not return a valid busy_timeout value')
  }
  return timeout
}

async function run(options: MigrationRuntimeOptions, sql: string): Promise<void> {
  await options.executor.run({ sql, params: [] })
}

async function executePrecondition(
  options: MigrationRuntimeOptions,
  precondition: MigrationPrecondition,
): Promise<void> {
  if (
    precondition.kind !== 'column_has_no_nulls' ||
    !Array.isArray(precondition.relation.namespace) ||
    precondition.relation.namespace.length !== 1 ||
    precondition.relation.namespace[0]?.role !== 'database' ||
    typeof precondition.relation.namespace[0]?.identifier?.spelling !== 'string' ||
    precondition.relation.namespace[0].identifier.spelling.length === 0 ||
    typeof precondition.relation.relation?.spelling !== 'string' ||
    precondition.relation.relation.spelling.length === 0 ||
    typeof precondition.column !== 'string' ||
    precondition.column.length === 0
  ) {
    throw new MigrationError({
      message: 'SQLite migration precondition has an invalid structured relation target',
      stage: 'precondition',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes: precondition.sourceStepIndexes,
    })
  }
  const relation = `${quoteIdentifier(precondition.relation.namespace[0]!.identifier.spelling)}.${quoteIdentifier(precondition.relation.relation.spelling)}`
  const [row] = await options.executor.execute({
    sql: `select count(*) as count from ${relation} where ${quoteIdentifier(precondition.column)} is null`,
    params: [],
  })
  const count = Number((row as { count?: unknown } | undefined)?.count)
  if (!Number.isFinite(count) || count < 0) {
    throw new Error('SQLite returned an invalid NULL-count precondition result')
  }
  if (count > 0) {
    throw new MigrationError({
      message: `Cannot set column '${precondition.relation.relation.spelling}.${precondition.column}' as NOT NULL - column has NULL values`,
      stage: 'precondition',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes: precondition.sourceStepIndexes,
    })
  }
}

/** Executes a plan-atomic SQLite migration coordinated by BEGIN IMMEDIATE. */
export async function executeSqliteMigration(
  options: MigrationRuntimeOptions,
): Promise<{ outcome: 'applied' | 'unchanged' }> {
  const deadline = performance.now() + Math.max(0, options.lockTimeoutMs)
  let originalBusyTimeout = 0
  let busyTimeoutKnown = false
  let transactionOpen = false
  let ddlStarted = false
  let rollbackAcknowledged = false
  let sessionUncertain = false
  let rollbackFailed = false
  let committed = false
  let commitAttempted = false
  let cancellationRequested = false
  let primary:
    | {
        cause: unknown
        stage: MigrationExecutionStage
        actionIndex?: number
        sourceStepIndexes?: readonly number[]
      }
    | undefined
  const cleanupFailures: MigrationCleanupFailure[] = []

  try {
    if (isCancelled(options)) throw cancelledError('lock')
    originalBusyTimeout = readBusyTimeout(
      await options.executor.execute({ sql: 'pragma busy_timeout', params: [] }),
    )
    busyTimeoutKnown = true
    await run(options, 'pragma busy_timeout=0')

    let began = false
    while (!began) {
      if (isCancelled(options)) throw cancelledError('lock')
      if (options.lockTimeoutMs !== 0 && performance.now() >= deadline) {
        throw new MigrationError({
          message: `Timed out acquiring the SQLite migration lock after ${options.lockTimeoutMs}ms`,
          stage: 'lock',
          outcome: 'unchanged',
          retryable: true,
        })
      }
      try {
        await run(options, 'begin immediate')
        began = true
        transactionOpen = true
      } catch (cause) {
        if (!isBusy(cause)) throw cause
        const retry =
          options.lockTimeoutMs !== 0 && (await waitForRetry(options, deadline))
        if (isCancelled(options)) throw cancelledError('lock')
        if (options.lockTimeoutMs === 0 || !retry) {
          throw new MigrationError({
            message:
              options.lockTimeoutMs === 0
                ? 'SQLite migration lock was not available after one no-wait try'
                : `Timed out acquiring the SQLite migration lock after ${options.lockTimeoutMs}ms`,
            cause,
            stage: 'lock',
            outcome: 'unchanged',
            retryable: true,
          })
        }
      }
    }

    if (isCancelled(options)) throw cancelledError('transaction')
    const program = await options.prepare()
    if (isCancelled(options)) throw cancelledError('introspection')
    if (program.atomicity !== 'plan-atomic') {
      throw new MigrationError({
        message: `SQLite migration requires plan-atomic programs; received ${program.atomicity}`,
        stage: 'lowering',
        outcome: 'unchanged',
        retryable: false,
      })
    }
    const forbidden = program.actions.find((action) => action.transaction === 'forbidden')
    if (forbidden) {
      throw new MigrationError({
        message:
          'SQLite plan-atomic migrations cannot execute forbidden-transaction actions',
        stage: 'lowering',
        outcome: 'unchanged',
        retryable: false,
        sourceStepIndexes: forbidden.sourceStepIndexes,
      })
    }
    for (const action of program.actions) {
      if (
        (action.transaction !== 'required' && action.transaction !== 'allowed') ||
        !Array.isArray(action.statements) ||
        action.statements.length === 0 ||
        action.statements.some(
          (statement) =>
            typeof statement?.sql !== 'string' ||
            statement.sql.length === 0 ||
            !Array.isArray(statement.params),
        )
      ) {
        throw new MigrationError({
          message: 'SQLite migration contains an invalid transaction-compatible action',
          stage: 'lowering',
          outcome: 'unchanged',
          retryable: false,
          sourceStepIndexes: action.sourceStepIndexes,
        })
      }
    }

    for (const precondition of program.preconditions) {
      if (isCancelled(options)) throw cancelledError('precondition')
      try {
        await executePrecondition(options, precondition)
      } catch (cause) {
        primary = {
          cause,
          stage:
            cause instanceof MigrationError && cause.stage ? cause.stage : 'precondition',
          sourceStepIndexes: precondition.sourceStepIndexes,
        }
        break
      }
    }

    if (!primary) {
      for (let actionIndex = 0; actionIndex < program.actions.length; actionIndex++) {
        const action = program.actions[actionIndex]!
        try {
          for (const statement of action.statements) {
            if (isCancelled(options)) throw cancelledError('ddl')
            ddlStarted = true
            await options.executor.run(statement)
          }
        } catch (cause) {
          primary = {
            cause,
            stage: cause instanceof MigrationError && cause.stage ? cause.stage : 'ddl',
            actionIndex,
            sourceStepIndexes: action.sourceStepIndexes,
          }
          break
        }
      }
    }

    if (!primary) {
      if (isCancelled(options)) throw cancelledError('transaction')
      try {
        commitAttempted = true
        await run(options, 'commit')
        transactionOpen = false
        committed = true
      } catch (cause) {
        transactionOpen = false
        sessionUncertain = true
        options.discard()
        primary = { cause, stage: 'commit' }
      }
    }
  } catch (cause) {
    if (!primary) {
      primary = {
        cause,
        stage:
          cause instanceof MigrationError && cause.stage
            ? cause.stage
            : transactionOpen
              ? 'lowering'
              : 'lock',
      }
    }
  }

  if (transactionOpen && !committed) {
    try {
      await run(options, 'rollback')
      transactionOpen = false
      rollbackAcknowledged = true
    } catch (cause) {
      transactionOpen = false
      rollbackFailed = true
      sessionUncertain = true
      cleanupFailures.push({ stage: 'rollback', cause })
      options.discard()
    }
  }

  const poisoned = isCancelled(options)
  if (poisoned && !cancellationRequested) {
    cancellationRequested = true
    try {
      await options.cancel()
    } catch (cause) {
      cleanupFailures.push({ stage: 'sessionCleanup', cause })
      options.discard()
    }
    options.discard()
  }

  if (busyTimeoutKnown && !poisoned && !sessionUncertain && !rollbackFailed) {
    try {
      await run(options, `pragma busy_timeout=${Math.trunc(originalBusyTimeout)}`)
    } catch (cause) {
      cleanupFailures.push({ stage: 'sessionCleanup', cause })
      options.discard()
    }
  }

  if (primary) {
    const structured = primary.cause instanceof MigrationError ? primary.cause : undefined
    const stage = structured?.stage ?? primary.stage
    const outcome = commitAttempted
      ? 'unknown'
      : !ddlStarted
        ? 'unchanged'
        : rollbackAcknowledged
          ? 'rolledBack'
          : 'unknown'
    if (
      stage === 'lock' &&
      !poisoned &&
      !(
        structured?.retryable === true &&
        cleanupFailures.every((failure) => failure.stage !== 'sessionCleanup')
      )
    ) {
      options.discard()
    }
    throw executionError({
      ...primary,
      stage,
      outcome,
      retryable: outcome !== 'unknown' && (structured?.retryable ?? false),
      cleanupFailures,
    })
  }
  if (cleanupFailures.length > 0) {
    throw executionError({
      cause: cleanupFailures[0]!.cause,
      stage: cleanupFailures[0]!.stage,
      outcome: committed && ddlStarted ? 'applied' : 'unchanged',
      retryable: false,
      cleanupFailures,
    })
  }
  return { outcome: committed && ddlStarted ? 'applied' : 'unchanged' }
}
