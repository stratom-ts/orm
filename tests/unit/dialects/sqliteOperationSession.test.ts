import type { Connector } from 'db0'
import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import type { OperationCommand } from '@/dialects'
import {
  compileSqliteOperationCommand,
  createDb0NodeSqliteOperationSessionProvider,
} from '@/dialects/sqlite'
import type {
  OperationSession,
  OperationSessionProvider,
} from '@/operations/operationSession'

const directories: string[] = []

/** Hides newer properties while retaining the real DatabaseSync methods and state. */
async function baselineFixture() {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance!()
  const legacy = new Proxy(native, {
    /** Models the Node 22.5 surface with methods bound to the actual native instance. */
    get(target, key): unknown {
      if (key === 'isOpen' || key === 'isTransaction') return undefined

      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  return { native, connector: { ...connector, getInstance: () => legacy } }
}

it('proves reuse and rolls back external native transactions when modern flags are absent', async () => {
  const { connector, native } = await baselineFixture()

  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()
  let active: OperationSession | undefined = session
  let primary: unknown
  try {
    await session.run({ sql: 'create table records(id INTEGER)', params: [] })
    native.exec('begin; insert into records values(1)')

    await session.release('reuse').finally(() => {
      active = undefined
    })

    const next = await provider.open()
    active = next
    expect(next.identity).toEqual(session.identity)
    expect(await next.query({ sql: 'select id from records', params: [] })).toEqual([])

    await next.release('reuse').finally(() => {
      active = undefined
    })

    native.prepare('begin').run()
    native.prepare('rollback').run()
  } catch (cause) {
    primary = cause
  } finally {
    await closeBaseline(provider, active, primary)
  }
})

/**
 * Closes unreleased baseline work while preserving the first assertion or cleanup
 * failure.
 */
async function closeBaseline(
  provider: OperationSessionProvider,
  active: OperationSession | undefined,
  primary: unknown,
): Promise<void> {
  if (active)
    await active.release('discard').catch((cause: unknown) => {
      primary ??= cause
    })

  await provider.close().catch((cause: unknown) => {
    primary ??= cause
  })

  if (primary !== undefined) throw primary
}

it('rejects a caller transaction when modern flags are absent and discards the instance', async () => {
  const { connector, native } = await baselineFixture()

  native.exec('begin')
  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  try {
    await expect(provider.open()).rejects.toMatchObject({
      _tag: 'QueryError',
      cause: { message: 'cannot start a transaction within a transaction' },
    })

    expect(() => native.prepare('select 1')).toThrow(/not open/)
  } finally {
    await provider.close()
  }
})

it('discards a baseline session when native rollback cannot prove cleanliness', async () => {
  const { connector, native } = await baselineFixture()

  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()
  const prepare = native.prepare.bind(native)

  const injected = vi.spyOn(native, 'prepare').mockImplementation((sql) => {
    if (sql === 'rollback') throw new Error('rollback acknowledgement failed')

    return prepare(sql)
  })

  try {
    await expect(session.release('reuse')).rejects.toMatchObject({
      cause: { message: 'rollback acknowledgement failed' },
    })

    expect(() => prepare('select 1')).toThrow(/not open/)
  } finally {
    injected.mockRestore()
    await provider.close()
  }
})

/** Creates a disposable native file path for one test. */
function filePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'stratom-sqlite-'))
  directories.push(directory)
  return join(directory, 'database.sqlite')
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

/** Releases every lease and closes its provider before temporary file cleanup. */
async function closeFileLeases(
  sessions: OperationSession[],
  providers: readonly OperationSessionProvider[],
): Promise<void> {
  try {
    await Promise.all(sessions.map((session) => session.release('discard')))
  } finally {
    await Promise.all(providers.map((provider) => provider.close()))
  }
}

it('binds values, selects all/run members, and retains one physical instance on reuse', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()
  await session.run({
    sql: 'create table records (id integer, value blob)',
    params: [],
  })

  await session.run({
    sql: 'insert into records values (?, ?)',
    params: [1, new Uint8Array([1, 2])],
  })

  expect(
    await session.query({ sql: 'select id, value from records', params: [] }),
  ).toMatchObject([{ id: 1, value: new Uint8Array([1, 2]) }])

  await expect(
    session.query({ sql: 'select ?', params: [Number.POSITIVE_INFINITY] }),
  ).rejects.toMatchObject({ _tag: 'QueryError' })

  await expect(session.run({ sql: 'select ?', params: [{}] })).rejects.toMatchObject({
    _tag: 'QueryError',
  })

  expect(
    await session.query({
      sql: 'select typeof(?) as nullType, typeof(?) as textType, typeof(?) as bigintType',
      params: [null, 'label', 123n],
    }),
  ).toEqual([{ nullType: 'null', textType: 'text', bigintType: 'integer' }])

  const firstIdentity = session.identity
  await session.release('reuse')

  await expect(session.query({ sql: 'select 1', params: [] })).rejects.toMatchObject({
    _tag: 'QueryError',
  })

  await expect(session.run({ sql: 'select 1', params: [] })).rejects.toMatchObject({
    _tag: 'QueryError',
  })

  const second = await provider.open()
  expect(second.identity).toEqual(firstIdentity)
  await second.release('reuse')
  await provider.close()
  await expect(provider.open()).rejects.toMatchObject({ _tag: 'QueryError' })
})

it('rolls back an open transaction before reuse and supports savepoints', async () => {
  const provider = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const session = await provider.open()
  await session.run({ sql: 'create table records (id integer)', params: [] })
  await session.run(compileSqliteOperationCommand({ kind: 'begin' }))
  await session.run({ sql: 'insert into records values (1)', params: [] })
  await session.run(compileSqliteOperationCommand({ kind: 'createSavepoint', id: 2 }))
  await session.run({ sql: 'insert into records values (2)', params: [] })

  await session.run(compileSqliteOperationCommand({ kind: 'rollbackToSavepoint', id: 2 }))

  await session.run(compileSqliteOperationCommand({ kind: 'releaseSavepoint', id: 2 }))

  expect(await session.query({ sql: 'select id from records', params: [] })).toEqual([
    { id: 1 },
  ])

  await session.release('reuse')
  const next = await provider.open()
  expect(await next.query({ sql: 'select id from records', params: [] })).toEqual([])
  await next.release('discard')
  await provider.close()
})

it('serializes concurrent native writes and binds a DataView without coercion', async () => {
  const provider = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const session = await provider.open()
  try {
    await session.run({
      sql: 'create table records (position integer, bytes blob)',
      params: [],
    })

    const bytes = new DataView(new Uint8Array([3, 4]).buffer)
    const [, , observed] = await Promise.all([
      session.run({ sql: 'insert into records values (?, ?)', params: [1, bytes] }),
      session.run({ sql: 'insert into records values (?, ?)', params: [2, bytes] }),
      session.query({
        sql: 'select position from records order by position',
        params: [],
      }),
    ])

    expect(observed).toEqual([{ position: 1 }, { position: 2 }])

    expect(
      await session.query({
        sql: 'select position, bytes from records order by position',
        params: [],
      }),
    ).toEqual([
      { position: 1, bytes: new Uint8Array([3, 4]) },
      { position: 2, bytes: new Uint8Array([3, 4]) },
    ])
  } finally {
    await session.release('discard')
    await provider.close()
  }
})

it('gives separate file and memory databases separate identities and poisons cancellation', async () => {
  const first = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const second = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const one = await first.open()
  const two = await second.open()
  expect(one.identity.database).not.toBe(two.identity.database)
  expect(one.identity.physicalSession).not.toBe(two.identity.physicalSession)
  await one.cancel()

  await expect(one.query({ sql: 'select 1', params: [] })).rejects.toMatchObject({
    _tag: 'QueryError',
  })

  await one.release('reuse')
  const replacement = await first.open()
  expect(replacement.identity.physicalSession).not.toBe(one.identity.physicalSession)
  expect(replacement.identity.database).not.toBe(one.identity.database)
  await replacement.release('discard')
  await two.release('discard')
  await first.close()
  await second.close()
})

it('uses one canonical file identity across connectors while keeping physical sessions distinct', async () => {
  const path = filePath()
  const junction = join(dirname(filePath()), 'main-alias')
  symlinkSync(dirname(path), junction, 'junction')
  const aliasPath = join(junction, 'database.sqlite')
  const first = createDb0NodeSqliteOperationSessionProvider(nodeSqliteConnector({ path }))
  const second = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ path: aliasPath }),
  )

  const other = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ path: filePath() }),
  )

  const sessions: OperationSession[] = []
  try {
    const one = await first.open()
    sessions.push(one)
    const two = await second.open()
    sessions.push(two)
    const three = await other.open()
    sessions.push(three)

    expect(aliasPath).not.toBe(path)
    expect(realpathSync.native(aliasPath)).toBe(realpathSync.native(path))
    expect(one.identity.database).toBe(two.identity.database)
    expect(one.identity.database).not.toBe(three.identity.database)
    expect(one.identity.physicalSession).not.toBe(two.identity.physicalSession)
  } finally {
    try {
      await closeFileLeases(sessions, [first, second, other])
    } finally {
      rmSync(junction, { recursive: true, force: true })
    }
  }
})

it('keeps file database identity distinct from independent memory identities', async () => {
  const file = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ path: filePath() }),
  )

  const first = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const second = createDb0NodeSqliteOperationSessionProvider(
    nodeSqliteConnector({ name: ':memory:' }),
  )

  const sessions: OperationSession[] = []
  try {
    const onDisk = await file.open()
    sessions.push(onDisk)
    const one = await first.open()
    sessions.push(one)
    const two = await second.open()
    sessions.push(two)

    expect(onDisk.identity.database).not.toBe(one.identity.database)
    expect(onDisk.identity.database).not.toBe(two.identity.database)
    expect(one.identity.database).not.toBe(two.identity.database)
  } finally {
    await closeFileLeases(sessions, [file, first, second])
  }
})

it('drains an active lease on close and retries a failed connector disposal', async () => {
  const native = nodeSqliteConnector({ name: ':memory:' })
  let disposals = 0
  const provider = createDb0NodeSqliteOperationSessionProvider({
    ...native,
    /** Fails one cleanup attempt before delegating to db0. */
    dispose() {
      disposals++

      if (disposals === 1) throw new Error('dispose failed')

      return native.dispose!()
    },
  })

  const session = await provider.open()
  let closed = false

  const pending = provider.close().then(() => {
    closed = true
  })

  await Promise.resolve()
  expect(closed).toBe(false)
  await session.release('reuse')
  const rejection: unknown = await pending.catch((cause: unknown) => cause)
  expect(rejection).toMatchObject({ _tag: 'QueryError' })
  expect((rejection as { cause: unknown }).cause).toBeInstanceOf(Error)
  await provider.close()
  expect(disposals).toBe(2)
  await expect(provider.open()).rejects.toMatchObject({ _tag: 'QueryError' })
})

it('blocks new leases after repeated discard failure until close disposes the native database', async () => {
  const native = nodeSqliteConnector({ name: ':memory:' })
  let disposals = 0
  let instanceReads = 0
  const connector = {
    ...native,
    /** Counts native instance access to prove poisoned open never reaches db0. */
    getInstance() {
      instanceReads++
      return native.getInstance!()
    },
    /** Fails both release disposal attempts, then permits close recovery. */
    dispose() {
      disposals++

      if (disposals <= 2) throw new Error(`dispose attempt ${disposals}`)

      return native.dispose!()
    },
  }

  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()
  const rejection: unknown = await session
    .release('discard')
    .catch((cause: unknown) => cause)

  expect(rejection).toMatchObject({
    _tag: 'QueryError',
    cause: { message: 'dispose attempt 1' },
    cleanupFailures: [
      { stage: 'sessionCleanup', cause: { cause: { message: 'dispose attempt 2' } } },
    ],
  })

  const readsBeforeReopen = instanceReads
  await expect(provider.open()).rejects.toThrow(/requires successful close/)
  expect(instanceReads).toBe(readsBeforeReopen)
  await provider.close()
  expect(disposals).toBe(3)

  const recovered = createDb0NodeSqliteOperationSessionProvider(connector)
  const fresh = await recovered.open()
  expect(fresh.identity.physicalSession).not.toBe(session.identity.physicalSession)
  await fresh.release('discard')
  await recovered.close()
})

it('shares one successful close promise and disposes once after the active lease', async () => {
  const native = nodeSqliteConnector({ name: ':memory:' })
  let disposals = 0
  const provider = createDb0NodeSqliteOperationSessionProvider({
    ...native,
    /** Counts connector teardown while using db0's real native disposal. */
    dispose() {
      disposals++
      return native.dispose!()
    },
  })

  const session = await provider.open()
  const first = provider.close()
  const second = provider.close()
  expect(second).toBe(first)
  expect(disposals).toBe(0)
  await session.release('reuse')
  await Promise.all([first, second])
  expect(disposals).toBe(1)
  expect(provider.close()).toBe(first)
})

const invalidConnectorCases = [
  { label: 'name', override: { name: 'custom-sqlite' } },
  { label: 'dialect', override: { dialect: 'other' } },
  { label: 'missing getInstance', override: {}, omit: 'getInstance' },
  { label: 'non-function getInstance', override: { getInstance: 7 } },
  { label: 'missing dispose', override: {}, omit: 'dispose' },
  { label: 'non-function dispose', override: { dispose: 7 } },
] as const

it.each(invalidConnectorCases)(
  'rejects exact connector shape mismatch: $label',
  ({ override, ...scenario }) => {
    const connector = nodeSqliteConnector({ name: ':memory:' })
    const candidate = { ...connector, ...override } as Connector

    if ('omit' in scenario) Reflect.deleteProperty(candidate, scenario.omit)

    expect(() => createDb0NodeSqliteOperationSessionProvider(candidate)).toThrow(
      /explicit operationSessionProvider/,
    )
  },
)

const commandCases: readonly { label: string; command: OperationCommand; sql: string }[] =
  [
    { label: 'ping', command: { kind: 'ping' }, sql: 'select 1' },
    { label: 'begin', command: { kind: 'begin' }, sql: 'begin' },
    { label: 'commit', command: { kind: 'commit' }, sql: 'commit' },
    { label: 'rollback', command: { kind: 'rollback' }, sql: 'rollback' },
    {
      label: 'createSavepoint',
      command: { kind: 'createSavepoint', id: 7 },
      sql: 'savepoint sp_7',
    },
    {
      label: 'rollbackToSavepoint',
      command: { kind: 'rollbackToSavepoint', id: 7 },
      sql: 'rollback to savepoint sp_7',
    },
    {
      label: 'releaseSavepoint',
      command: { kind: 'releaseSavepoint', id: 7 },
      sql: 'release savepoint sp_7',
    },
  ]

it.each(commandCases)(
  'compiles the exact $label operation command',
  ({ command, sql }) => {
    expect(compileSqliteOperationCommand(command)).toEqual({ sql, params: [] })
  },
)
