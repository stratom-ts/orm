import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

import { compileSqliteOperationCommand } from '@/dialects/sqlite/operations'
import { createDb0NodeSqliteOperationSessionProvider } from '@/dialects/sqlite/operationSession'
import {
  OperationCoordinator,
  getOperationReleaseCleanupFailures,
} from '@/operations/coordinator'
import type {
  OperationSession,
  OperationSessionProvider,
} from '@/operations/operationSession'
import type { DriverError } from '@/utils/error'

import { deferred } from '../../helpers/deferredPromise'

import { closeSqliteProviders, createSqliteFileScope } from './sqliteNativeLifetime'

const files = createSqliteFileScope()
const filePath = files.filePath
afterEach(files.cleanup)

it('should return native SQLite counts through executor.run, including bigint changes', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance()
  const prepare = native.prepare.bind(native)

  const spy = vi.spyOn(native, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    statement.setReadBigInts(true)
    return statement
  })

  const coordinator = new OperationCoordinator(
    createDb0NodeSqliteOperationSessionProvider(connector),
  )

  try {
    await coordinator.run(async ({ executor }) => {
      await executor.run({ sql: 'create table records (id integer)', params: [] })

      await expect(
        executor.run({ sql: 'insert into records values (1), (2)', params: [] }),
      ).resolves.toBe(2)

      await expect(
        executor.run({ sql: 'update records set id = id where id = 3', params: [] }),
      ).resolves.toBe(0)

      await expect(
        executor.run({ sql: 'delete from records', params: [] }),
      ).resolves.toBe(2)
    })
  } finally {
    spy.mockRestore()
    await coordinator.close()
  }
})

it('should classify a native SQLite open probe failure as DriverError', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance()
  const prepareNative = native.prepare.bind(native)
  const cause = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })

  const prepare = vi.spyOn(native, 'prepare').mockImplementation((sql) => {
    if (sql === 'select 1') throw cause

    return prepareNative(sql)
  })

  const provider = createDb0NodeSqliteOperationSessionProvider(connector, 'custom-sqlite')

  try {
    const failure = await provider.open().catch((error: unknown) => error)
    expect(failure).toMatchObject({
      _tag: 'DriverError',
      dialect: 'custom-sqlite',
      code: 'SQLITE_BUSY',
      sql: 'select 1',
      kind: 'transient',
      retryable: true,
      cause,
    })
  } finally {
    prepare.mockRestore()
    await provider.close()
  }
})

it.each([
  { command: { kind: 'ping' } as const, sql: 'select 1', call: 'query' as const },
  {
    command: { kind: 'createSavepoint', id: 3 } as const,
    sql: 'savepoint sp_3',
    call: 'run' as const,
  },
])(
  'should classify a failed SQLite $command.kind native call',
  async ({ command, sql, call }) => {
    const connector = nodeSqliteConnector({ name: ':memory:' })
    const provider = createDb0NodeSqliteOperationSessionProvider(
      connector,
      'custom-sqlite',
    )

    const session = await provider.open()
    const native = await connector.getInstance()
    const originalPrepare = native.prepare.bind(native)
    const nativeCause = Object.assign(new Error('native lifecycle failure'), {
      code: 'SQLITE_TEST',
    })

    let executed = false

    const prepare = vi.spyOn(native, 'prepare').mockImplementation((statementSql) =>
      statementSql === sql
        ? ({
            /** Fails native row retrieval for ping. */
            all: () => {
              executed = true
              throw nativeCause
            },
            /** Sets the native integer mode before ping. */
            setReadBigInts: () => undefined,
            /** Fails native statement execution for savepoints. */
            run: () => {
              executed = true
              throw nativeCause
            },
          } as unknown as ReturnType<typeof native.prepare>)
        : originalPrepare(statementSql),
    )

    try {
      const compiled = compileSqliteOperationCommand(command)
      const failure = await session[call](compiled).catch((cause: unknown) => cause)

      expect(executed).toBe(true)

      expect(failure).toMatchObject({
        _tag: 'DriverError',
        dialect: 'custom-sqlite',
        code: 'SQLITE_TEST',
        sql,
        cause: nativeCause,
      })

      expect((failure as DriverError).cause).toBe(nativeCause)
    } finally {
      prepare.mockRestore()
      await session.release('discard')
      await provider.close()
    }
  },
)

it.each([undefined, null, 9, { code: 'SQLITE_CONSTRAINT_UNIQUE' }])(
  'should classify SQLite prepare rejection %s and retain its exact cause',
  async (nativeCause) => {
    const connector = nodeSqliteConnector({ name: ':memory:' })
    const provider = createDb0NodeSqliteOperationSessionProvider(
      connector,
      'custom-sqlite',
    )

    const session = await provider.open()
    const native = await connector.getInstance()
    const originalPrepare = native.prepare.bind(native)
    const sql = 'select ? as value'

    const prepare = vi.spyOn(native, 'prepare').mockImplementation((statement) => {
      if (statement === sql) throw nativeCause

      return originalPrepare(statement)
    })

    try {
      const error = await session
        .query({ sql, params: ['secret-bound-value'] })
        .catch((cause: unknown) => cause)

      expect(error).toMatchObject({
        _tag: 'DriverError',
        dialect: 'custom-sqlite',
        sql,
        cause: nativeCause,
      })

      expect((error as DriverError).code).toBe(
        nativeCause && typeof nativeCause === 'object' && 'code' in nativeCause
          ? nativeCause.code
          : undefined,
      )

      expect(error).not.toHaveProperty('params')
    } finally {
      prepare.mockRestore()
      await session.release('discard')
      await provider.close()
    }
  },
)

it('should preserve a result-normalization defect with its original identity and stack', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()
  const native = await connector.getInstance()
  const originalPrepare = native.prepare.bind(native)
  const defect = new TypeError('broken row getter')
  const originalStack = defect.stack
  const row = Object.defineProperty({}, 'value', {
    enumerable: true,
    /** Throws from Stratom's result normalization after the native call returns. */
    get() {
      throw defect
    },
  })

  const prepare = vi.spyOn(native, 'prepare').mockImplementation((sql) =>
    sql === 'select value from records'
      ? ({
          /** Supplies the malformed native row. */
          all: () => [row],
          /** Accepts the native integer mode. */
          setReadBigInts: () => undefined,
        } as unknown as ReturnType<typeof native.prepare>)
      : originalPrepare(sql),
  )

  try {
    const error = await session
      .query({ sql: 'select value from records', params: [] })
      .catch((cause: unknown) => cause)

    expect(error).toBe(defect)
    expect((error as Error).stack).toBe(originalStack)
  } finally {
    prepare.mockRestore()
    await session.release('discard')
    await provider.close()
  }
})

it.each([
  {
    name: 'frozen object',
    defect: Object.freeze(new TypeError('identity getter failed')),
  },
  { name: 'primitive', defect: 17 },
])('should retain a $name identity defect and disposal failure', async ({ defect }) => {
  const nativeConnector = nodeSqliteConnector({ name: ':memory:' })
  const database = await nativeConnector.getInstance()
  const prepareNative = database.prepare.bind(database)
  const cleanup = new Error('dispose failed')
  let disposals = 0
  const connector = {
    ...nativeConnector,
    dispose() {
      if (++disposals === 1) throw cleanup

      return nativeConnector.dispose!()
    },
  }

  const prepare = vi.spyOn(database, 'prepare').mockImplementation((sql) =>
    sql === 'pragma database_list'
      ? ({
          all: () => [
            Object.defineProperty({}, 'name', {
              get() {
                throw defect
              },
            }),
          ],
        } as unknown as ReturnType<typeof database.prepare>)
      : prepareNative(sql),
  )

  const provider = createDb0NodeSqliteOperationSessionProvider(connector)

  try {
    const failure = await provider.open().catch((cause: unknown) => cause)
    expect((failure as Error).cause).toBe(defect)
    expect(getOperationReleaseCleanupFailures(failure)).toEqual([cleanup])

    expect(failure).toMatchObject({
      cause: defect,
      cleanupFailures: [{ stage: 'sessionCleanup', cause: cleanup }],
    })
  } finally {
    prepare.mockRestore()
    await provider.close()
  }
})

/** Hides newer properties while retaining the real DatabaseSync methods and state. */
function legacyNative<T extends object>(native: T): T {
  return new Proxy(native, {
    /** Models the Node 22.5 surface with methods bound to the actual native instance. */
    get(target, key): unknown {
      if (key === 'isOpen' || key === 'isTransaction') return undefined

      const value: unknown = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** Creates a fixture with the Node 22.5 DatabaseSync property surface. */
async function baselineFixture() {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance()
  const legacy = legacyNative(native)

  return { native, connector: { ...connector, getInstance: () => legacy } }
}

it('should prove reuse and roll back external native transactions when modern flags are absent', async () => {
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

it('should reject a caller transaction when modern flags are absent and discard the instance', async () => {
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

it('should discard a baseline session when native rollback cannot prove cleanliness', async () => {
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

it('should bind values, select all/run members, and retain one physical instance on reuse', async () => {
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

it('should roll back an open transaction before reuse and support savepoints', async () => {
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

it('should share a connector lease across providers without closing the active transaction', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const first = createDb0NodeSqliteOperationSessionProvider(connector)
  const second = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await first.open()
  let active: OperationSession | undefined = session
  let primary: unknown

  try {
    await session.run({ sql: 'create table records(id INTEGER)', params: [] })
    await session.run({ sql: 'insert into records values(1)', params: [] })
    await session.run({ sql: 'begin', params: [] })
    await session.run({ sql: 'insert into records values(2)', params: [] })

    await expect(second.open()).rejects.toThrow(/already leased/)
    await second.close()

    expect(
      await session.query({ sql: 'select id from records order by id', params: [] }),
    ).toEqual([{ id: 1 }, { id: 2 }])

    await session.run({ sql: 'commit', params: [] })
    await session.release('reuse')
    active = undefined
    const next = await first.open()
    active = next

    expect(
      await next.query({ sql: 'select id from records order by id', params: [] }),
    ).toEqual([{ id: 1 }, { id: 2 }])

    await next.release('reuse')
    active = undefined
  } catch (cause) {
    primary = cause
  } finally {
    await second.close().catch((cause: unknown) => {
      primary ??= cause
    })

    await closeBaseline(first, active, primary)
  }
})

it('should keep a handed-off native lease alive when the earlier provider closes', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const first = createDb0NodeSqliteOperationSessionProvider(connector)
  const second = createDb0NodeSqliteOperationSessionProvider(connector)
  const initial = await first.open()
  await initial.run({ sql: 'create table records(id INTEGER)', params: [] })
  await initial.release('reuse')
  const handedOff = await second.open()
  let active: OperationSession | undefined = handedOff
  let primary: unknown

  try {
    expect(handedOff.identity).toEqual(initial.identity)
    await handedOff.run({ sql: 'begin', params: [] })
    await handedOff.run({ sql: 'insert into records values(3)', params: [] })
    await first.close()
    await handedOff.run({ sql: 'commit', params: [] })

    expect(await handedOff.query({ sql: 'select id from records', params: [] })).toEqual([
      { id: 3 },
    ])

    await handedOff.release('reuse')
    active = undefined
  } catch (cause) {
    primary = cause
  } finally {
    await first.close().catch((cause: unknown) => {
      primary ??= cause
    })

    await closeBaseline(second, active, primary)
  }
})

it('should reserve the shared lease before an asynchronous native lookup completes', async () => {
  const native = nodeSqliteConnector({ name: ':memory:' })
  const lookupStarted = deferred()
  const finishLookup = deferred()
  let reads = 0
  const connector = {
    ...native,
    async getInstance() {
      reads++

      if (reads === 1) {
        lookupStarted.resolve()
        await finishLookup.promise
      }

      return native.getInstance()
    },
  }

  const first = createDb0NodeSqliteOperationSessionProvider(connector)
  const second = createDb0NodeSqliteOperationSessionProvider(connector)
  const opening = first.open()
  await lookupStarted.promise
  const competing = second.open()
  const readsBeforeRelease = reads
  finishLookup.resolve()
  const session = await opening
  let active: OperationSession | undefined = session
  let primary: unknown

  try {
    await expect(competing).rejects.toThrow(/already leased/)
    expect(readsBeforeRelease).toBe(1)
    await session.run({ sql: 'begin', params: [] })
    await session.run({ sql: 'create table records(id INTEGER)', params: [] })
    await session.run({ sql: 'commit', params: [] })
    await session.release('reuse')
    active = undefined
  } catch (cause) {
    primary = cause
  } finally {
    const competingLease = await competing.catch(() => undefined)
    await competingLease?.release('discard').catch((cause: unknown) => {
      primary ??= cause
    })

    await second.close().catch((cause: unknown) => {
      primary ??= cause
    })

    await closeBaseline(first, active, primary)
  }
})

it('should reject connector aliases to an owned DatabaseSync without probing or disposing it', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance()
  const first = createDb0NodeSqliteOperationSessionProvider(connector)
  const alias = createDb0NodeSqliteOperationSessionProvider({
    ...connector,
    getInstance: () => native,
  })

  const unopenedAlias = createDb0NodeSqliteOperationSessionProvider({
    ...connector,
    getInstance: () => native,
  })

  const session = await first.open()
  let active: OperationSession | undefined = session
  let primary: unknown

  try {
    await session.run({ sql: 'create table records(id INTEGER)', params: [] })
    await session.run({ sql: 'begin', params: [] })
    await session.run({ sql: 'insert into records values(7)', params: [] })

    await expect(alias.open()).rejects.toThrow(/owned by another connector/)
    await alias.close()
    await unopenedAlias.close()
    await session.run({ sql: 'commit', params: [] })

    expect(await session.query({ sql: 'select id from records', params: [] })).toEqual([
      { id: 7 },
    ])

    await session.release('reuse')
    active = undefined
  } catch (cause) {
    primary = cause
  } finally {
    await Promise.all([alias.close(), unopenedAlias.close()]).catch((cause: unknown) => {
      primary ??= cause
    })

    await closeBaseline(first, active, primary)
  }
})

it.each(['native', 'legacy'] as const)(
  'should reject a stale native alias on the %s surface without disposing the live replacement',
  async (surface) => {
    const connector = nodeSqliteConnector({ name: ':memory:' })
    const stale = await connector.getInstance()
    const legacyStale = legacyNative(stale)
    const first = createDb0NodeSqliteOperationSessionProvider(connector)
    const alias = createDb0NodeSqliteOperationSessionProvider({
      ...connector,
      getInstance: () => (surface === 'legacy' ? legacyStale : stale),
    })

    let active: OperationSession | undefined
    let primary: unknown
    try {
      active = await first.open()
      await active.release('discard')
      active = await first.open()

      await active.run({ sql: 'create table records(id INTEGER)', params: [] })
      await active.run({ sql: 'insert into records values(1)', params: [] })
      await active.run({ sql: 'begin', params: [] })
      await active.run({ sql: 'insert into records values(2)', params: [] })

      await expect(alias.open()).rejects.toMatchObject({ _tag: 'QueryError' })
      await alias.close()

      expect(
        await active.query({ sql: 'select id from records order by id', params: [] }),
      ).toEqual([{ id: 1 }, { id: 2 }])

      await active.run({ sql: 'commit', params: [] })
      await active.release('reuse')
      active = undefined
    } catch (cause) {
      primary = cause
    } finally {
      await alias.close().catch((cause: unknown) => {
        primary ??= cause
      })

      await closeBaseline(first, active, primary)
    }
  },
)

it.each(['reuse', 'discard'] as const)(
  'should not affect another connector after a leased connector switches native targets on %s',
  async (disposition) => {
    const original = nodeSqliteConnector({ name: ':memory:' })
    const other = nodeSqliteConnector({ name: ':memory:' })
    const originalNative = await original.getInstance()
    const otherNative = await other.getInstance()
    let current = originalNative
    const first = createDb0NodeSqliteOperationSessionProvider({
      ...original,
      getInstance: () => current,
    })

    const second = createDb0NodeSqliteOperationSessionProvider(other)
    const firstLease = await first.open()
    const secondLease = await second.open()
    let activeFirst: OperationSession | undefined = firstLease
    let activeSecond: OperationSession | undefined = secondLease
    let primary: unknown

    try {
      await secondLease.run({ sql: 'create table records(id INTEGER)', params: [] })
      await secondLease.run({ sql: 'begin', params: [] })
      await secondLease.run({ sql: 'insert into records values(9)', params: [] })
      current = otherNative

      await expect(
        firstLease.release(disposition).finally(() => {
          activeFirst = undefined
        }),
      ).rejects.toMatchObject({ _tag: 'QueryError' })

      expect(
        await secondLease.query({ sql: 'select id from records', params: [] }),
      ).toEqual([{ id: 9 }])

      await secondLease.run({ sql: 'commit', params: [] })
      await secondLease.release('reuse')
      activeSecond = undefined
      expect(otherNative.prepare('select id from records').all()).toEqual([{ id: 9 }])
    } catch (cause) {
      primary = cause
    } finally {
      current = originalNative

      await closeBaseline(first, activeFirst, primary).catch((cause: unknown) => {
        primary ??= cause
      })

      await closeBaseline(second, activeSecond, primary)
    }
  },
)

it('should serialize concurrent native writes and bind a DataView without coercion', async () => {
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

it('should give separate file and memory databases separate identities and poison cancellation', async () => {
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

it('should use one canonical file identity across connectors while keeping physical sessions distinct', async () => {
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
      await closeSqliteProviders(sessions, [first, second, other])
    } finally {
      rmSync(junction, { recursive: true, force: true })
    }
  }
})

it('should keep file database identity distinct from independent memory identities', async () => {
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
    await closeSqliteProviders(sessions, [file, first, second])
  }
})

it('should drain an active lease on close and retry a failed connector disposal', async () => {
  const native = nodeSqliteConnector({ name: ':memory:' })
  const defect = new Error('dispose failed')
  let disposals = 0
  const provider = createDb0NodeSqliteOperationSessionProvider({
    ...native,
    /** Fails one cleanup attempt before delegating to db0. */
    dispose() {
      disposals++

      if (disposals === 1) throw defect

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
  expect(rejection).toBe(defect)
  await provider.close()
  expect(disposals).toBe(2)
  await expect(provider.open()).rejects.toMatchObject({ _tag: 'QueryError' })
})

it('should wait for the last provider teardown before a newly adapted provider opens', async () => {
  const native = nodeSqliteConnector({ name: ':memory:' })
  const disposalStarted = deferred()
  const finishDisposal = deferred()
  let reads = 0
  let disposals = 0
  const connector = {
    ...native,
    getInstance() {
      reads++
      return native.getInstance()
    },
    async dispose() {
      disposals++
      disposalStarted.resolve()
      await finishDisposal.promise
      return native.dispose!()
    },
  }

  const first = createDb0NodeSqliteOperationSessionProvider(connector)
  const initial = await first.open()
  const identity = initial.identity
  await initial.release('reuse')
  const closing = first.close()
  await disposalStarted.promise

  const second = createDb0NodeSqliteOperationSessionProvider(connector)
  const readsBeforeOpen = reads
  const opening = second.open()
  const readsDuringDisposal = reads
  finishDisposal.resolve()
  await closing
  const fresh = await opening
  let active: OperationSession | undefined = fresh
  let primary: unknown

  try {
    expect(readsDuringDisposal).toBe(readsBeforeOpen)
    expect(fresh.identity.physicalSession).not.toBe(identity.physicalSession)
    expect(disposals).toBe(1)
    await fresh.run({ sql: 'create table records(id INTEGER)', params: [] })
    await fresh.release('reuse')
    active = undefined
  } catch (cause) {
    primary = cause
  } finally {
    await closeBaseline(second, active, primary)
  }
})

it('should retry failed disposal after another provider adapts the connector', async () => {
  const native = nodeSqliteConnector({ name: ':memory:' })
  const defect = new Error('dispose failed')
  let disposals = 0
  const connector = {
    ...native,
    dispose() {
      disposals++

      if (disposals === 1) throw defect

      return native.dispose!()
    },
  }

  const first = createDb0NodeSqliteOperationSessionProvider(connector)
  const lease = await first.open()
  await lease.release('reuse')

  await expect(first.close()).rejects.toBe(defect)

  const second = createDb0NodeSqliteOperationSessionProvider(connector)
  let active: OperationSession | undefined
  let primary: unknown
  try {
    await expect(second.open()).rejects.toThrow(/requires successful close/)
    await first.close()
    const recovered = await second.open()
    active = recovered
    await recovered.run({ sql: 'create table records(id INTEGER)', params: [] })
    await recovered.release('reuse')
    active = undefined
    expect(disposals).toBe(2)
  } catch (cause) {
    primary = cause
  } finally {
    await closeBaseline(second, active, primary)
  }
})

it('should block new leases after repeated discard failure until close disposes the native database', async () => {
  const native = nodeSqliteConnector({ name: ':memory:' })
  const primary = new Error('dispose attempt 1')
  const cleanup = new Error('dispose attempt 2')
  let disposals = 0
  let instanceReads = 0
  const connector = {
    ...native,
    /** Counts native instance access to prove poisoned open never reaches db0. */
    getInstance() {
      instanceReads++
      return native.getInstance()
    },
    /** Fails both release disposal attempts, then permits close recovery. */
    dispose() {
      disposals++

      if (disposals <= 2) throw disposals === 1 ? primary : cleanup

      return native.dispose!()
    },
  }

  const provider = createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()
  const rejection: unknown = await session
    .release('discard')
    .catch((cause: unknown) => cause)

  expect((rejection as Error).cause).toBe(primary)
  expect(getOperationReleaseCleanupFailures(rejection)).toEqual([cleanup])

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

it('should share one successful close promise and dispose once after the active lease', async () => {
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
