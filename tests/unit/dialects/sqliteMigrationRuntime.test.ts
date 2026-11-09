import { describe, expect, it, vi } from 'vitest'

import type { MigrationPrecondition, MigrationProgram } from '@/ddl/migrationProgram'
import { executeSqliteMigration } from '@/dialects/sqlite/migration/runtime'
import { MigrationOwnershipSchemaError } from '@/migrations/migrationOwnership'
import type { Executor } from '@/query'
import type { SchemaError } from '@/utils/error'
import { MigrationError, QueryError } from '@/utils/error'

const statement = { sql: 'create table records (id integer)', params: [] }

const quotedPrecondition: MigrationPrecondition = {
  kind: 'column_has_no_nulls',
  relation: {
    namespace: [
      { role: 'database', identifier: { spelling: 'main', comparisonKey: 'main' } },
    ],
    relation: { spelling: 'odd"table', comparisonKey: 'odd"table' },
  },
  column: 'odd"column',
  sourceStepIndexes: [3],
}

/** Builds one physical program with a traceable source step. */
function program(): MigrationProgram {
  return {
    atomicity: 'plan-atomic',
    preconditions: [],
    actions: [
      { sourceStepIndexes: [7], transaction: 'required', statements: [statement] },
    ],
  }
}

type FixtureOptions = {
  fail?: 'ddl' | 'commit' | 'restore'
  rollbackFailure?: boolean
  busy?: boolean | 'numeric'
  nullCount?: number
  guardRows?: unknown[]
  guardFailure?: unknown
  prepareFailure?: MigrationError | SchemaError
  integrityFailure?: boolean
  validationFailure?: Error
}

/** Creates either native SQLite BUSY diagnostic shape used by this fixture. */
function busyError(numeric: boolean): Error {
  return Object.assign(
    new Error('busy'),
    numeric ? { code: 'ERR_SQLITE_ERROR', errcode: 517 } : { code: 'SQLITE_BUSY' },
  )
}

function fixtureExecutor(options: FixtureOptions, calls: string[]): Executor {
  return {
    /** Returns the busy policy and authoritative NULL count. */
    async execute(query) {
      calls.push(query.sql)

      if (query.sql === 'pragma busy_timeout') return [{ timeout: 250 }]
      if (query.sql === 'pragma foreign_keys') return [{ foreign_keys: 0 }]
      if (query.sql === 'pragma main.foreign_key_check') return []

      if (query.sql === 'pragma main.integrity_check')
        return [{ integrity_check: options.integrityFailure ? 'corrupt' : 'ok' }]

      if (query.sql.startsWith('select exists(')) {
        if (options.guardFailure) throw options.guardFailure

        return options.guardRows ?? [{ has_data: 0 }]
      }

      return [{ count: options.nullCount ?? 0 }]
    },
    /** Records physical commands and injects one selected acknowledgement failure. */
    async run(query) {
      calls.push(query.sql)

      if (options.busy && query.sql === 'begin immediate')
        throw busyError(options.busy === 'numeric')

      if (options.fail === 'ddl' && query.sql === statement.sql)
        throw new Error('DDL failed')

      if (options.fail === 'commit' && query.sql === 'commit')
        throw new Error('commit failed')

      if (options.rollbackFailure && query.sql === 'rollback')
        throw new Error('rollback failed')

      if (options.fail === 'restore' && query.sql === 'pragma busy_timeout=250')
        throw new Error('restore failed')
    },
  }
}

/** Drives the production runtime with controlled native command acknowledgements. */
function fixture(options: FixtureOptions = {}) {
  const calls: string[] = []
  const discard = vi.fn<() => void>()
  const prepare = vi.fn<() => Promise<MigrationProgram>>(async () => program())
  const executor = fixtureExecutor(options, calls)

  const execute = (migrationProgram = program(), lockTimeoutMs = 0) =>
    executeSqliteMigration({
      executor,
      databaseIdentity: 'fixture',
      lockTimeoutMs,
      discard,
      cancel: async () => undefined,
      prepare: async () => {
        await prepare()

        if (options.prepareFailure) throw options.prepareFailure

        return migrationProgram
      },
      validate: async () => {
        if (options.validationFailure) throw options.validationFailure
      },
    })

  return { calls, discard, prepare, execute }
}

function registerMigrationRuntimeGroup1() {
  it.each([
    ['rollback', { rollbackFailure: true }, 'rollback'],
    ['session cleanup', { fail: 'restore' as const }, 'sessionCleanup'],
  ])(
    'should retain SQLite ownership error origin through %s failure',
    async (_, failure, stage) => {
      const invalidOwnership = new MigrationOwnershipSchemaError({
        message: 'missing registered handle',
      })

      const test = fixture({ prepareFailure: invalidOwnership, ...failure })

      const error = await test.execute().catch((cause: unknown) => cause)

      expect(error).toMatchObject({
        _tag: 'MigrationError',
        cause: invalidOwnership,
        stage: 'planning',
        outcome: 'unchanged',
      })

      expect((error as MigrationError).defect).toBeUndefined()
      expect((error as MigrationError).cleanupFailures?.[0]?.stage).toBe(stage)
    },
  )
}

function registerMigrationRuntimeGroup2() {
  it.each([true, 'numeric'] as const)(
    'should not prepare or run DDL after a nonblocking BUSY %s coordination attempt',
    async (busy) => {
      const test = fixture({ busy })
      await expect(test.execute()).rejects.toMatchObject({
        stage: 'lock',
        outcome: 'unchanged',
        retryable: true,
      })

      expect(test.prepare).not.toHaveBeenCalled()
      expect(test.calls).not.toContain(statement.sql)
      expect(test.calls).toContain('pragma busy_timeout=250')
    },
  )
}

function registerMigrationRuntimeGroup3() {
  it.each(['integrity', 'convergence'] as const)(
    'should roll back %s validation failure with provenance and cleanup evidence',
    async (kind) => {
      const primary = new MigrationError({
        message: 'convergence failed',
        stage: 'lowering',
      })

      const primaryMessage =
        kind === 'integrity' ? 'SQLite integrity_check failed' : primary.message

      const test = fixture({
        integrityFailure: kind === 'integrity',
        validationFailure: kind === 'convergence' ? primary : undefined,
        fail: 'restore',
      })

      const rejection = await test.execute().catch((cause: unknown) => cause)

      expect(rejection).toMatchObject({
        stage: 'validation',
        outcome: 'rolledBack',
        cause: { message: primaryMessage },
        sourceStepIndexes: [7],
        cleanupFailures: [
          { stage: 'sessionCleanup', cause: new Error('restore failed') },
        ],
      })

      expect((rejection as MigrationError).message).toBe(
        `SQLite migration validation failed: ${primaryMessage}`,
      )

      expect(test.calls).toContain(statement.sql)
      expect(test.calls).toContain('rollback')
      expect(test.calls).not.toContain('commit')
      expect(test.discard).toHaveBeenCalled()
    },
  )
}

function registerMigrationRuntimeGroup4() {
  it('should retry BUSY only before one monotonic lock deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
    const test = fixture({ busy: true })
    const attempts = () => test.calls.filter((sql) => sql === 'begin immediate').length
    try {
      const settled = test.execute(program(), 25).then(
        (result) => result,
        (cause: unknown) => cause,
      )

      await vi.advanceTimersByTimeAsync(0)
      expect(attempts()).toBe(1)
      await vi.advanceTimersByTimeAsync(10)
      expect(attempts()).toBe(2)
      await vi.advanceTimersByTimeAsync(10)
      expect(attempts()).toBe(3)
      await vi.advanceTimersByTimeAsync(5)

      expect(await settled).toMatchObject({
        stage: 'lock',
        outcome: 'unchanged',
        retryable: true,
      })

      expect(attempts()).toBe(3)
      expect(test.prepare).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
}

function registerMigrationRuntimeGroup5() {
  it('should classify pre-coordination abort as retryable without preparation', async () => {
    const controller = new AbortController()
    controller.abort()
    const aborted = fixture()
    await expect(
      executeSqliteMigration({
        executor: { execute: async () => [], run: async () => undefined },
        databaseIdentity: 'fixture',
        signal: controller.signal,
        discard: aborted.discard,
        cancel: async () => undefined,
        prepare: async () => program(),
      }),
    ).rejects.toMatchObject({ stage: 'lock', outcome: 'unchanged', retryable: true })
  })
}

function registerMigrationRuntimeGroup6() {
  it('should treat commit acknowledgement failure as unknown without rollback or unsafe cleanup', async () => {
    const test = fixture({ fail: 'commit' })
    const rejection = await test.execute().catch((cause: unknown) => cause)

    expect(rejection).toMatchObject({
      stage: 'commit',
      outcome: 'unknown',
      retryable: false,
    })

    expect((rejection as MigrationError).message).toBe('SQLite migration commit failed')

    expect(test.calls).not.toContain('rollback')
    expect(test.calls).not.toContain('pragma busy_timeout=250')
    expect(test.discard).toHaveBeenCalled()
  })
}

function registerMigrationRuntimeGroup7() {
  it('should retain structured preparation diagnostics and append rollback cleanup evidence', async () => {
    const primary = new Error('lowering root')
    const earlierCleanup = new Error('prior cleanup')
    const capabilityIssues = [
      {
        code: 'invalid_target' as const,
        message: 'invalid target',
        sourceStepIndexes: [6],
      },
    ]

    const structured = new MigrationError({
      message: 'Cannot lower target',
      cause: primary,
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
      actionIndex: 4,
      sourceStepIndexes: [6],
      capabilityIssues,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: earlierCleanup }],
    })

    const test = fixture({ prepareFailure: structured, rollbackFailure: true })
    const rejection: unknown = await test.execute().catch((cause: unknown) => cause)

    expect(rejection).toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      actionIndex: 4,
      sourceStepIndexes: [6],
      capabilityIssues,
      cleanupFailures: [
        { stage: 'sessionCleanup', cause: earlierCleanup },
        { stage: 'rollback' },
      ],
    })

    expect((rejection as MigrationError).cause).toBe(primary)

    expect((rejection as MigrationError).message).toBe(
      'SQLite migration lowering failed during action 5: Cannot lower target',
    )

    expect(rejection).not.toHaveProperty('defect')
    expect(test.calls).not.toContain(statement.sql)
  })
}

function registerMigrationRuntimeGroup8() {
  it('should mark wrapped execution defects and retain their original cause and stack', async () => {
    const defect = new TypeError('validation defect')
    const originalStack = defect.stack
    const test = fixture({ validationFailure: defect })
    const rejection = await test.execute().catch((cause: unknown) => cause)

    expect(rejection).toMatchObject({
      stage: 'validation',
      outcome: 'rolledBack',
      defect: true,
    })

    expect((rejection as MigrationError).cause).toBe(defect)
    expect(((rejection as MigrationError).cause as Error).stack).toBe(originalStack)
  })
}

function registerMigrationRuntimeGroup9() {
  it('should preserve an existing defect marker while reconstructing migration diagnostics', async () => {
    const defect = new TypeError('already marked defect')
    const originalStack = defect.stack
    const marked = new MigrationError({
      message: defect.message,
      cause: defect,
      defect: true,
      stage: 'planning',
      outcome: 'unchanged',
      retryable: false,
    })

    const test = fixture({ prepareFailure: marked })
    const rejection = await test.execute().catch((cause: unknown) => cause)

    expect(rejection).toMatchObject({ defect: true, stage: 'planning' })
    expect((rejection as MigrationError).cause).toBe(defect)
    expect(((rejection as MigrationError).cause as Error).stack).toBe(originalStack)
  })
}

function registerMigrationRuntimeGroup10() {
  it('should preserve an explicitly present undefined defect cause', async () => {
    const originalCause = undefined
    const structured = new MigrationError({
      message: 'wrapped nullish defect',
      cause: originalCause,
      defect: true,
      stage: 'planning',
      outcome: 'unchanged',
      retryable: false,
    })

    const test = fixture({ prepareFailure: structured })
    const rejection = await test.execute().catch((cause: unknown) => cause)

    expect(rejection).toMatchObject({ defect: true, stage: 'planning' })
    expect(Object.hasOwn(rejection as object, 'cause')).toBe(true)
    expect((rejection as MigrationError).cause).toBe(originalCause)
  })
}

function registerMigrationRuntimeGroup11() {
  it('should use an uncaused structured preparation failure as its primary cause', async () => {
    const primary = new MigrationError({
      message: 'preparation failed',
      stage: 'planning',
    })

    const test = fixture({ prepareFailure: primary })
    const rejection = await test.execute().catch((cause: unknown) => cause)

    expect((rejection as MigrationError).cause).toBe(primary)

    expect((rejection as MigrationError).message).toBe(
      'SQLite migration planning failed: preparation failed',
    )

    expect(rejection).not.toHaveProperty('defect')
  })
}

function registerMigrationRuntimeGroup12() {
  it('should retain transaction-incompatible action provenance before any precondition or DDL', async () => {
    const test = fixture()
    const incompatible = {
      ...program(),
      actions: [{ ...program().actions[0], transaction: 'forbidden' as const }],
    }

    await expect(test.execute(incompatible)).rejects.toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      sourceStepIndexes: [7],
    })

    expect(test.calls).not.toContain(statement.sql)
  })
}

function registerMigrationRuntimeGroup13() {
  it.each(['statement-atomic', 'non-atomic'] as const)(
    'should reject %s programs before preconditions and DDL',
    async (atomicity) => {
      const test = fixture()
      await expect(
        test.execute({ ...program(), atomicity, preconditions: [quotedPrecondition] }),
      ).rejects.toMatchObject({
        stage: 'lowering',
        outcome: 'unchanged',
        retryable: false,
      })

      expect(test.calls).not.toContain(statement.sql)
      expect(test.calls.some((sql) => sql.includes('count(*)'))).toBe(false)
    },
  )
}

function registerMigrationRuntimeGroup14() {
  it('should report attempted DDL as rolled back or unknown according to rollback acknowledgement', async () => {
    const rolledBack = fixture({ fail: 'ddl' })
    const rolledBackError = await rolledBack.execute().catch((cause: unknown) => cause)

    expect(rolledBackError).toMatchObject({
      stage: 'ddl',
      outcome: 'rolledBack',
      actionIndex: 0,
      sourceStepIndexes: [7],
    })

    expect((rolledBackError as MigrationError).message).toBe(
      'SQLite migration ddl failed during action 1',
    )

    expect(Object.hasOwn(rolledBackError as object, 'capabilityIssues')).toBe(false)
    expect((rolledBackError as MigrationError).capabilityIssues).toBeUndefined()
    expect(Object.hasOwn(rolledBackError as object, 'cleanupFailures')).toBe(false)
    expect((rolledBackError as MigrationError).cleanupFailures).toBeUndefined()

    expect(rolledBack.calls).toContain('rollback')

    const unknown = fixture({ fail: 'ddl', rollbackFailure: true })
    await expect(unknown.execute()).rejects.toMatchObject({
      stage: 'ddl',
      outcome: 'unknown',
      cleanupFailures: [{ stage: 'rollback' }],
    })

    expect(unknown.discard).toHaveBeenCalled()
  })
}

function registerMigrationRuntimeGroup15() {
  it('should retain an acknowledged applied outcome when post-commit busy-policy cleanup fails', async () => {
    const test = fixture({ fail: 'restore' })
    const rejection = await test.execute().catch((cause: unknown) => cause)

    expect(rejection).toMatchObject({
      stage: 'sessionCleanup',
      outcome: 'applied',
      cleanupFailures: [{ stage: 'sessionCleanup' }],
    })

    expect((rejection as MigrationError).message).toBe(
      'SQLite migration sessionCleanup failed',
    )

    expect(Object.hasOwn(rejection as object, 'actionIndex')).toBe(false)
    expect((rejection as MigrationError).actionIndex).toBeUndefined()
    expect(Object.hasOwn(rejection as object, 'sourceStepIndexes')).toBe(false)
    expect((rejection as MigrationError).sourceStepIndexes).toBeUndefined()

    expect(test.discard).toHaveBeenCalled()
  })
}

function registerMigrationRuntimeGroup16() {
  it('should quote a structured main relation and check the authoritative NULL count', async () => {
    const test = fixture({ nullCount: 1 })
    await expect(
      test.execute({ ...program(), preconditions: [quotedPrecondition] }),
    ).rejects.toMatchObject({
      stage: 'precondition',
      outcome: 'unchanged',
      sourceStepIndexes: [3],
    })

    expect(test.calls).toContain(
      'select count(*) as count from "main"."odd""table" where "odd""column" is null',
    )

    expect(test.calls).not.toContain(statement.sql)
  })
}

function registerMigrationRuntimeGroup17() {
  it('should run DDL and commit after an authoritative zero-null precondition', async () => {
    const test = fixture({ nullCount: 0 })
    await expect(
      test.execute({ ...program(), preconditions: [quotedPrecondition] }),
    ).resolves.toEqual({ outcome: 'applied' })

    expect(test.calls).toContain(
      'select count(*) as count from "main"."odd""table" where "odd""column" is null',
    )

    expect(test.calls.indexOf(statement.sql)).toBeGreaterThan(
      test.calls.findIndex((sql) => sql.includes('count(*)')),
    )

    expect(test.calls).toContain('commit')
  })
}

const guardedTarget = {
  kind: 'column' as const,
  relation: quotedPrecondition.relation,
  column: { spelling: 'odd"column', comparisonKey: 'odd"column' },
}

function guardedProgram(): MigrationProgram {
  return {
    ...program(),
    preconditions: [
      { kind: 'column_has_only_nulls', target: guardedTarget, sourceStepIndexes: [5] },
    ],
  }
}

function registerGuardedDropCases() {
  registerInvalidGuardObservations()
  registerValidGuardObservation()
  registerGuardFailures()
}

function registerInvalidGuardObservations() {
  it.each([
    [[], 'verification_failed'],
    [[{ has_data: 0 }, { has_data: 0 }], 'verification_failed'],
    [[{}], 'verification_failed'],
    [[{ has_data: false }], 'verification_failed'],
    [[{ has_data: 2 }], 'verification_failed'],
    [[{ has_data: 1 }], 'contains_non_null_values'],
  ])(
    'should reject an unsafe or invalid guard observation before DDL',
    async (rows, reason) => {
      const test = fixture({ guardRows: rows })
      const error = await test.execute(guardedProgram()).catch((cause: unknown) => cause)

      expect(error).toMatchObject({
        stage: 'precondition',
        outcome: 'unchanged',
        preconditionFailure: { target: guardedTarget, reason },
        sourceStepIndexes: [5],
      })

      expect(test.calls).toContain(
        'select exists(select 1 from "main"."odd""table" where "odd""column" is not null) as has_data',
      )

      expect(test.calls).not.toContain(statement.sql)
    },
  )
}

function registerValidGuardObservation() {
  it('should accept numeric zero and run DDL after the guard', async () => {
    const test = fixture({ guardRows: [{ has_data: 0 }] })
    await expect(test.execute(guardedProgram())).resolves.toEqual({ outcome: 'applied' })

    expect(test.calls.indexOf(statement.sql)).toBeGreaterThan(
      test.calls.findIndex((sql) => sql.startsWith('select exists(')),
    )
  })
}

function registerGuardFailures() {
  it('should retain a recognized query failure and the primary guard after cleanup failures', async () => {
    const cause = new QueryError({ message: 'read failed' })
    const test = fixture({ guardFailure: cause, rollbackFailure: true, fail: 'restore' })
    const error = await test
      .execute(guardedProgram())
      .catch((failure: unknown) => failure)

    expect(error).toMatchObject({
      stage: 'precondition',
      preconditionFailure: { target: guardedTarget, reason: 'verification_failed' },
      sourceStepIndexes: [5],
      cleanupFailures: [{ stage: 'rollback' }],
    })

    expect((error as MigrationError).cause).toBe(cause)
    expect(test.calls).not.toContain(statement.sql)
  })

  it('should retain an unexpected verification defect as a defect', async () => {
    const cause = new TypeError('fixture defect')
    const test = fixture({ guardFailure: cause })
    const error = await test
      .execute(guardedProgram())
      .catch((failure: unknown) => failure)

    expect(error).toMatchObject({ stage: 'precondition', defect: true })
    expect((error as MigrationError).cause).toBe(cause)
    expect(test.calls).not.toContain(statement.sql)
  })
}

describe('SQLite migration runtime', () => {
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
  registerGuardedDropCases()
})
