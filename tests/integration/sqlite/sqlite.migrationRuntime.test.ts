import nodeSqliteConnector from 'db0/connectors/node-sqlite'
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

import { inTransaction } from '../../helpers/nativeTransaction'

import { closeSqliteProviders, createSqliteFileScope } from './sqliteNativeLifetime'

const files = createSqliteFileScope()
const filePath = files.filePath
afterEach(files.cleanup)

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

/** Clears the native writer and closes every file-backed resource. */
async function closeContention(
  owner: DatabaseSync,
  sessions: OperationSession[],
  providers: readonly OperationSessionProvider[],
): Promise<void> {
  try {
    if (inTransaction(owner)) owner.exec('rollback')
  } finally {
    try {
      owner.close()
    } finally {
      await closeSqliteProviders(sessions, providers)
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

it('should report engine version separately from the >=3.37 requirement', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const version = (
      db.prepare('select sqlite_version() as version').get() as { version: string }
    ).version

    expect(version).toMatch(/^\d+\.\d+\.\d+$/)
    const [major, minor] = version.split('.').map(Number)
    expect(major > 3 || (major === 3 && minor >= 37)).toBe(true)
  } finally {
    db.close()
  }
})

it('should exclude the same file before preparation and leave another file independent', async () => {
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

it('should start BEGIN IMMEDIATE before prepare and commit ordered actions', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()
  const prepare = vi.fn<() => Promise<MigrationProgram>>(async () => {
    expect(inTransaction(await connector.getInstance())).toBe(true)
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
    expect(inTransaction(await connector.getInstance())).toBe(false)
  } finally {
    await session.release('discard')
    await provider.close()
  }
})

it('should reject forbidden actions before preconditions or DDL and roll back', async () => {
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
    actions: [{ ...program().actions[0], transaction: 'forbidden' as const }],
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

it('should roll back attempted DDL and retain action provenance', async () => {
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

function mixedGuardedProgram(): MigrationProgram {
  const identity = {
    namespace: [
      {
        role: 'database' as const,
        identifier: { spelling: 'main', comparisonKey: 'main' },
      },
    ],
    relation: { spelling: 'records', comparisonKey: 'records' },
  }

  return {
    atomicity: 'plan-atomic',
    preconditions: ['safe', 'unsafe'].map((name, index) => ({
      kind: 'column_has_only_nulls' as const,
      target: {
        kind: 'column' as const,
        relation: identity,
        column: { spelling: name, comparisonKey: name },
      },
      sourceStepIndexes: [index],
    })),
    actions: [
      {
        sourceStepIndexes: [0],
        transaction: 'required',
        statements: [{ sql: 'alter table records drop column safe', params: [] }],
      },
      {
        sourceStepIndexes: [1],
        transaction: 'required',
        statements: [
          {
            sql: 'create table replacement(id integer primary key, added text)',
            params: [],
          },
        ],
      },
      {
        sourceStepIndexes: [2],
        transaction: 'required',
        statements: [{ sql: 'alter table records add column added text', params: [] }],
      },
    ],
  }
}

function recordsSnapshot(owner: DatabaseSync) {
  return {
    schema: owner
      .prepare("select name,sql from sqlite_schema where type='table' order by name")
      .all(),
    rows: owner.prepare('select * from records').all(),
  }
}

it('checks every guard before a mixed rebuild program changes the schema', async () => {
  const path = filePath()
  const owner = new DatabaseSync(path)
  const provider = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ path }),
  )

  const session = await provider.open()
  const ddl: string[] = []
  const observed: Executor = {
    execute: (query) => session.query(query),
    run: async (query) => {
      if (/^(?:create|alter|drop)\s/i.test(query.sql)) ddl.push(query.sql)

      return session.run(query)
    },
  }

  try {
    owner.exec(
      "create table records(id integer primary key, safe text, unsafe text); insert into records values(1,null,'kept')",
    )

    const before = recordsSnapshot(owner)
    const failure = await executeSqliteMigration({
      executor: observed,
      databaseIdentity: session.identity.database,
      discard: () => undefined,
      cancel: () => session.cancel(),
      prepare: async () => mixedGuardedProgram(),
    }).catch((cause: unknown) => cause)

    expect(failure).toMatchObject({
      stage: 'precondition',
      outcome: 'unchanged',
      preconditionFailure: { reason: 'contains_non_null_values' },
    })

    expect(ddl).toEqual([])

    expect(recordsSnapshot(owner)).toEqual(before)
  } finally {
    await session.release('discard')
    await provider.close()
    owner.close()
  }
})

function guardedRebuildProgram(): MigrationProgram {
  const identity = {
    namespace: [
      {
        role: 'database' as const,
        identifier: { spelling: 'main', comparisonKey: 'main' },
      },
    ],
    relation: { spelling: 'records', comparisonKey: 'records' },
  }

  return {
    atomicity: 'plan-atomic',
    preconditions: [
      {
        kind: 'column_has_only_nulls',
        target: {
          kind: 'column',
          relation: identity,
          column: { spelling: 'removed', comparisonKey: 'removed' },
        },
        sourceStepIndexes: [0],
      },
    ],
    actions: [
      {
        sourceStepIndexes: [0],
        transaction: 'required',
        statements: [
          { sql: 'create table replacement(id integer primary key)', params: [] },
          { sql: 'insert into replacement select id from records', params: [] },
          { sql: 'drop table records', params: [] },
          { sql: 'alter table replacement rename to records', params: [] },
        ],
      },
    ],
  }
}

function executePausedGuard(
  session: OperationSession,
  migrationProgram: MigrationProgram,
  checked: () => void,
  gate: Promise<void>,
) {
  return executeSqliteMigration({
    executor: {
      execute: async (query) => {
        const rows = await session.query(query)

        if (query.sql.startsWith('select exists(')) {
          checked()
          await gate
        }

        return rows
      },
      run: (query) => session.run(query),
    },
    databaseIdentity: session.identity.database,
    discard: () => undefined,
    cancel: () => session.cancel(),
    prepare: async () => migrationProgram,
  })
}

async function assertWriterBlockedDuringGuard(
  owner: DatabaseSync,
  guardChecked: Promise<void>,
  migration: Promise<unknown>,
  release: () => void,
) {
  try {
    await Promise.race([
      guardChecked,
      migration.then(
        () => {
          throw new Error('migration completed before guard hook')
        },
        (cause: unknown) => {
          throw cause
        },
      ),
    ])

    owner.exec('pragma busy_timeout=0')

    expect(() => owner.exec("update records set removed='too late'")).toThrow(
      /locked|busy/i,
    )
  } finally {
    release()
    await migration.catch(() => undefined)
  }
}

it('keeps an independent writer out after checking a guarded rebuild', async () => {
  const path = filePath()
  const owner = new DatabaseSync(path)
  const provider = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ path }),
  )

  const session = await provider.open()
  let checked!: () => void
  const guardChecked = new Promise<void>((resolve) => {
    checked = resolve
  })

  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const migrationProgram = guardedRebuildProgram()

  try {
    owner.exec(
      'create table records(id integer primary key, removed text); insert into records values(1,null)',
    )

    owner.exec("update records set removed='committed first'")

    await expect(
      runtime(session, { prepare: async () => migrationProgram }).execute(),
    ).rejects.toMatchObject({
      stage: 'precondition',
      preconditionFailure: { reason: 'contains_non_null_values' },
    })

    owner.exec('update records set removed=null')

    const migration = executePausedGuard(session, migrationProgram, checked, gate)

    await assertWriterBlockedDuringGuard(owner, guardChecked, migration, release)

    await expect(migration).resolves.toEqual({ outcome: 'applied' })
    expect(owner.prepare('select id from records').all()).toEqual([{ id: 1 }])
  } finally {
    release()
    await session.release('discard')
    await provider.close()
    owner.close()
  }
})
