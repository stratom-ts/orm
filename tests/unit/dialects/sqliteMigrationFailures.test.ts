import { expect, it, vi } from 'vitest'

import type { MigrationPrecondition, MigrationProgram } from '@/ddl/migrationProgram'
import { executeSqliteMigration } from '@/dialects/sqlite/migration/runtime'
import type { Executor } from '@/query'
import { MigrationError } from '@/utils/error'

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
  busy?: boolean
  nullCount?: number
  prepareFailure?: MigrationError
  integrityFailure?: boolean
  validationFailure?: Error
}

/** Drives the production runtime with controlled native command acknowledgements. */
function fixture(options: FixtureOptions = {}) {
  const calls: string[] = []
  const discard = vi.fn<() => void>()
  const prepare = vi.fn<() => Promise<MigrationProgram>>(async () => program())
  const executor: Executor = {
    /** Returns the busy policy and authoritative NULL count. */
    async execute(query) {
      calls.push(query.sql)

      if (query.sql === 'pragma busy_timeout') return [{ timeout: 250 }]
      if (query.sql === 'pragma foreign_keys') return [{ foreign_keys: 0 }]
      if (query.sql === 'pragma main.foreign_key_check') return []

      if (query.sql === 'pragma main.integrity_check')
        return [{ integrity_check: options.integrityFailure ? 'corrupt' : 'ok' }]

      return [{ count: options.nullCount ?? 0 }]
    },
    /** Records physical commands and injects one selected acknowledgement failure. */
    async run(query) {
      calls.push(query.sql)

      if (options.busy && query.sql === 'begin immediate')
        throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' })

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

it('does not prepare or run DDL after a nonblocking BUSY coordination attempt', async () => {
  const test = fixture({ busy: true })
  await expect(test.execute()).rejects.toMatchObject({
    stage: 'lock',
    outcome: 'unchanged',
    retryable: true,
  })

  expect(test.prepare).not.toHaveBeenCalled()
  expect(test.calls).not.toContain(statement.sql)
  expect(test.calls).toContain('pragma busy_timeout=250')
})

it.each(['integrity', 'convergence'] as const)(
  'rolls back %s validation failure with provenance and cleanup evidence',
  async (kind) => {
    const primary = new MigrationError({
      message: 'convergence failed',
      stage: 'lowering',
    })

    const test = fixture({
      integrityFailure: kind === 'integrity',
      validationFailure: kind === 'convergence' ? primary : undefined,
      fail: 'restore',
    })

    await expect(test.execute()).rejects.toMatchObject({
      stage: 'validation',
      outcome: 'rolledBack',
      message: kind === 'integrity' ? 'SQLite integrity_check failed' : primary.message,
      sourceStepIndexes: [7],
      cleanupFailures: [{ stage: 'sessionCleanup', cause: new Error('restore failed') }],
    })

    expect(test.calls).toContain(statement.sql)
    expect(test.calls).toContain('rollback')
    expect(test.calls).not.toContain('commit')
    expect(test.discard).toHaveBeenCalled()
  },
)

it('retries BUSY only before one monotonic lock deadline', async () => {
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

it('classifies pre-coordination abort as retryable without preparation', async () => {
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

it('treats commit acknowledgement failure as unknown without rollback or unsafe cleanup', async () => {
  const test = fixture({ fail: 'commit' })
  await expect(test.execute()).rejects.toMatchObject({
    stage: 'commit',
    outcome: 'unknown',
    retryable: false,
  })

  expect(test.calls).not.toContain('rollback')
  expect(test.calls).not.toContain('pragma busy_timeout=250')
  expect(test.discard).toHaveBeenCalled()
})

it('retains structured preparation diagnostics and appends rollback cleanup evidence', async () => {
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
  expect(test.calls).not.toContain(statement.sql)
})

it('retains transaction-incompatible action provenance before any precondition or DDL', async () => {
  const test = fixture()
  const incompatible = {
    ...program(),
    actions: [{ ...program().actions[0]!, transaction: 'forbidden' as const }],
  }

  await expect(test.execute(incompatible)).rejects.toMatchObject({
    stage: 'lowering',
    outcome: 'unchanged',
    sourceStepIndexes: [7],
  })

  expect(test.calls).not.toContain(statement.sql)
})

it.each(['statement-atomic', 'non-atomic'] as const)(
  'rejects %s programs before preconditions and DDL',
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

it('reports attempted DDL as rolled back or unknown according to rollback acknowledgement', async () => {
  const rolledBack = fixture({ fail: 'ddl' })
  await expect(rolledBack.execute()).rejects.toMatchObject({
    stage: 'ddl',
    outcome: 'rolledBack',
    actionIndex: 0,
    sourceStepIndexes: [7],
  })

  expect(rolledBack.calls).toContain('rollback')

  const unknown = fixture({ fail: 'ddl', rollbackFailure: true })
  await expect(unknown.execute()).rejects.toMatchObject({
    stage: 'ddl',
    outcome: 'unknown',
    cleanupFailures: [{ stage: 'rollback' }],
  })

  expect(unknown.discard).toHaveBeenCalled()
})

it('retains an acknowledged applied outcome when post-commit busy-policy cleanup fails', async () => {
  const test = fixture({ fail: 'restore' })
  await expect(test.execute()).rejects.toMatchObject({
    stage: 'sessionCleanup',
    outcome: 'applied',
    cleanupFailures: [{ stage: 'sessionCleanup' }],
  })

  expect(test.discard).toHaveBeenCalled()
})

it('quotes a structured main relation and checks the authoritative NULL count', async () => {
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

it('runs DDL and commits after an authoritative zero-null precondition', async () => {
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
