import { describe, expect, it, vi } from 'vitest'

import { postgresAdvisoryLockIdentity } from '@/dialects/postgres/migration'
import {
  createMigrationCoordinationScope,
  migrationLockAcquisitionOrder,
} from '@/migrations/coordinationScope'

import {
  createPostgresMigrationRuntime as harness,
  postgresMigrationProgram as program,
} from '../helpers/postgresMigrationRuntimeFixtures'

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

describe('PostgreSQL migration runtime failures', () => {
  it('classifies arbitrary SQL as a non-transaction event', async () => {
    const runtime = harness()

    await expect(
      runtime.execute(
        program({
          actions: [
            {
              sourceStepIndexes: [4],
              transaction: 'required',
              statements: [{ sql: 'select begin', params: [] }],
            },
          ],
        }),
      ),
    ).resolves.toEqual({ outcome: 'applied' })

    const statementIndex = runtime.queries.findIndex(
      (query) => query.sql === 'select begin',
    )
    expect(statementIndex).toBeGreaterThan(-1)
    expect(runtime.events()[statementIndex]).toBe('unclassified')
  })

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
    let release!: () => void
    const lockGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = harness({ lockGate, lockResults: [true] })
    const pending = runtime.execute(program(), { lockTimeoutMs: 0 })

    await runtime.waitFor('acquire')
    release()

    await expect(pending).resolves.toEqual({ outcome: 'applied' })

    expect(runtime.calls.filter((sql) => /pg_try_advisory_lock/i.test(sql))).toHaveLength(
      1,
    )

    expect(runtime.cancel).not.toHaveBeenCalled()
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

  it('reports the configured lock deadline when an in-flight attempt reaches it', async () => {
    vi.useFakeTimers()

    try {
      const runtime = harness({ hangQuery: /pg_try_advisory_lock/i })

      const pending = runtime
        .execute(program(), { lockTimeoutMs: 100 })
        .catch((cause) => cause)

      await vi.advanceTimersByTimeAsync(100)
      const error = await pending

      expect(error).toMatchObject({
        message: 'Timed out acquiring the migration advisory lock after 100ms',
        stage: 'lock',
        outcome: 'unchanged',
        retryable: true,
      })

      expect(runtime.queries).toEqual([
        {
          sql: 'select pg_try_advisory_lock($1, $2) as "locked"',
          params: expect.any(Array),
        },
      ])

      expect(runtime.cancel).toHaveBeenCalledOnce()
      expect(runtime.discard).toHaveBeenCalledOnce()
      expect(runtime.prepare).not.toHaveBeenCalled()
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
