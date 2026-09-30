import { vi } from 'vitest'

import type { MigrationProgram } from '@/ddl/migrationProgram'
import { executePostgresMigration } from '@/dialects/postgres/migration'
import type { Executor } from '@/query'

import type {
  CoordinationContractEvent,
  CoordinationContractLockManager,
} from '../dialects/migrationCoordinationContract'

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

function advisoryLockKey(params: unknown[]): string {
  const [classId, lockId] = params

  if (typeof classId !== 'number' || typeof lockId !== 'number') {
    throw new TypeError('PostgreSQL advisory lock parameters must be numbers')
  }

  return `${classId}:${lockId}`
}

export function createPostgresMigrationRuntime(
  options: {
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
  } = {},
) {
  const calls: string[] = []
  const queries: { sql: string; params: unknown[] }[] = []
  const discard = vi.fn()
  const prepare = vi.fn(async (migrationProgram: MigrationProgram) => migrationProgram)
  let releaseHold: (() => void) | undefined
  const held = options.holdAfterTransaction
    ? new Promise<void>((resolve) => {
        releaseHold = resolve
      })
    : undefined
  let rejectInFlight: ((cause: Error) => void) | undefined
  const hang = () =>
    new Promise<never>((_, reject) => {
      rejectInFlight = reject
    })
  const cancel = vi.fn(async () => {
    rejectInFlight?.(new Error('physical session cancelled'))
  })

  async function acquire(query: { sql: string; params: unknown[] }) {
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

  function release(query: { sql: string; params: unknown[] }) {
    if (options.failUnlock) throw new Error('unlock failed')

    const result = options.releaseResults?.shift() ?? options.unlockResults?.shift()

    if (result instanceof Error) throw result

    options.sharedLockManager?.release(
      options.clientId ?? 'client',
      advisoryLockKey(query.params),
    )

    return [{ unlocked: result ?? true }]
  }

  const executor: Executor = {
    async run(query) {
      calls.push(query.sql)
      queries.push(query)

      if (/^begin\b/i.test(query.sql) && held !== undefined) await held
      if (options.hangRun?.test(query.sql)) await hang()
      if (options.failRun?.test(query.sql)) throw new Error(`failed: ${query.sql}`)
    },
    async execute(query) {
      calls.push(query.sql)
      queries.push(query)

      if (options.hangQuery?.test(query.sql)) await hang()

      if (/pg_try_advisory_lock/i.test(query.sql)) return acquire(query)
      if (/pg_advisory_unlock/i.test(query.sql)) return release(query)
      if (/count\(\*\)/i.test(query.sql)) return [{ count: options.nullCount ?? 0 }]

      return []
    },
  }
  const execute = (
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
      lockTimeoutMs: runtimeOptions.lockTimeoutMs ?? 1_000,
      ...(runtimeOptions.signal === undefined ? {} : { signal: runtimeOptions.signal }),
      discard,
      cancel,
      prepare: () => prepare(migrationProgram),
    })

  const semanticEvent = (query: { sql: string }): CoordinationContractEvent => {
    if (/pg_try_advisory_lock/i.test(query.sql)) return 'acquire'
    if (/pg_advisory_unlock/i.test(query.sql)) return 'release'
    if (/^\s*(?:begin|commit|rollback)\b/i.test(query.sql)) return 'transaction'
    if (/count\(\*\)/i.test(query.sql)) return 'introspection'
    if (/create table/i.test(query.sql)) return 'ddl'

    return 'unclassified'
  }

  const events = () => queries.map(semanticEvent)
  return {
    calls,
    queries,
    cancel,
    discard,
    execute,
    prepare,
    events,
    releaseHold: () => releaseHold?.(),
    waitFor: async (event: CoordinationContractEvent) => {
      while (!events().includes(event)) {
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
    },
  }
}
