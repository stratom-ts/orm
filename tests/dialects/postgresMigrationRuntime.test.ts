import { describe, expect, it, vi } from 'vitest'

import type { MigrationProgram } from '@/ddl/migrationProgram'
import {
  executePostgresMigration,
  postgresAdvisoryLockIdentity,
} from '@/dialects/postgres/migration'
import {
  createMigrationCoordinationScope,
  migrationLockAcquisitionOrder,
} from '@/migrations/coordinationScope'
import type { Executor } from '@/query'

import type {
  CoordinationContractEvent,
  CoordinationContractLockManager,
} from './migrationCoordinationContract'
import { registerMigrationCoordinationContract } from './migrationCoordinationContract'

const relation = {
  namespace: [
    {
      role: 'database' as const,
      identifier: { spelling: 'test', comparisonKey: 'test' },
    },
    {
      role: 'schema' as const,
      identifier: { spelling: 'public', comparisonKey: 'public' },
    },
  ],
  relation: { spelling: 'events', comparisonKey: 'events' },
}

/**
 * Creates a minimal plan-atomic migration program for runtime tests.
 *
 * @param overrides - Program fields to replace for a specific scenario.
 */
function program(overrides: Partial<MigrationProgram> = {}): MigrationProgram {
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

/**
 * Creates a controllable PostgreSQL migration runtime and records physical calls.
 *
 * @param options - Lock, release, failure, cancellation, and transaction controls.
 */
function harness(
  options: {
    failRun?: RegExp
    failUnlock?: boolean
    unlockResult?: boolean
    unlockResults?: Array<boolean | Error>
    releaseResults?: Array<boolean | Error>
    applicationId?: string
    clientId?: string
    noWork?: boolean
    holdAfterTransaction?: boolean
    sharedLockManager?: CoordinationContractLockManager
    nullCount?: number
    lockResults?: Array<boolean | Error>
    lockDelayMs?: number
    hangQuery?: RegExp
    hangRun?: RegExp
  } = {},
) {
  const calls: string[] = []
  const queries: Array<{ sql: string; params: unknown[] }> = []
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
      if (/pg_try_advisory_lock/i.test(query.sql)) {
        if (options.lockDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.lockDelayMs))
        }
        const configured = options.lockResults?.shift()
        const result =
          configured ??
          options.sharedLockManager?.tryAcquire(
            options.clientId ?? 'client',
            `${query.params[0]}:${query.params[1]}`,
          ) ??
          true
        if (result instanceof Error) throw result
        return [{ locked: result }]
      }
      if (/pg_advisory_unlock/i.test(query.sql)) {
        if (options.failUnlock) throw new Error('unlock failed')
        const result = options.releaseResults?.shift() ?? options.unlockResults?.shift()
        if (result instanceof Error) throw result
        options.sharedLockManager?.release(
          options.clientId ?? 'client',
          `${query.params[0]}:${query.params[1]}`,
        )
        return [{ unlocked: result ?? options.unlockResult ?? true }]
      }
      if (/count\(\*\)/i.test(query.sql)) return [{ count: options.nullCount ?? 0 }]
      return []
    },
  }
  const execute = (
    migrationProgram = options.noWork ? program({ actions: [] }) : program(),
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
    if (/\b(?:begin|commit|rollback)\b/i.test(query.sql)) return 'transaction'
    if (/count\(\*\)/i.test(query.sql)) return 'introspection'
    if (/create table/i.test(query.sql)) return 'ddl'
    return 'transaction'
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

registerMigrationCoordinationContract('PostgreSQL', (options) => {
  const runtime = harness({
    applicationId: options?.applicationId,
    clientId: options?.clientId,
    lockResults: options?.lockResults,
    releaseResults: options?.releaseResults,
    noWork: options?.noWork,
    holdAfterTransaction: options?.holdAfterTransaction,
    sharedLockManager: options?.sharedLockManager,
  })
  return {
    execute: (options) => runtime.execute(undefined, options),
    events: runtime.events,
    releaseHold: runtime.releaseHold,
    waitFor: runtime.waitFor,
  }
})

describe('PostgreSQL migration runtime failures', () => {
  it.each(['statement-atomic', 'non-atomic'] as const)(
    'rejects %s programs before preconditions or DDL',
    async (atomicity) => {
      const runtime = harness()
      const error = await runtime
        .execute(
          program({
            atomicity,
            preconditions: [
              {
                kind: 'column_has_no_nulls',
                relation,
                column: 'id',
                sourceStepIndexes: [0],
              },
            ],
          }),
        )
        .catch((cause: unknown) => cause)

      expect(error).toMatchObject({
        stage: 'lowering',
        outcome: 'unchanged',
        retryable: false,
      })
      expect(runtime.calls.some((sql) => /count\(\*\)|create table/i.test(sql))).toBe(
        false,
      )
      expect(runtime.calls).toContain('rollback')
    },
  )

  it('classifies an acknowledged DDL rollback with action provenance', async () => {
    const runtime = harness({ failRun: /^create table/i })
    const error = await runtime.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'ddl',
      outcome: 'rolledBack',
      retryable: false,
      actionIndex: 0,
      sourceStepIndexes: [4],
    })
    expect(runtime.calls).toContain('rollback')
    expect(runtime.discard).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
  })

  it('does not assume a failed transaction start is retryable', async () => {
    const runtime = harness({ failRun: /^begin/i })
    const error = await runtime.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'transaction',
      outcome: 'unchanged',
      retryable: false,
    })
    expect(runtime.calls.some((sql) => /create table|rollback/i.test(sql))).toBe(false)
    expect(runtime.calls.at(-1)).toMatch(/pg_advisory_unlock/i)
    expect(runtime.discard).toHaveBeenCalled()
  })

  it('classifies rollback failure as unknown and discards the session', async () => {
    const runtime = harness({ failRun: /^create table|^rollback$/i })
    const error = await runtime.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'ddl',
      outcome: 'unknown',
      retryable: false,
      cleanupFailures: [{ stage: 'rollback' }],
    })
    expect(runtime.discard).toHaveBeenCalled()
  })

  it('does not roll back an ambiguously acknowledged commit', async () => {
    const runtime = harness({ failRun: /^commit$/i })
    const error = await runtime.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'commit',
      outcome: 'unknown',
      retryable: false,
    })
    expect(runtime.calls).not.toContain('rollback')
    expect(runtime.discard).toHaveBeenCalled()
  })

  it('classifies a failed semantic precondition as unchanged', async () => {
    const runtime = harness({ nullCount: 1 })
    const error = await runtime
      .execute(
        program({
          preconditions: [
            {
              kind: 'column_has_no_nulls',
              relation,
              column: 'id',
              sourceStepIndexes: [2],
            },
          ],
        }),
      )
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'precondition',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes: [2],
    })
    expect(runtime.calls).toContain('rollback')
    expect(runtime.calls.some((sql) => /^create table/i.test(sql))).toBe(false)
  })

  it('keeps a pre-DDL precondition failure unchanged when rollback also fails', async () => {
    const runtime = harness({ nullCount: 1, failRun: /^rollback$/i })
    const error = await runtime
      .execute(
        program({
          preconditions: [
            {
              kind: 'column_has_no_nulls',
              relation,
              column: 'id',
              sourceStepIndexes: [2],
            },
          ],
        }),
      )
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'precondition',
      outcome: 'unchanged',
      retryable: false,
      cleanupFailures: [{ stage: 'rollback' }],
    })
    expect(runtime.discard).toHaveBeenCalled()
    expect(runtime.calls.some((sql) => /^create table/i.test(sql))).toBe(false)
  })

  it('reports unlock cleanup after commit as applied and discards', async () => {
    const runtime = harness({ failUnlock: true })
    const error = await runtime.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'unlock',
      outcome: 'applied',
      retryable: false,
      cleanupFailures: [{ stage: 'unlock' }],
    })
    expect(runtime.discard).toHaveBeenCalled()
  })

  it('acquires coordination immediately before transaction work', async () => {
    const runtime = harness({ lockResults: [true] })
    await expect(runtime.execute()).resolves.toEqual({ outcome: 'applied' })

    expect(runtime.calls[0]).toMatch(/pg_try_advisory_lock/i)
    expect(runtime.calls[1]).toBe('begin isolation level repeatable read')
    expect(runtime.calls.at(-1)).toMatch(/pg_advisory_unlock/i)
  })

  it('times out after one nonblocking try when lockTimeoutMs is zero', async () => {
    const runtime = harness({ lockResults: [false] })
    const error = await runtime
      .execute(program(), { lockTimeoutMs: 0 })
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })
    expect((error as Error).message).toMatch(/one no-wait try/i)
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]).toMatch(/pg_try_advisory_lock/i)
    expect(runtime.calls.some((sql) => /unlock|begin|create table/i.test(sql))).toBe(
      false,
    )
    expect(runtime.discard).toHaveBeenCalled()
    expect(runtime.cancel).toHaveBeenCalledOnce()
    expect(runtime.prepare).not.toHaveBeenCalled()
  })

  it('allows an asynchronous successful first try when lockTimeoutMs is zero', async () => {
    const runtime = harness({ lockDelayMs: 10, lockResults: [true] })

    await expect(runtime.execute(program(), { lockTimeoutMs: 0 })).resolves.toEqual({
      outcome: 'applied',
    })
    expect(runtime.calls.filter((sql) => /pg_try_advisory_lock/i.test(sql))).toHaveLength(
      1,
    )
    expect(runtime.cancel).not.toHaveBeenCalled()
  })

  it('allows a full response window for the first try under a small lockTimeoutMs', async () => {
    const runtime = harness({ lockDelayMs: 10, lockResults: [true] })

    await expect(runtime.execute(program(), { lockTimeoutMs: 5 })).resolves.toEqual({
      outcome: 'applied',
    })
    expect(runtime.calls.filter((sql) => /pg_try_advisory_lock/i.test(sql))).toHaveLength(
      1,
    )
    expect(runtime.cancel).not.toHaveBeenCalled()
    expect(runtime.discard).not.toHaveBeenCalled()
  })

  it('cancels and drains a never-settling physical lock query at its deadline', async () => {
    vi.useFakeTimers()
    try {
      const runtime = harness({ hangQuery: /pg_try_advisory_lock/i })
      const pending = runtime
        .execute(program(), { lockTimeoutMs: 0 })
        .catch((cause: unknown) => cause)
      await vi.advanceTimersByTimeAsync(5_000)
      const error = await pending

      expect(error).toMatchObject({
        stage: 'lock',
        outcome: 'unchanged',
        retryable: true,
      })
      expect((error as Error).message).toMatch(/lock attempt response/i)
      expect(runtime.cancel).toHaveBeenCalledOnce()
      expect(runtime.discard).toHaveBeenCalled()
      expect(runtime.calls).toHaveLength(1)
      expect(runtime.prepare).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a hung post-commit unlock while retaining applied outcome', async () => {
    const runtime = harness({ hangQuery: /pg_advisory_unlock/i })
    const controller = new AbortController()
    const pending = runtime.execute(program(), { signal: controller.signal })
    while (!runtime.calls.some((sql) => /pg_advisory_unlock/i.test(sql))) {
      await Promise.resolve()
    }
    controller.abort()
    const error = await pending.catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'unlock',
      outcome: 'applied',
      retryable: false,
      cleanupFailures: [{ stage: 'unlock' }],
    })
    expect(runtime.cancel).toHaveBeenCalledOnce()
    expect(runtime.discard).toHaveBeenCalled()
  })

  it('bounds a hung post-commit unlock without an external signal', async () => {
    vi.useFakeTimers()
    try {
      const runtime = harness({ hangQuery: /pg_advisory_unlock/i })
      const pending = runtime.execute(program()).catch((cause: unknown) => cause)
      await vi.advanceTimersByTimeAsync(5_000)
      const error = await pending

      expect(error).toMatchObject({
        stage: 'unlock',
        outcome: 'applied',
        retryable: false,
        cleanupFailures: [{ stage: 'unlock' }],
      })
      expect((error as Error).message).toMatch(/release verification/i)
      expect(runtime.cancel).toHaveBeenCalledOnce()
      expect(runtime.discard).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels in-flight DDL and reports unknown without further SQL', async () => {
    const runtime = harness({ hangRun: /^create table/i })
    const controller = new AbortController()
    const pending = runtime.execute(program(), { signal: controller.signal })
    while (!runtime.calls.some((sql) => /^create table/i.test(sql)))
      await Promise.resolve()
    controller.abort()
    const error = await pending.catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'ddl',
      outcome: 'unknown',
      retryable: false,
    })
    expect(runtime.cancel).toHaveBeenCalledOnce()
    expect(runtime.discard).toHaveBeenCalled()
    expect(runtime.calls.some((sql) => /rollback|advisory_unlock/i.test(sql))).toBe(false)
  })

  it('stops polling when lock acquisition is aborted', async () => {
    const runtime = harness({ lockResults: [false] })
    const controller = new AbortController()
    const pending = runtime.execute(program(), { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    const error = await pending.catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]).toMatch(/pg_try_advisory_lock/i)
    expect(runtime.calls.some((sql) => /unlock|begin|create table/i.test(sql))).toBe(
      false,
    )
    expect(runtime.discard).toHaveBeenCalled()
    expect(runtime.cancel).toHaveBeenCalledOnce()
    expect(runtime.prepare).not.toHaveBeenCalled()
  })

  it('discards an uncertain acquisition-query failure without unlocking', async () => {
    const runtime = harness({ lockResults: [new Error('lock query failed')] })
    const error = await runtime.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: false,
    })
    expect(runtime.calls).toHaveLength(1)
    expect(runtime.discard).toHaveBeenCalled()
    expect(runtime.prepare).not.toHaveBeenCalled()
  })

  it('acquires and releases only the scoped key for an application', async () => {
    const runtime = harness({ applicationId: 'billing', lockResults: [true] })
    await expect(runtime.execute()).resolves.toEqual({ outcome: 'applied' })

    const locks = runtime.queries.filter((query) =>
      /pg_try_advisory_lock/i.test(query.sql),
    )
    const unlocks = runtime.queries.filter((query) =>
      /pg_advisory_unlock/i.test(query.sql),
    )
    expect(locks).toHaveLength(1)
    expect(unlocks).toHaveLength(1)
    expect(unlocks[0]!.params).toEqual(locks[0]!.params)
    expect(locks[0]!.params).not.toEqual([0x7363_686d, 0x6f72_6d00])
  })

  it('derives stable scoped keys and separates database/application identities', () => {
    const scoped = (database: string, applicationId: string) =>
      postgresAdvisoryLockIdentity(
        migrationLockAcquisitionOrder(
          createMigrationCoordinationScope({
            dialect: 'postgresql',
            database,
            applicationId,
          }),
        )[0]!,
      )
    expect(scoped('test', 'billing')).toEqual(scoped('test', 'billing'))
    expect(scoped('test', 'billing')).not.toEqual(scoped('other', 'billing'))
    expect(scoped('test', 'billing')).not.toEqual(scoped('test', 'orders'))
  })

  it('performs one nonblocking attempt for the scoped lock', async () => {
    const runtime = harness({
      applicationId: 'billing',
      lockResults: [false],
    })
    const error = await runtime
      .execute(program(), { lockTimeoutMs: 0 })
      .catch((cause) => cause)

    expect(error).toMatchObject({ stage: 'lock', outcome: 'unchanged', retryable: true })
    expect(
      runtime.queries.filter((query) => /pg_try_advisory_lock/i.test(query.sql)),
    ).toHaveLength(1)
    expect(
      runtime.queries.filter((query) => /pg_advisory_unlock/i.test(query.sql)),
    ).toHaveLength(0)
    expect(
      runtime.queries.some((query) =>
        /\bbegin\b|create table|count\(\*\)/i.test(query.sql),
      ),
    ).toBe(false)
  })

  it('enforces the deadline while the scoped lock is unavailable', async () => {
    vi.useFakeTimers()
    try {
      const runtime = harness({
        applicationId: 'billing',
        lockResults: [false, true],
        lockDelayMs: 30,
      })
      const pending = runtime
        .execute(program(), { lockTimeoutMs: 40 })
        .catch((cause) => cause)
      await vi.advanceTimersByTimeAsync(100)
      const error = await pending

      expect(error).toMatchObject({
        stage: 'lock',
        outcome: 'unchanged',
        retryable: true,
      })
      expect(
        runtime.queries.filter((query) => /pg_try_advisory_lock/i.test(query.sql)),
      ).toHaveLength(1)
      expect(
        runtime.queries.some((query) => /\bbegin\b|create table/i.test(query.sql)),
      ).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the applied outcome when scoped release verification fails', async () => {
    const runtime = harness({
      applicationId: 'billing',
      lockResults: [true],
      unlockResults: [false],
    })
    const error = await runtime.execute().catch((cause) => cause)

    expect(error).toMatchObject({
      stage: 'unlock',
      outcome: 'applied',
      retryable: false,
      cleanupFailures: [{ stage: 'unlock' }],
    })
    expect(
      runtime.queries.filter((query) => /pg_advisory_unlock/i.test(query.sql)),
    ).toHaveLength(1)
    expect(runtime.discard).toHaveBeenCalled()
  })

  it('aborts before coordination completes without transaction work', async () => {
    const controller = new AbortController()
    const runtime = harness({ applicationId: 'billing', lockResults: [false] })
    const pending = runtime.execute(program(), { signal: controller.signal })
    controller.abort()
    const error = await pending.catch((cause) => cause)

    expect(error).toMatchObject({ stage: 'lock', outcome: 'unchanged', retryable: true })
    expect(
      runtime.queries.some((query) =>
        /\bbegin\b|create table|count\(\*\)/i.test(query.sql),
      ),
    ).toBe(false)
    expect(runtime.prepare).not.toHaveBeenCalled()
  })
})
