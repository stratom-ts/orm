import { describe, expect, it, vi } from 'vitest'

import { mapPostgresAdvisoryLockIdentity } from '@/dialects/postgres/migration/coordination'
import {
  createMigrationCoordinationScope,
  migrationLockAcquisitionOrder,
} from '@/migrations/coordinationScope'
import { MigrationOwnershipSchemaError } from '@/migrations/migrationOwnership'
import { MigrationError, QueryError } from '@/utils/error'

import {
  createPostgresMigrationRuntime as harness,
  postgresMigrationProgram as program,
} from './postgresMigrationRuntimeFixtures'

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

const target = {
  kind: 'column' as const,
  relation,
  column: { spelling: 'payload', comparisonKey: 'payload' },
}

const guarded = program({
  preconditions: [{ kind: 'column_has_only_nulls', target, sourceStepIndexes: [3] }],
})

function registerGuardedColumnDropCases() {
  registerGuardObservationCases()
  registerGuardFailureCases()
}

function registerGuardObservationCases() {
  it.each([
    [{ has_data: true }, 'contains_non_null_values'],
    [{ has_data: 1 }, 'verification_failed'],
    [{}, 'verification_failed'],
  ])('blocks an unsafe or malformed result before DDL', async (row, reason) => {
    const runtime = harness({ guardRows: [row] })
    const error = await runtime.execute(guarded).catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'precondition',
      preconditionFailure: { target, reason },
      sourceStepIndexes: [3],
    })

    expect(runtime.calls).not.toContain('create table events (id integer)')
    expect(runtime.calls).toContain('rollback')
  })

  it('locks the relation before checking and executes when the result is false', async () => {
    const runtime = harness({ guardRows: [{ has_data: false }] })
    await expect(runtime.execute(guarded)).resolves.toEqual({ outcome: 'applied' })
    const lock = runtime.calls.findIndex((sql) => sql.startsWith('lock table'))
    const check = runtime.calls.findIndex((sql) => sql.startsWith('select exists('))
    expect(lock).toBeGreaterThanOrEqual(0)
    expect(check).toBeGreaterThan(lock)
  })
}

function registerGuardFailureCases() {
  it('retains a recognized guard query failure without attempting DDL', async () => {
    const cause = new QueryError({ message: 'guard read failed' })
    const runtime = harness({ guardFailure: cause })
    const error = await runtime.execute(guarded).catch((failure: unknown) => failure)
    expect(error).toMatchObject({
      stage: 'precondition',
      outcome: 'unchanged',
      preconditionFailure: { target, reason: 'verification_failed' },
      sourceStepIndexes: [3],
    })

    expect((error as MigrationError).cause).toBe(cause)
    expect(runtime.calls).not.toContain('create table events (id integer)')
  })

  it('rejects an authoritative guard on a relation absent from the provisional lock set', async () => {
    const runtime = harness()
    runtime.prepare.mockResolvedValueOnce(program({ actions: [], preconditions: [] }))
    runtime.prepare.mockResolvedValueOnce(guarded)

    const error = await runtime.execute().catch((cause: unknown) => cause)
    expect(error).toMatchObject({ stage: 'precondition', outcome: 'unchanged' })

    expect(runtime.calls.some((sql) => /^lock table|^create table/i.test(sql))).toBe(
      false,
    )

    expect(runtime.calls).toContain('rollback')
  })
}

const registerMigrationRuntimeCases2 = () => {
  it('should preserve an explicitly present null defect cause', async () => {
    const originalCause = null
    const structured = new MigrationError({
      message: 'wrapped nullish defect',
      cause: originalCause,
      defect: true,
      stage: 'planning',
      outcome: 'unchanged',
      retryable: false,
    })

    const runtime = harness({ prepareFailure: structured })
    const rejection = await runtime.execute().catch((cause: unknown) => cause)

    expect(rejection).toMatchObject({ defect: true, stage: 'planning' })

    expect((rejection as MigrationError).message).toBe(
      'PostgreSQL migration planning failed: wrapped nullish defect',
    )

    expect(Object.hasOwn(rejection as object, 'cause')).toBe(true)
    expect((rejection as MigrationError).cause).toBe(originalCause)
  })

  it('should classify arbitrary SQL as a non-transaction event', async () => {
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
}

const registerMigrationRuntimeCases3 = () => {
  it.each(['statement-atomic', 'non-atomic'] as const)(
    'should reject %s programs before preconditions or DDL',
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

      expect(runtime.calls).not.toContain('rollback')
    },
  )
}

const registerMigrationRuntimeCases4 = () => {
  it('should classify an acknowledged DDL rollback with action provenance', async () => {
    const runtime = harness({ failRun: /^create table/i })
    const error = await runtime.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'ddl',
      outcome: 'rolledBack',
      retryable: false,
      defect: true,
      actionIndex: 0,
      sourceStepIndexes: [4],
    })

    expect((error as MigrationError).message).toBe(
      'PostgreSQL migration ddl failed during action 1',
    )

    expect(Object.hasOwn(error as object, 'capabilityIssues')).toBe(false)

    expect(runtime.calls).toContain('rollback')
    expect(runtime.discard).not.toHaveBeenCalled()
    expect(runtime.cancel).not.toHaveBeenCalled()
  })

  it('should not assume a failed transaction start is retryable', async () => {
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
}

const registerMigrationRuntimeCases6 = () => {
  it('should classify rollback failure as unknown and discard the session', async () => {
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

  it('should not roll back an ambiguously acknowledged commit', async () => {
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
}

const registerMigrationRuntimeCases7 = () => {
  it('should classify a failed semantic precondition as unchanged', async () => {
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
}

const registerMigrationRuntimeCases8 = () => {
  it('should keep a pre-DDL precondition failure unchanged when rollback also fails', async () => {
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

  it('should report unlock cleanup after commit as applied and discard', async () => {
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
}

const registerMigrationRuntimeCases9 = () => {
  it('should acquire coordination immediately before transaction work', async () => {
    const runtime = harness({ lockResults: [true] })
    await expect(runtime.execute()).resolves.toEqual({ outcome: 'applied' })

    expect(runtime.calls[0]).toMatch(/pg_try_advisory_lock/i)
    expect(runtime.calls[1]).toBe('begin isolation level repeatable read')
    expect(runtime.calls.at(-1)).toMatch(/pg_advisory_unlock/i)
  })

  it('should time out after one nonblocking try when lockTimeoutMs is zero', async () => {
    const runtime = harness({ lockResults: [false] })
    const error = await runtime
      .execute(program(), { lockTimeoutMs: 0 })
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })

    expect((error as Error).message).toBe(
      'PostgreSQL migration lock failed: Migration advisory lock was not available after one no-wait try',
    )

    expect(runtime.calls).toHaveLength(1)
    expect(runtime.calls[0]).toMatch(/pg_try_advisory_lock/i)

    expect(runtime.calls.some((sql) => /unlock|begin|create table/i.test(sql))).toBe(
      false,
    )

    expect(runtime.discard).toHaveBeenCalled()
    expect(runtime.cancel).toHaveBeenCalledOnce()
    expect(runtime.prepare).not.toHaveBeenCalled()
  })
}

const registerMigrationRuntimeCases10 = () => {
  it('should allow an asynchronous successful first try when lockTimeoutMs is zero', async () => {
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
}

const registerMigrationRuntimeCases11 = () => {
  it('should cancel and drain a never-settling physical lock query at its deadline', async () => {
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
}

const registerMigrationRuntimeCases12 = () => {
  it('should cancel a hung post-commit unlock while retaining applied outcome', async () => {
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
}

const registerMigrationRuntimeCases13 = () => {
  it('should bound a hung post-commit unlock without an external signal', async () => {
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
}

const registerMigrationRuntimeCases14 = () => {
  it('should cancel in-flight DDL and report unknown without further SQL', async () => {
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

    expect((error as MigrationError).message).toBe(
      'PostgreSQL migration ddl failed during action 1: Migration execution was aborted',
    )

    expect(runtime.cancel).toHaveBeenCalledOnce()
    expect(runtime.discard).toHaveBeenCalled()

    expect(runtime.calls.some((sql) => /rollback|advisory_unlock/i.test(sql))).toBe(false)
  })
}

const registerMigrationRuntimeCases15 = () => {
  it('should stop polling when lock acquisition is aborted', async () => {
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

  it('should discard an uncertain acquisition-query failure without unlocking', async () => {
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
}

const registerMigrationRuntimeCases16 = () => {
  it('should acquire and release only the scoped key for an application', async () => {
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
    expect(unlocks[0].params).toEqual(locks[0].params)
    expect(locks[0].params).not.toEqual([0x7363_686d, 0x6f72_6d00])
  })

  it('should derive stable scoped keys and separate database/application identities', () => {
    /**
     * Computes the advisory-lock identity for the fixture database and application
     * scope.
     */
    const scoped = (database: string, applicationId: string) =>
      mapPostgresAdvisoryLockIdentity(
        migrationLockAcquisitionOrder(
          createMigrationCoordinationScope({
            dialect: 'postgresql',
            database,
            applicationId,
          }),
        )[0],
      )

    expect(scoped('test', 'billing')).toEqual(scoped('test', 'billing'))
    expect(scoped('test', 'billing')).not.toEqual(scoped('other', 'billing'))
    expect(scoped('test', 'billing')).not.toEqual(scoped('test', 'orders'))
  })
}

const registerMigrationRuntimeCases17 = () => {
  it('should perform one nonblocking attempt for the scoped lock', async () => {
    const runtime = harness({
      applicationId: 'billing',
      lockResults: [false],
    })

    const error = await runtime
      .execute(program(), { lockTimeoutMs: 0 })
      .catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })

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
}

const registerMigrationRuntimeCases18 = () => {
  it('should enforce the deadline while the scoped lock is unavailable', async () => {
    vi.useFakeTimers()

    try {
      const runtime = harness({
        applicationId: 'billing',
        lockResults: [false, true],
        lockDelayMs: 30,
      })

      const pending = runtime
        .execute(program(), { lockTimeoutMs: 40 })
        .catch((cause: unknown) => cause)

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
}

const registerMigrationRuntimeCases19 = () => {
  it('should report the configured lock deadline when an in-flight attempt reaches it', async () => {
    vi.useFakeTimers()

    try {
      const runtime = harness({ hangQuery: /pg_try_advisory_lock/i })

      const pending = runtime
        .execute(program(), { lockTimeoutMs: 100 })
        .catch((cause: unknown) => cause)

      await vi.advanceTimersByTimeAsync(100)
      const error = await pending

      expect(error).toMatchObject({
        message: expect.stringContaining(
          'Timed out acquiring the migration advisory lock after 100ms',
        ) as string,
        stage: 'lock',
        outcome: 'unchanged',
        retryable: true,
      })

      expect(runtime.queries).toEqual([
        {
          sql: 'select pg_try_advisory_lock($1, $2) as "locked"',
          params: expect.any(Array) as unknown,
        },
      ])

      expect(runtime.cancel).toHaveBeenCalledOnce()
      expect(runtime.discard).toHaveBeenCalledOnce()
      expect(runtime.prepare).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
}

const registerMigrationRuntimeCases20 = () => {
  it('should preserve the applied outcome when scoped release verification fails', async () => {
    const runtime = harness({
      applicationId: 'billing',
      lockResults: [true],
      unlockResults: [false],
    })

    const error = await runtime.execute().catch((cause: unknown) => cause)

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

  it('should abort before coordination completes without transaction work', async () => {
    const controller = new AbortController()
    const runtime = harness({ applicationId: 'billing', lockResults: [false] })
    const pending = runtime.execute(program(), { signal: controller.signal })
    controller.abort()
    const error = await pending.catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })

    expect(
      runtime.queries.some((query) =>
        /\bbegin\b|create table|count\(\*\)/i.test(query.sql),
      ),
    ).toBe(false)

    expect(runtime.prepare).not.toHaveBeenCalled()
  })
}

function registerMigrationRuntimeGroup1() {
  it('should retain PostgreSQL ownership error origin and rollback/unlock cleanup evidence', async () => {
    const invalidOwnership = new MigrationOwnershipSchemaError({
      message: 'missing registered handle',
    })

    const runtime = harness({
      prepareFailure: invalidOwnership,
      failRun: /^rollback$/i,
      failUnlock: true,
    })

    const error = await runtime.execute().catch((cause: unknown) => cause)

    expect(error).toMatchObject({
      _tag: 'MigrationError',
      cause: invalidOwnership,
      stage: 'planning',
      outcome: 'unchanged',
    })

    expect((error as MigrationError).defect).toBeUndefined()

    expect((error as MigrationError).cleanupFailures?.map(({ stage }) => stage)).toEqual([
      'unlock',
    ])
  })
}

function registerMigrationRuntimeGroup2() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases2()
  })
}

function registerMigrationRuntimeGroup3() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases3()
  })
}

function registerMigrationRuntimeGroup4() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases4()
  })
}

function registerMigrationRuntimeGroup5() {
  it('should retain a reported validation stage and its exact execution message', async () => {
    const primary = new MigrationError({
      message: 'validation rejected',
      stage: 'validation',
    })

    const runtime = harness({ prepareFailure: primary })
    const rejection = await runtime.execute().catch((cause: unknown) => cause)

    expect(rejection).toMatchObject({
      stage: 'validation',
      outcome: 'unchanged',
      cause: primary,
    })

    expect((rejection as MigrationError).message).toBe(
      'PostgreSQL migration validation failed: validation rejected',
    )
  })
}

function registerMigrationRuntimeGroup6() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases6()
  })
}

function registerMigrationRuntimeGroup7() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases7()
  })
}

function registerMigrationRuntimeGroup8() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases8()
  })
}

function registerMigrationRuntimeGroup9() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases9()
  })
}

function registerMigrationRuntimeGroup10() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases10()
  })
}

function registerMigrationRuntimeGroup11() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases11()
  })
}

function registerMigrationRuntimeGroup12() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases12()
  })
}

function registerMigrationRuntimeGroup13() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases13()
  })
}

function registerMigrationRuntimeGroup14() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases14()
  })
}

function registerMigrationRuntimeGroup15() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases15()
  })
}

function registerMigrationRuntimeGroup16() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases16()
  })
}

function registerMigrationRuntimeGroup17() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases17()
  })
}

function registerMigrationRuntimeGroup18() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases18()
  })
}

function registerMigrationRuntimeGroup19() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases19()
  })
}

function registerMigrationRuntimeGroup20() {
  describe('PostgreSQL migration runtime', () => {
    registerMigrationRuntimeCases20()
  })
}

describe('PostgreSQL migration runtime', () => {
  registerGuardedColumnDropCases()
  registerMigrationRuntimeGroup1()
  registerMigrationRuntimeGroup2()
  registerMigrationRuntimeGroup3()
  registerMigrationRuntimeGroup4()
  registerMigrationRuntimeGroup5()
  registerMigrationRuntimeGroup6()
  registerMigrationRuntimeGroup7()
  registerMigrationRuntimeGroup8()
  registerMigrationRuntimeGroup9()
  registerMigrationRuntimeGroup10()
  registerMigrationRuntimeGroup11()
  registerMigrationRuntimeGroup12()
  registerMigrationRuntimeGroup13()
  registerMigrationRuntimeGroup14()
  registerMigrationRuntimeGroup15()
  registerMigrationRuntimeGroup16()
  registerMigrationRuntimeGroup17()
  registerMigrationRuntimeGroup18()
  registerMigrationRuntimeGroup19()
  registerMigrationRuntimeGroup20()
})
