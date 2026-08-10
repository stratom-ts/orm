import { describe, expect, it, vi } from 'vitest'

import type { MigrationProgram } from '@/ddl/migrationProgram'
import { executePostgresMigration } from '@/dialects/postgres/migration'
import {
  MIGRATE_ADVISORY_LOCK_CLASS,
  MIGRATE_ADVISORY_LOCK_ID,
} from '@/migrations/coordinationScope'
import { createDb0PostgresqlOperationSessionProvider } from '@/operations/operationSession'
import type { Executor } from '@/query'

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

function harness(
  options: {
    failRun?: RegExp
    failUnlock?: boolean
    unlockResult?: boolean
    nullCount?: number
    lockResults?: Array<boolean | Error>
    lockDelayMs?: number
    hangQuery?: RegExp
    hangRun?: RegExp
  } = {},
) {
  const calls: string[] = []
  const discard = vi.fn()
  const prepare = vi.fn(async (migrationProgram: MigrationProgram) => migrationProgram)
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
      if (options.hangRun?.test(query.sql)) await hang()
      if (options.failRun?.test(query.sql)) throw new Error(`failed: ${query.sql}`)
    },
    async execute(query) {
      calls.push(query.sql)
      if (options.hangQuery?.test(query.sql)) await hang()
      if (/pg_try_advisory_lock/i.test(query.sql)) {
        if (options.lockDelayMs !== undefined) {
          await new Promise((resolve) => setTimeout(resolve, options.lockDelayMs))
        }
        const result = options.lockResults?.shift() ?? true
        if (result instanceof Error) throw result
        return [{ locked: result }]
      }
      if (/pg_advisory_unlock/i.test(query.sql)) {
        if (options.failUnlock) throw new Error('unlock failed')
        return [{ unlocked: options.unlockResult ?? true }]
      }
      if (/count\(\*\)/i.test(query.sql)) return [{ count: options.nullCount ?? 0 }]
      return []
    },
  }
  const execute = (
    migrationProgram = program(),
    runtimeOptions: { signal?: AbortSignal; lockTimeoutMs?: number } = {},
  ) =>
    executePostgresMigration({
      executor,
      databaseIdentity: 'test',
      lockTimeoutMs: runtimeOptions.lockTimeoutMs ?? 1_000,
      ...(runtimeOptions.signal === undefined ? {} : { signal: runtimeOptions.signal }),
      discard,
      cancel,
      prepare: () => prepare(migrationProgram),
    })
  return { calls, cancel, discard, execute, prepare }
}

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

  const databaseUrl = process.env.DATABASE_URL
  it.skipIf(!databaseUrl)(
    'keeps one real backend and restores the catalog after a DDL rollback',
    async () => {
      const { Client } = await import('pg')
      const client = new Client({ connectionString: databaseUrl })
      const table = `stratom_runtime_${process.pid}_${Date.now()}`
      await client.connect()
      try {
        const [{ backend }] = (
          await client.query<{ backend: string }>(
            'select pg_backend_pid()::text as backend',
          )
        ).rows
        const executor: Executor = {
          async run(query) {
            await client.query(query.sql, query.params)
          },
          async execute(query) {
            return (await client.query(query.sql, query.params)).rows
          },
        }
        const failedProgram: MigrationProgram = {
          atomicity: 'plan-atomic',
          preconditions: [],
          actions: [
            {
              sourceStepIndexes: [0],
              transaction: 'required',
              statements: [
                { sql: `create table "${table}" (id integer)`, params: [] },
                {
                  sql: `alter table "${table}" add constraint broken check (`,
                  params: [],
                },
              ],
            },
          ],
        }

        const error = await executePostgresMigration({
          executor,
          databaseIdentity: (await client.query('select current_database() as name'))
            .rows[0].name as string,
          lockTimeoutMs: 5_000,
          discard() {},
          async cancel() {},
          prepare: async () => failedProgram,
        }).catch((cause: unknown) => cause)
        const restored = await client.query<{
          backend: string
          relation: string | null
        }>(
          'select pg_backend_pid()::text as backend, to_regclass($1)::text as relation',
          [`public.${table}`],
        )

        expect(error).toMatchObject({ outcome: 'rolledBack', stage: 'ddl' })
        expect(restored.rows[0]).toEqual({ backend, relation: null })
      } finally {
        await client.query(`drop table if exists "${table}"`).catch(() => undefined)
        await client.end()
      }
    },
    15_000,
  )

  it.skipIf(!databaseUrl)(
    'returns no-wait contention without preparing or running DDL on real PostgreSQL',
    async () => {
      const [{ Client }, { default: postgresql }] = await Promise.all([
        import('pg'),
        import('db0/connectors/postgresql'),
      ])
      const locker = new Client({ connectionString: databaseUrl })
      const provider = createDb0PostgresqlOperationSessionProvider(
        postgresql({ url: databaseUrl as string }),
      )
      let session: Awaited<ReturnType<typeof provider.open>> | undefined
      let discard = false
      await locker.connect()
      try {
        await locker.query('select pg_advisory_lock($1, $2)', [
          MIGRATE_ADVISORY_LOCK_CLASS,
          MIGRATE_ADVISORY_LOCK_ID,
        ])
        session = await provider.open()
        const runSql: string[] = []
        const prepare = vi.fn(async () => program({ actions: [] }))
        const error = await executePostgresMigration({
          executor: {
            execute: (query) => session!.query(query),
            run: async (query) => {
              runSql.push(query.sql)
              await session!.run(query)
            },
          },
          databaseIdentity: session.identity.database,
          lockTimeoutMs: 0,
          discard() {
            discard = true
          },
          cancel: () => session!.cancel(),
          prepare,
        }).catch((cause: unknown) => cause)

        expect(error).toMatchObject({
          stage: 'lock',
          outcome: 'unchanged',
          retryable: true,
        })
        expect(prepare).not.toHaveBeenCalled()
        expect(runSql).toEqual([])
      } finally {
        if (session) await session.release(discard ? 'discard' : 'reuse')
        await provider.close()
        await locker
          .query('select pg_advisory_unlock($1, $2)', [
            MIGRATE_ADVISORY_LOCK_CLASS,
            MIGRATE_ADVISORY_LOCK_ID,
          ])
          .catch(() => undefined)
        await locker.end()
      }
    },
    15_000,
  )
})
