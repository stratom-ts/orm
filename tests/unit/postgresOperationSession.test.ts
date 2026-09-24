import { describe, expect, it } from 'vitest'

import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'
import { QueryError, createDb0PostgresqlOperationSessionProvider } from '@/index'
import {
  OperationCoordinator,
  getOperationReleaseCleanupFailures,
} from '@/operations/coordinator'

import { deferred } from '../helpers/deferredPromise'

import {
  createNativeConnector,
  customConnector,
  withDeadline,
} from './helpers/operationSessionFixtures'

describe('db0 PostgreSQL operation-session adapter', () => {
  it('proves identity at every lease and after reuse cleanup', async () => {
    const connector = createNativeConnector()
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const plainSql = `select '?' as "?", $1::text as value`

    const first = await provider.open()
    await first.query({ sql: plainSql, params: ['bound'] })
    await first.release('reuse')

    expect(connector.queryCalls).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: plainSql, values: ['bound'] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])

    const beforeSecond = connector.queryCalls.length
    const second = await provider.open()
    await second.query({ sql: 'select 2', params: [] })
    await second.release('reuse')

    expect(connector.queryCalls.slice(beforeSecond)).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: 'select 2', values: [] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])

    const beforeTransaction = connector.queryCalls.length
    const transaction = await provider.open()
    await transaction.run({ sql: 'begin', params: [] })
    await transaction.run({ sql: 'commit', params: [] })
    await transaction.release('reuse')

    expect(connector.queryCalls.slice(beforeTransaction)).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: 'begin', values: [] },
      { text: 'commit', values: [] },
      { text: POSTGRES_OPERATION_ROLLBACK_SQL, values: [] },
      { text: POSTGRES_OPERATION_UNLOCK_SQL, values: [] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])

    const beforeAdvisory = connector.queryCalls.length
    const advisory = await provider.open()
    await advisory.run({ sql: 'select pg_advisory_lock(1, 2)', params: [] })
    await advisory.release('reuse')

    expect(connector.queryCalls.slice(beforeAdvisory)).toEqual([
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
      { text: 'select pg_advisory_lock(1, 2)', values: [] },
      { text: POSTGRES_OPERATION_ROLLBACK_SQL, values: [] },
      { text: POSTGRES_OPERATION_UNLOCK_SQL, values: [] },
      { text: POSTGRES_OPERATION_IDENTITY_SQL, values: [] },
    ])

    await provider.close()
  })

  it('reads changed current_schema for a fresh physical-session lease', async () => {
    let schema = 'public'
    const connector = createNativeConnector({ currentSchema: () => schema })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)

    const first = await provider.open()
    expect(first.identity.namespaceContext?.writableDefault).toEqual([
      { role: 'database', spelling: 'operations_test' },
      { role: 'schema', spelling: 'public' },
    ])

    await first.release('reuse')

    schema = 'tenant'
    const second = await provider.open()
    expect(second.identity.namespaceContext?.writableDefault).toEqual([
      { role: 'database', spelling: 'operations_test' },
      { role: 'schema', spelling: 'tenant' },
    ])

    await second.release('reuse')

    expect(
      connector.queryCalls.filter(({ text }) => text === POSTGRES_OPERATION_IDENTITY_SQL),
    ).toHaveLength(4)

    await provider.close()
  })

  it('discards a reused session when DDL changes current_schema during its lease', async () => {
    let schema = 'public'
    const connector = createNativeConnector({
      currentSchema: () => schema,
      onQuery: async (text) => {
        if (/^create schema/i.test(text)) schema = 'tenant'

        return []
      },
    })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const session = await provider.open()

    await session.run({ sql: 'create schema tenant', params: [] })

    await expect(session.release('reuse')).rejects.toThrow(
      /session identity changed before release/i,
    )

    expect(connector.disposeCount).toBe(1)
    await provider.close()
  })

  it('discards a reused session when final namespace evidence cannot be read', async () => {
    const connector = createNativeConnector({ identityFailureAt: 2 })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const session = await provider.open()

    await session.run({ sql: 'select 1', params: [] })

    await expect(session.release('reuse')).rejects.toThrow(
      /identity evidence unavailable/i,
    )

    expect(connector.disposeCount).toBe(1)
    await provider.close()
  })

  it('retains final namespace-evidence cleanup without replacing a primary operation failure', async () => {
    const primary = new Error('primary native operation failure')
    const connector = createNativeConnector({
      identityFailureAt: 2,
      onQuery: async (text) => {
        if (text === 'select primary failure') throw primary

        return []
      },
    })
    const coordinator = new OperationCoordinator(
      createDb0PostgresqlOperationSessionProvider(connector),
    )

    const error = await coordinator
      .run(({ executor }) => executor.run({ sql: 'select primary failure', params: [] }))
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(QueryError)

    expect(error).toMatchObject({
      message: 'primary native operation failure',
      cause: primary,
    })

    expect(getOperationReleaseCleanupFailures(error)).toHaveLength(1)

    expect(getOperationReleaseCleanupFailures(error)[0]).toMatchObject({
      message: 'identity evidence unavailable',
    })

    expect(connector.disposeCount).toBe(1)
    await coordinator.close()
  })

  it('proves stable identity and serializes native calls through reuse release', async () => {
    const gates = [deferred(), deferred()]
    const firstStarted = deferred()
    let call = 0
    const connector = createNativeConnector({
      onQuery: async () => {
        const index = call++

        if (index === 0) firstStarted.resolve()

        const gate = gates[index]!
        await gate.promise
        return []
      },
    })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const session = await provider.open()
    const identity = session.identity
    const initialDatabase = identity.database
    const initialPhysicalSession = identity.physicalSession

    const first = session.query({ sql: 'select 1', params: [] })
    const second = session.run({ sql: 'update test set value = 1', params: [] })
    await firstStarted.promise
    expect(connector.maxActiveCalls).toBe(1)
    gates[0]!.resolve()
    await first
    gates[1]!.resolve()
    await second

    expect(session.identity).toMatchObject({
      database: initialDatabase,
      physicalSession: initialPhysicalSession,
    })

    await session.release('reuse')
    expect(connector.disposeCount).toBe(0)
    await expect(session.release('reuse')).rejects.toThrow(/more than once/i)
    await provider.close()
  })

  it('cancels an active call and safely discards the uncertain client', async () => {
    const started = deferred()
    const endStarted = deferred()
    const finishEnd = deferred()
    const connector = createNativeConnector({
      onQuery: () => {
        started.resolve()
        return new Promise(() => {})
      },
      beforeEnd: async () => {
        endStarted.resolve()
        await finishEnd.promise
      },
    })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const session = await provider.open()
    const originalIdentity = session.identity
    const query = session.query({ sql: 'select pg_sleep(30)', params: [] })
    await started.promise

    const cancel = session.cancel()
    await endStarted.promise

    expect(
      await Promise.race([cancel.then(() => 'settled'), Promise.resolve('pending')]),
    ).toBe('pending')

    finishEnd.resolve()
    await expect(withDeadline(cancel)).resolves.toBeUndefined()
    await expect(withDeadline(query)).rejects.toThrow(/terminated/i)
    await session.release('reuse')
    expect(connector.endCount).toBe(1)
    expect(connector.disposeCount).toBe(1)

    const replacement = await provider.open()
    expect(replacement.identity.physicalSession).not.toBe(
      originalIdentity.physicalSession,
    )

    await replacement.release('reuse')
    await provider.close()
  })

  it('rejects connectors that cannot prove native PostgreSQL pinning', async () => {
    expect(() => createDb0PostgresqlOperationSessionProvider(customConnector())).toThrow(
      /automatic operation sessions/i,
    )

    const connector = {
      ...customConnector(),
      name: 'postgresql',
      dispose: async () => {},
    }
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    await expect(provider.open()).rejects.toThrow(/exact native pg\.Client/i)

    const missingReadiness = {
      processID: 123,
      database: 'test',
      query: async () => ({
        rows: [{ physicalSession: '123', database: 'test' }],
      }),
      async end() {},
    }
    const readinessProvider = createDb0PostgresqlOperationSessionProvider({
      ...connector,
      getInstance: () => missingReadiness,
    })
    await expect(readinessProvider.open()).rejects.toThrow(/readiness.*queue/i)

    const missingCancellation = {
      ...missingReadiness,
      readyForQuery: true,
      activeQuery: null,
      queryQueue: [],
      end: undefined,
    }
    const cancellationProvider = createDb0PostgresqlOperationSessionProvider({
      ...connector,
      getInstance: () => missingCancellation,
    })
    await expect(cancellationProvider.open()).rejects.toThrow(
      /cancellation capabilities/i,
    )

    const dirtyProvider = createDb0PostgresqlOperationSessionProvider({
      ...connector,
      getInstance: () => ({
        ...missingReadiness,
        readyForQuery: false,
        activeQuery: null,
        queryQueue: [],
      }),
    })
    await expect(dirtyProvider.open()).rejects.toThrow(/not clean for operation use/i)
  })

  it('preserves an undefined rejection from exact-provider release verification', async () => {
    const connector = createNativeConnector({
      releaseFailure: { value: undefined },
    })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const session = await provider.open()

    await session.run({ sql: 'begin', params: [] })
    await expect(session.release('reuse')).rejects.toBeUndefined()
    expect(connector.disposeCount).toBe(1)
    await provider.close()
  })

  it('waits for an active lease before deduplicated provider close', async () => {
    const connector = createNativeConnector()
    const provider = createDb0PostgresqlOperationSessionProvider(connector)
    const session = await provider.open()

    const firstClose = provider.close()
    const secondClose = provider.close()
    expect(secondClose).toBe(firstClose)

    expect(
      await Promise.race([firstClose.then(() => 'settled'), Promise.resolve('waiting')]),
    ).toBe('waiting')

    await expect(provider.open()).rejects.toThrow(/closed/i)
    await session.query({ sql: 'select 1', params: [] })
    await session.release('reuse')
    await expect(withDeadline(firstClose)).resolves.toBeUndefined()
    expect(connector.disposeCount).toBe(1)
  })

  it('allows provider close cleanup to retry after disposal fails', async () => {
    const connector = createNativeConnector({ disposeFailures: 1 })
    const provider = createDb0PostgresqlOperationSessionProvider(connector)

    const firstClose = provider.close()
    await expect(firstClose).rejects.toThrow(/dispose failed/i)
    const retry = provider.close()
    expect(retry).not.toBe(firstClose)
    await expect(retry).resolves.toBeUndefined()
    expect(connector.disposeCount).toBe(2)
  })
})
