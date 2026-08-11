import { describe, expect, it, vi } from 'vitest'

import type { MigrationProgram } from '@/ddl/migrationProgram'
import { executeSqliteMigration } from '@/dialects/sqlite/migration'
import type { Executor } from '@/query'

const relation = {
  namespace: [
    {
      role: 'database' as const,
      identifier: { spelling: 'main', comparisonKey: 'main' },
    },
  ],
  relation: { spelling: 'odd"table', comparisonKey: 'odd"table' },
}

function program(overrides: Partial<MigrationProgram> = {}): MigrationProgram {
  return {
    atomicity: 'plan-atomic',
    preconditions: [],
    actions: [
      {
        sourceStepIndexes: [4],
        transaction: 'required',
        statements: [{ sql: 'create table created (id integer)', params: [] }],
      },
    ],
    ...overrides,
  }
}

function harness(
  options: {
    beginFailures?: unknown[]
    fail?: RegExp
    restoreFailure?: boolean
    rollbackFailure?: boolean
    nullCount?: number
  } = {},
) {
  const calls: string[] = []
  const beginFailures = [...(options.beginFailures ?? [])]
  const discard = vi.fn()
  const prepare = vi.fn(async () => program())
  const executor: Executor = {
    async execute(query) {
      calls.push(query.sql)
      if (/pragma busy_timeout$/i.test(query.sql)) return [{ timeout: 125 }]
      if (/count\(\*\)/i.test(query.sql)) return [{ count: options.nullCount ?? 0 }]
      return []
    },
    async run(query) {
      calls.push(query.sql)
      if (/^begin immediate$/i.test(query.sql)) {
        const failure = beginFailures.shift()
        if (failure !== undefined) throw failure
      }
      if (options.fail?.test(query.sql)) throw new Error(`failed ${query.sql}`)
      if (options.rollbackFailure && /^rollback$/i.test(query.sql))
        throw new Error('rollback failed')
      if (
        options.restoreFailure &&
        /^pragma busy_timeout=/i.test(query.sql) &&
        !/=0$/i.test(query.sql)
      ) {
        throw new Error('restore failed')
      }
    },
  }
  const execute = (
    migrationProgram: MigrationProgram = program(),
    runtimeOptions: { signal?: AbortSignal; lockTimeoutMs?: number } = {},
  ) =>
    executeSqliteMigration({
      executor,
      databaseIdentity: 'test',
      lockTimeoutMs: runtimeOptions.lockTimeoutMs ?? 100,
      ...(runtimeOptions.signal === undefined ? {} : { signal: runtimeOptions.signal }),
      discard,
      cancel: vi.fn(async () => undefined),
      prepare: () => prepare().then(() => migrationProgram),
    })
  return { calls, discard, prepare, execute }
}

describe('SQLite migration runtime failure matrix', () => {
  it('prepares once only after BEGIN and rejects forbidden/non-atomic programs before work', async () => {
    const runtime = harness()
    const error = await runtime
      .execute({
        atomicity: 'statement-atomic',
        preconditions: [
          {
            kind: 'column_has_no_nulls',
            relation,
            column: 'value',
            sourceStepIndexes: [1],
          },
        ],
        actions: [],
      })
      .catch((cause: unknown) => cause)
    expect(error).toMatchObject({ stage: 'lowering', outcome: 'unchanged' })
    expect(runtime.prepare).toHaveBeenCalledTimes(1)
    expect(runtime.calls).toContain('begin immediate')
    expect(runtime.calls.some((sql) => /count|create table/i.test(sql))).toBe(false)
    expect(runtime.calls).toContain('rollback')
  })

  it('performs one BEGIN for timeout zero and retries only busy failures', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY', errcode: 5 })
    const timeout = harness({ beginFailures: [busy] })
    await expect(
      timeout.execute(program({ actions: [] }), { lockTimeoutMs: 0 }),
    ).rejects.toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })
    expect(timeout.calls.filter((sql) => /^begin immediate$/i.test(sql))).toHaveLength(1)
    expect(timeout.discard).not.toHaveBeenCalled()
    const nonBusy = harness({ beginFailures: [new Error('syntax')] })
    await expect(nonBusy.execute()).rejects.toMatchObject({
      stage: 'lock',
      retryable: false,
    })
    expect(nonBusy.calls.filter((sql) => /^begin immediate$/i.test(sql))).toHaveLength(1)
    expect(nonBusy.discard).toHaveBeenCalled()
  })

  it('reports abort during a finite BUSY retry as cancellation, not timeout', async () => {
    const busy = Object.assign(new Error('busy'), { code: 'SQLITE_BUSY', errcode: 5 })
    const runtime = harness({ beginFailures: [busy, busy] })
    const controller = new AbortController()
    const pending = runtime.execute(program({ actions: [] }), {
      lockTimeoutMs: 100,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 1)
    await expect(pending).rejects.toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })
    expect(runtime.prepare).not.toHaveBeenCalled()
    expect(runtime.calls.some((sql) => /busy_timeout=125/i.test(sql))).toBe(false)
  })

  it('retries numeric BUSY/LOCKED codes before success and safely reuses finite timeout sessions', async () => {
    const busy = (errcode: number) => Object.assign(new Error('busy'), { errcode })
    const succeeds = harness({ beginFailures: [busy(5), busy(6)] })
    await expect(
      succeeds.execute(program({ actions: [] }), { lockTimeoutMs: 100 }),
    ).resolves.toEqual({
      outcome: 'unchanged',
    })
    expect(succeeds.calls.filter((sql) => /^begin immediate$/i.test(sql))).toHaveLength(3)
    expect(succeeds.calls).toContain('pragma busy_timeout=125')
    expect(succeeds.discard).not.toHaveBeenCalled()
    const permanent = harness({
      beginFailures: Array.from({ length: 20 }, () => busy(5)),
    })
    await expect(
      permanent.execute(program({ actions: [] }), { lockTimeoutMs: 20 }),
    ).rejects.toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })
    expect(permanent.prepare).not.toHaveBeenCalled()
    expect(permanent.calls).toContain('pragma busy_timeout=125')
    expect(permanent.discard).not.toHaveBeenCalled()
  })

  it('quotes structured SQLite preconditions and preserves provenance on DDL rollback', async () => {
    const precondition = harness({ nullCount: 1 })
    await expect(
      precondition.execute(
        program({
          preconditions: [
            {
              kind: 'column_has_no_nulls',
              relation,
              column: 'col"x',
              sourceStepIndexes: [7],
            },
          ],
          actions: [],
        }),
      ),
    ).rejects.toMatchObject({ stage: 'precondition', outcome: 'unchanged' })
    expect(precondition.calls.join('\n')).toContain('"main"."odd""table"')
    const ddl = harness({ fail: /^create table/ })
    await expect(ddl.execute()).rejects.toMatchObject({
      stage: 'ddl',
      outcome: 'rolledBack',
      actionIndex: 0,
      sourceStepIndexes: [4],
    })
    expect(ddl.calls).toContain('rollback')
  })

  it('keeps commit ambiguity distinct from a pre-commit abort and retains cleanup evidence', async () => {
    const commit = harness({ fail: /^commit$/ })
    await expect(commit.execute()).rejects.toMatchObject({
      outcome: 'unknown',
      stage: 'commit',
    })
    expect(commit.calls).not.toContain('rollback')
    const cleanup = harness({ restoreFailure: true })
    await expect(cleanup.execute()).rejects.toMatchObject({
      outcome: 'applied',
      stage: 'sessionCleanup',
      cleanupFailures: [{ stage: 'sessionCleanup' }],
    })
    const controller = new AbortController()
    const aborted = harness()
    aborted.prepare.mockImplementation(async () => {
      controller.abort()
      return program()
    })
    await expect(
      aborted.execute(program(), { signal: controller.signal }),
    ).rejects.toMatchObject({
      stage: 'introspection',
      outcome: 'unchanged',
      retryable: true,
    })
    expect(aborted.calls).toContain('rollback')
    expect(
      aborted.calls.some((sql) => /busy_timeout=/i.test(sql) && !/=0$/i.test(sql)),
    ).toBe(false)
  })

  it('classifies rollback failures by whether DDL was attempted and never restores uncertain sessions', async () => {
    const beforeDdl = harness({ rollbackFailure: true, nullCount: 1 })
    await expect(
      beforeDdl.execute(
        program({
          preconditions: [
            {
              kind: 'column_has_no_nulls',
              relation,
              column: 'value',
              sourceStepIndexes: [2],
            },
          ],
          actions: [],
        }),
      ),
    ).rejects.toMatchObject({
      outcome: 'unchanged',
      cleanupFailures: [{ stage: 'rollback' }],
    })
    expect(beforeDdl.calls.some((sql) => /busy_timeout=125/i.test(sql))).toBe(false)
    const afterDdl = harness({ fail: /^create table/, rollbackFailure: true })
    await expect(afterDdl.execute()).rejects.toMatchObject({
      outcome: 'unknown',
      cleanupFailures: [{ stage: 'rollback' }],
    })
    expect(afterDdl.calls.some((sql) => /busy_timeout=125/i.test(sql))).toBe(false)
  })

  it('keeps no-op cleanup failures unchanged and preserves allowed/required action order', async () => {
    const noop = harness({ restoreFailure: true })
    await expect(noop.execute(program({ actions: [] }))).rejects.toMatchObject({
      outcome: 'unchanged',
      stage: 'sessionCleanup',
    })
    const ordered = harness()
    const orderedProgram = program({
      actions: [
        {
          sourceStepIndexes: [1],
          transaction: 'allowed',
          statements: [
            { sql: 'insert into first values (1)', params: [] },
            { sql: 'insert into first values (2)', params: [] },
          ],
        },
        {
          sourceStepIndexes: [2],
          transaction: 'required',
          statements: [{ sql: 'insert into second values (3)', params: [] }],
        },
      ],
    })
    await expect(ordered.execute(orderedProgram)).resolves.toEqual({ outcome: 'applied' })
    expect(ordered.calls.indexOf('insert into first values (1)')).toBeLessThan(
      ordered.calls.indexOf('insert into first values (2)'),
    )
    expect(ordered.calls.indexOf('insert into first values (2)')).toBeLessThan(
      ordered.calls.indexOf('insert into second values (3)'),
    )
  })
})
