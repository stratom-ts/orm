import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'

import type { MigrationProgram } from '@/ddl/migrationProgram'
import { executeSqliteMigration } from '@/dialects/sqlite/migration/runtime'
import { createDb0NodeSqliteOperationSessionProvider } from '@/dialects/sqlite/operationSession'
import type {
  OperationSession,
  OperationSessionProvider,
} from '@/operations/operationSession'
import type { Executor } from '@/query'

const directories: string[] = []

/** Creates a disposable SQLite database path. */
function filePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'stratom-sqlite-migration-'))
  directories.push(directory)
  return join(directory, 'database.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

/** Creates one transaction-compatible physical program. */
function program(sql = 'create table records (id integer)'): MigrationProgram {
  return {
    atomicity: 'plan-atomic',
    preconditions: [],
    actions: [
      {
        sourceStepIndexes: [2],
        transaction: 'allowed',
        statements: [{ sql, params: [] }],
      },
    ],
  }
}

/** Projects the pinned session into the runtime executor contract. */
function executor(session: OperationSession): Executor {
  return { execute: (query) => session.query(query), run: (query) => session.run(query) }
}

/** Releases opened sessions before closing their owning connectors. */
async function closeProviders(
  sessions: OperationSession[],
  providers: readonly OperationSessionProvider[],
): Promise<void> {
  try {
    await Promise.all(sessions.map((session) => session.release('discard')))
  } finally {
    await Promise.all(providers.map((provider) => provider.close()))
  }
}

/** Clears the native writer and closes every file-backed resource. */
async function closeContention(
  owner: DatabaseSync,
  sessions: OperationSession[],
  providers: readonly OperationSessionProvider[],
): Promise<void> {
  try {
    if (owner.isTransaction) owner.exec('rollback')
  } finally {
    try {
      owner.close()
    } finally {
      await closeProviders(sessions, providers)
    }
  }
}

/** Runs one physical migration on the pinned native session. */
function runtime(
  session: OperationSession,
  input: {
    prepare?: () => Promise<MigrationProgram>
    lockTimeoutMs?: number
    signal?: AbortSignal
  } = {},
) {
  const execute = () =>
    executeSqliteMigration({
      executor: executor(session),
      databaseIdentity: session.identity.database,
      discard: () => undefined,
      cancel: () => session.cancel(),
      prepare: input.prepare ?? (async () => program()),
      ...(input.lockTimeoutMs === undefined
        ? {}
        : { lockTimeoutMs: input.lockTimeoutMs }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })

  return { execute }
}

it('reports engine version separately from the >=3.37 requirement', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const version = (
      db.prepare('select sqlite_version() as version').get() as { version: string }
    ).version

    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    const [major, minor] = version.split('.').map(Number)
    expect(major! > 3 || (major === 3 && minor! >= 37)).toBe(true)
  } finally {
    db.close()
  }
})

it('excludes the same file before preparation and leaves another file independent', async () => {
  const path = filePath()
  const owner = new DatabaseSync(path)
  const blockedProvider = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ path }),
  )

  const freeProvider = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ path: filePath() }),
  )

  const prepare = vi.fn<() => Promise<MigrationProgram>>(async () => program())
  const sessions: OperationSession[] = []
  try {
    owner.exec('begin immediate')
    const blockedSession = await blockedProvider.open()
    sessions.push(blockedSession)
    const freeSession = await freeProvider.open()
    sessions.push(freeSession)

    await expect(
      runtime(blockedSession, { prepare, lockTimeoutMs: 0 }).execute(),
    ).rejects.toMatchObject({ stage: 'lock', outcome: 'unchanged', retryable: true })

    expect(prepare).not.toHaveBeenCalled()
    expect(await runtime(freeSession).execute()).toEqual({ outcome: 'applied' })
  } finally {
    await closeContention(owner, sessions, [blockedProvider, freeProvider])
  }
})

it('starts BEGIN IMMEDIATE before prepare and commits ordered actions', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()
  const prepare = vi.fn<() => Promise<MigrationProgram>>(async () => {
    expect((await connector.getInstance!()).isTransaction).toBe(true)
    return program()
  })

  try {
    expect(await runtime(session, { prepare }).execute()).toEqual({
      outcome: 'applied',
    })

    expect(
      await session.query({
        sql: 'select name from sqlite_schema where name = ?',
        params: ['records'],
      }),
    ).toHaveLength(1)

    expect(prepare).toHaveBeenCalledTimes(1)
    expect((await connector.getInstance!()).isTransaction).toBe(false)
  } finally {
    await session.release('discard')
    await provider.close()
  }
})

it('rejects forbidden actions before preconditions or DDL and rolls back', async () => {
  const provider = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const session = await provider.open()
  const invalid = {
    ...program(),
    preconditions: [
      {
        kind: 'column_has_no_nulls' as const,
        relation: { namespace: [], relation: { spelling: 'x', comparisonKey: 'x' } },
        column: 'x',
        sourceStepIndexes: [1],
      },
    ],
    actions: [{ ...program().actions[0]!, transaction: 'forbidden' as const }],
  }

  try {
    await expect(
      runtime(session, { prepare: async () => invalid }).execute(),
    ).rejects.toMatchObject({ stage: 'lowering', outcome: 'unchanged' })

    expect(
      await session.query({
        sql: 'select name from sqlite_schema where name = ?',
        params: ['records'],
      }),
    ).toEqual([])
  } finally {
    await session.release('discard')
    await provider.close()
  }
})

it('rolls back attempted DDL and retains action provenance', async () => {
  const provider = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const session = await provider.open()
  const invalid = program('create table records (')
  try {
    await expect(
      runtime(session, { prepare: async () => invalid }).execute(),
    ).rejects.toMatchObject({
      stage: 'ddl',
      outcome: 'rolledBack',
      actionIndex: 0,
      sourceStepIndexes: [2],
    })
  } finally {
    await session.release('discard')
    await provider.close()
  }
})
