import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { describe, expect, it } from 'vitest'

import { createDb0NodeSqliteOperationSessionProvider } from '@/operations'
import { QueryError } from '@/utils/error'

describe('db0 node-sqlite operation-session provider', () => {
  it('serializes work, supports typed views, and rejects unsupported binds', async () => {
    const provider = createDb0NodeSqliteOperationSessionProvider(
      nodeSqliteConnector({ name: ':memory:' }),
    )
    const session = await provider.open()
    await session.run({ sql: 'create table values_table (value blob)', params: [] })
    const first = session.run({
      sql: 'insert into values_table values (?)',
      params: [new Uint8Array([1])],
    })
    const second = session.run({
      sql: 'insert into values_table values (?)',
      params: [new DataView(new ArrayBuffer(2))],
    })
    await Promise.all([first, second])
    await expect(
      session.run({
        sql: 'insert into values_table values (?)',
        params: [{ bad: true }],
      }),
    ).rejects.toBeInstanceOf(QueryError)
    await session.release('discard')
    await provider.close()
  })

  it('poisons a cancelled lease and rejects a second lease while active', async () => {
    const provider = createDb0NodeSqliteOperationSessionProvider(
      nodeSqliteConnector({ name: ':memory:' }),
    )
    const session = await provider.open()
    await expect(provider.open()).rejects.toBeInstanceOf(QueryError)
    await session.cancel()
    await expect(session.run({ sql: 'select 1', params: [] })).rejects.toBeInstanceOf(
      QueryError,
    )
    await expect(session.release('reuse')).resolves.toBeUndefined()
    await provider.close()
  })

  it('does not start a native call across the verify/cancel microtask boundary', async () => {
    const base = nodeSqliteConnector({ name: ':memory:' })
    const connector = {
      ...base,
      getInstance: async () => {
        await Promise.resolve()
        return base.getInstance()
      },
    }
    const provider = createDb0NodeSqliteOperationSessionProvider(connector)
    const session = await provider.open()
    const pending = session.query({ sql: 'select 1', params: [] })
    await session.cancel()
    await expect(pending).rejects.toBeInstanceOf(QueryError)
    await session.release('discard')
    await provider.close()
  })

  it('rejects a structurally similar fake native and normalizes synchronous connector errors', async () => {
    const fakeConnector = {
      name: 'node-sqlite' as const,
      dialect: 'sqlite' as const,
      getInstance: () => ({
        isOpen: true,
        isTransaction: false,
        prepare: () => ({ all: () => [], run: () => undefined }),
        exec: () => undefined,
        close: () => undefined,
      }),
      exec: () => undefined,
      prepare: () => undefined as never,
      dispose: () => undefined,
    }
    await expect(
      createDb0NodeSqliteOperationSessionProvider(fakeConnector).open(),
    ).rejects.toBeInstanceOf(QueryError)
    const throwingConnector = {
      ...fakeConnector,
      getInstance: () => {
        throw Object.assign(new Error('get failed'), { code: 'GET_FAILED' })
      },
    }
    await expect(
      createDb0NodeSqliteOperationSessionProvider(throwingConnector).open(),
    ).rejects.toMatchObject({ _tag: 'QueryError', cause: { code: 'GET_FAILED' } })
  })

  it('rolls back reuse releases and deduplicates close while a lease is active', async () => {
    const connector = nodeSqliteConnector({ name: ':memory:' })
    const provider = createDb0NodeSqliteOperationSessionProvider(connector)
    const session = await provider.open()
    await session.run({ sql: 'begin', params: [] })
    await session.run({ sql: 'create table transient (id integer)', params: [] })
    await session.release('reuse')
    const reused = await provider.open()
    await expect(
      reused.query({
        sql: "select name from sqlite_master where name = 'transient'",
        params: [],
      }),
    ).resolves.toEqual([])
    await reused.release('discard')
    await provider.close()

    const secondConnector = nodeSqliteConnector({ name: ':memory:' })
    const secondProvider = createDb0NodeSqliteOperationSessionProvider(secondConnector)
    const secondSession = await secondProvider.open()
    const closing = secondProvider.close()
    expect(secondProvider.close()).toBe(closing)
    await expect(secondProvider.open()).rejects.toBeInstanceOf(QueryError)
    await secondSession.release('discard')
    await closing
  })

  it('allows close/dispose failure retry after the original failure', async () => {
    const connector = nodeSqliteConnector({ name: ':memory:' })
    const originalDispose = connector.dispose!
    let fail = true
    connector.dispose = () => {
      if (fail)
        throw Object.assign(new Error('dispose failed'), { code: 'DISPOSE_FAILED' })
      return originalDispose()
    }
    const provider = createDb0NodeSqliteOperationSessionProvider(connector)
    await expect(provider.close()).rejects.toMatchObject({
      _tag: 'QueryError',
      cause: { code: 'DISPOSE_FAILED' },
    })
    fail = false
    await expect(provider.close()).resolves.toBeUndefined()
  })

  it('detects native replacement and external native closure before reuse', async () => {
    const first = nodeSqliteConnector({ name: ':memory:' })
    const second = nodeSqliteConnector({ name: ':memory:' })
    let useFirst = true
    const connector = {
      ...first,
      getInstance: () => (useFirst ? first.getInstance() : second.getInstance()),
      dispose: () => {
        first.dispose?.()
        second.dispose?.()
      },
    }
    const provider = createDb0NodeSqliteOperationSessionProvider(connector)
    const session = await provider.open()
    useFirst = false
    await expect(session.query({ sql: 'select 1', params: [] })).rejects.toBeInstanceOf(
      QueryError,
    )
    await expect(session.release('reuse')).rejects.toBeInstanceOf(QueryError)
    await provider.close()

    const external = nodeSqliteConnector({ name: ':memory:' })
    const externalProvider = createDb0NodeSqliteOperationSessionProvider(external)
    const externalSession = await externalProvider.open()
    const native = await external.getInstance()
    native.close()
    await expect(
      externalSession.query({ sql: 'select 1', params: [] }),
    ).rejects.toBeInstanceOf(QueryError)
    await expect(externalSession.release('reuse')).rejects.toBeInstanceOf(QueryError)
    await externalProvider.close().catch(() => undefined)
  })
})
