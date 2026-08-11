import type { Connector } from 'db0'
import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { MigrationProgram } from '@/ddl/migrationProgram'
import { executeSqliteMigration } from '@/dialects/sqlite/migration'
import { createDb0NodeSqliteOperationSessionProvider } from '@/operations'
import type { Executor } from '@/query'
import { QueryError } from '@/utils/error'

import { registerMigrationCoordinationContract } from './migrationCoordinationContract'

const temporaryDirectories: string[] = []
const cleanupCallbacks: Array<() => Promise<void>> = []
let contractDirectory: string | undefined

afterEach(async () => {
  for (const cleanup of cleanupCallbacks.splice(0).reverse()) {
    await cleanup().catch(() => undefined)
  }
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
    } catch {
      // Windows can briefly retain SQLite handles after a failed assertion.
    }
  }
  contractDirectory = undefined
})

function connector(path: string): Connector {
  return nodeSqliteConnector({ cwd: '', path })
}

function program(
  statements: readonly string[] = ['create table created (id integer)'],
): MigrationProgram {
  return {
    atomicity: 'plan-atomic',
    preconditions: [],
    actions: [
      {
        sourceStepIndexes: [3],
        transaction: 'required',
        statements: statements.map((sql) => ({ sql, params: [] })) as [
          { sql: string; params: never[] },
          ...{ sql: string; params: never[] }[],
        ],
      },
    ],
  }
}

function sqliteContractRuntime(
  options: {
    holdAfterTransaction?: boolean
    lockResults?: boolean[]
    releaseResults?: boolean[]
    noWork?: boolean
  } = {},
) {
  contractDirectory ??= mkdtempSync(join(tmpdir(), 'stratom-sqlite-contract-'))
  temporaryDirectories.push(contractDirectory)
  const provider = createDb0NodeSqliteOperationSessionProvider(
    connector(join(contractDirectory, 'contract.db')),
  )
  let releaseHold!: () => void
  const held = options.holdAfterTransaction
    ? new Promise<void>((resolve) => {
        releaseHold = resolve
      })
    : undefined
  let session: Awaited<ReturnType<typeof provider.open>> | undefined
  let discarded = false
  const calls: string[] = []
  const semanticEvents: Array<
    'acquire' | 'release' | 'transaction' | 'introspection' | 'ddl'
  > = []
  const lockResults = [...(options.lockResults ?? [])]
  const releaseResults = [...(options.releaseResults ?? [])]
  let busyTimeoutDisabled = false
  const execute = async (
    runtimeOptions: { lockTimeoutMs?: number; signal?: AbortSignal } = {},
  ) => {
    session = await provider.open()
    const executor: Executor = {
      execute: (query) => {
        calls.push(query.sql)
        return session!.query(query)
      },
      run: (query) => {
        calls.push(query.sql)
        if (/^pragma busy_timeout=0$/i.test(query.sql)) {
          if (busyTimeoutDisabled) {
            semanticEvents.push('release')
            if (releaseResults.shift() === false)
              return Promise.reject(new Error('restore failed'))
          } else {
            busyTimeoutDisabled = true
          }
        }
        if (/^begin immediate$/i.test(query.sql)) {
          semanticEvents.push('acquire')
          if (lockResults.shift() === false) {
            return Promise.reject(
              Object.assign(new Error('busy'), { code: 'SQLITE_BUSY', errcode: 5 }),
            )
          }
        }
        if (/create table/i.test(query.sql)) semanticEvents.push('ddl')
        if (/^pragma busy_timeout=\d+$/i.test(query.sql) && !/=0/.test(query.sql)) {
          semanticEvents.push('release')
          if (releaseResults.shift() === false)
            return Promise.reject(new Error('restore failed'))
        }
        return session!.run(query)
      },
    }
    try {
      return await executeSqliteMigration({
        executor,
        databaseIdentity: 'contract',
        lockTimeoutMs: runtimeOptions.lockTimeoutMs ?? 100,
        ...(runtimeOptions.signal === undefined ? {} : { signal: runtimeOptions.signal }),
        discard: () => {
          discarded = true
        },
        cancel: () => session!.cancel(),
        prepare: async () => {
          semanticEvents.push('transaction')
          if (held) await held
          return options.noWork
            ? { atomicity: 'plan-atomic', preconditions: [], actions: [] }
            : program(['create table if not exists created (id integer)'])
        },
      })
    } finally {
      await session.release(discarded ? 'discard' : 'reuse').catch(() => undefined)
      await provider.close().catch(() => undefined)
      session = undefined
    }
  }
  return {
    execute,
    events: () => semanticEvents,
    releaseHold: () => releaseHold?.(),
    waitFor: async (
      event: 'acquire' | 'release' | 'transaction' | 'introspection' | 'ddl',
    ) => {
      while (!semanticEvents.includes(event))
        await new Promise<void>((resolve) => setImmediate(resolve))
    },
    cleanupStage: 'sessionCleanup' as const,
  }
}

registerMigrationCoordinationContract('SQLite', (options) =>
  sqliteContractRuntime({
    holdAfterTransaction: options?.holdAfterTransaction,
    lockResults: options?.lockResults,
    releaseResults: options?.releaseResults,
    noWork: options?.noWork,
  }),
)

describe('node:sqlite operation sessions', () => {
  it('executes binds and preserves a file identity across providers', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stratom-sqlite-'))
    temporaryDirectories.push(directory)
    const path = join(directory, 'test.db')
    const firstProvider = createDb0NodeSqliteOperationSessionProvider(connector(path))
    const secondProvider = createDb0NodeSqliteOperationSessionProvider(connector(path))
    const firstSession = await firstProvider.open()
    const secondSession = await secondProvider.open()
    cleanupCallbacks.push(
      () => secondProvider.close(),
      () => firstProvider.close(),
      () => secondSession.release('discard'),
      () => firstSession.release('discard'),
    )
    expect(firstSession.identity.database).toBe(secondSession.identity.database)
    expect(firstSession.identity.physicalSession).not.toBe(
      secondSession.identity.physicalSession,
    )
    await firstSession.run({ sql: 'create table values_table (value text)', params: [] })
    await firstSession.run({ sql: 'insert into values_table values (?)', params: ['ok'] })
    await expect(
      firstSession.query({
        sql: 'select value from values_table where value = ?',
        params: ['ok'],
      }),
    ).resolves.toEqual([{ value: 'ok' }])
    await expect(
      firstSession.query({
        sql: 'select sqlite_version() as sqlite_version, ? as node_value',
        params: [new Uint16Array([7])],
      }),
    ).resolves.toMatchObject([
      { sqlite_version: expect.any(String), node_value: expect.any(Uint8Array) },
    ])
    await firstSession.release('reuse')
    await secondSession.release('reuse')
    await firstProvider.close()
    await secondProvider.close()
  })

  it('rejects aliases, fake natives, unsupported binds, and repeated leases', async () => {
    for (const name of ['sqlite', 'sqlite3', 'better-sqlite3', 'LibSQL', 'custom']) {
      expect(() =>
        createDb0NodeSqliteOperationSessionProvider({
          name,
          dialect: 'sqlite',
          getInstance: () => undefined,
          exec: () => undefined,
          prepare: () => undefined as never,
          dispose: () => undefined,
        }),
      ).toThrow(QueryError)
    }
    const fake: Connector = {
      name: 'node-sqlite',
      dialect: 'sqlite',
      getInstance: () => ({
        isOpen: true,
        isTransaction: false,
        prepare: () => ({}),
        exec() {},
        close() {},
      }),
      exec: () => undefined,
      prepare: () => undefined as never,
      dispose: () => undefined,
    }
    await expect(
      createDb0NodeSqliteOperationSessionProvider(fake).open(),
    ).rejects.toBeInstanceOf(QueryError)
    const provider = createDb0NodeSqliteOperationSessionProvider(
      nodeSqliteConnector({ name: ':memory:' }),
    )
    const session = await provider.open()
    cleanupCallbacks.push(
      () => provider.close(),
      () => session.release('discard'),
    )
    await expect(provider.open()).rejects.toBeInstanceOf(QueryError)
    await expect(
      session.run({ sql: 'select ?', params: [{ unsupported: true }] }),
    ).rejects.toBeInstanceOf(QueryError)
    await session.cancel()
    await expect(session.query({ sql: 'select 1', params: [] })).rejects.toBeInstanceOf(
      QueryError,
    )
    await session.release('discard')
    await provider.close()
  })

  it('keeps memory identity stable for the same native object and separates natives', async () => {
    const connectorA = nodeSqliteConnector({ name: ':memory:' })
    const connectorB = nodeSqliteConnector({ name: ':memory:' })
    const providerA = createDb0NodeSqliteOperationSessionProvider(connectorA)
    const providerB = createDb0NodeSqliteOperationSessionProvider(connectorB)
    const first = await providerA.open()
    await first.release('reuse')
    const second = await providerA.open()
    const other = await providerB.open()
    cleanupCallbacks.push(
      () => providerB.close(),
      () => providerA.close(),
      () => other.release('discard'),
      () => second.release('discard'),
      () => first.release('discard'),
    )
    expect(second.identity.database).toBe(first.identity.database)
    expect(second.identity.physicalSession).toBe(first.identity.physicalSession)
    expect(other.identity.database).not.toBe(first.identity.database)
    await second.release('discard')
    await other.release('discard')
    await providerA.close()
    await providerB.close()
  })

  it('proves same-file contention and distinct-file independence with db0 connectors', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'stratom-sqlite-lock-'))
    temporaryDirectories.push(directory)
    const samePath = join(directory, 'same.db')
    const otherPath = join(directory, 'other.db')
    const firstProvider = createDb0NodeSqliteOperationSessionProvider(connector(samePath))
    const secondProvider = createDb0NodeSqliteOperationSessionProvider(
      connector(samePath),
    )
    const otherProvider = createDb0NodeSqliteOperationSessionProvider(
      connector(otherPath),
    )
    const first = await firstProvider.open()
    const second = await secondProvider.open()
    const other = await otherProvider.open()
    cleanupCallbacks.push(
      () => otherProvider.close(),
      () => secondProvider.close(),
      () => firstProvider.close(),
      () => other.release('discard'),
      () => second.release('discard'),
      () => first.release('discard'),
    )
    await first.run({ sql: 'begin immediate', params: [] })
    await second.run({ sql: 'pragma busy_timeout=0', params: [] })
    await expect(
      second.run({ sql: 'begin immediate', params: [] }),
    ).rejects.toBeInstanceOf(QueryError)
    await other.run({ sql: 'begin immediate', params: [] })
    await other.run({ sql: 'rollback', params: [] })
    await first.run({ sql: 'rollback', params: [] })
  })
})

describe('SQLite migration runtime', () => {
  it('begins before preparation and commits a plan-atomic program', async () => {
    const provider = createDb0NodeSqliteOperationSessionProvider(
      nodeSqliteConnector({ name: ':memory:' }),
    )
    const session = await provider.open()
    cleanupCallbacks.push(
      () => provider.close(),
      () => session.release('discard'),
    )
    const calls: string[] = []
    const executor: Executor = {
      execute: async (query) => {
        calls.push(query.sql)
        return session.query(query)
      },
      run: async (query) => {
        calls.push(query.sql)
        return session.run(query)
      },
    }
    let prepared = false
    await expect(
      executeSqliteMigration({
        executor,
        databaseIdentity: 'test',
        lockTimeoutMs: 0,
        discard: () => undefined,
        cancel: () => session.cancel(),
        prepare: async () => {
          prepared = true
          calls.push('prepare')
          return program()
        },
      }),
    ).resolves.toEqual({ outcome: 'applied' })
    expect(prepared).toBe(true)
    expect(calls.filter((sql) => sql === 'prepare')).toHaveLength(1)
    expect(calls.indexOf('begin immediate')).toBeLessThan(calls.indexOf('prepare'))
    await session.release('reuse')
    await provider.close()
  })

  it('rolls back real native SQLite data/schema changes after a later statement fails', async () => {
    const provider = createDb0NodeSqliteOperationSessionProvider(
      nodeSqliteConnector({ name: ':memory:' }),
    )
    const session = await provider.open()
    await session.run({ sql: 'create table original (id integer)', params: [] })
    await session.run({ sql: 'insert into original values (1)', params: [] })
    const executor: Executor = {
      execute: (query) => session.query(query),
      run: (query) => session.run(query),
    }
    await expect(
      executeSqliteMigration({
        executor,
        databaseIdentity: 'native',
        lockTimeoutMs: 0,
        discard: () => undefined,
        cancel: () => session.cancel(),
        prepare: async () => ({
          atomicity: 'plan-atomic',
          preconditions: [],
          actions: [
            {
              sourceStepIndexes: [9],
              transaction: 'required',
              statements: [
                { sql: 'insert into original values (2)', params: [] },
                { sql: 'create table original (id integer)', params: [] },
              ],
            },
          ],
        }),
      }),
    ).rejects.toMatchObject({ outcome: 'rolledBack' })
    await expect(
      session.query({ sql: 'select id from original order by id', params: [] }),
    ).resolves.toEqual([{ id: 1 }])
    await session.release('discard')
    await provider.close()
  })
})
