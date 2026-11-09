import type { Connector, DatabaseCapabilities } from 'db0'
import { getCapabilities } from 'db0'
import { realpathSync } from 'node:fs'

import { nativeField } from '@/dialects/nativeError'
import type { CompiledQuery } from '@/dialects/types'
import { withOperationCleanupFailure } from '@/operations/cleanup'
import type {
  OperationSession,
  OperationSessionIdentity,
  OperationSessionProvider,
} from '@/operations/operationSession'
import { QueryError, driverError, isErrorTag } from '@/utils/error'

import { sqliteClassifyDriverError } from './classifyDriverError'

type NativeStatement = {
  all(...params: SqliteBinding[]): Record<string, unknown>[]
  setReadBigInts(enabled: boolean): void
  run(...params: SqliteBinding[]): { changes: number | bigint }
}

type NativeDatabase = {
  readonly isOpen?: boolean
  readonly isTransaction?: boolean
  prepare(sql: string): NativeStatement
}

type SqliteBinding = null | string | number | bigint | ArrayBufferView

let nextMemoryId = 0
let nextSessionId = 0
const nativeSessionIds = new WeakMap<object, string>()
const memoryDatabaseIds = new WeakMap<object, string>()
const connectorStates = new WeakMap<Connector, ConnectorState>()
const nativeOwners = new WeakMap<object, ConnectorState>()

/** Accepts only the native DatabaseSync capabilities needed by a pinned lease. */
function nativeDatabase(
  value: unknown,
  dialectId: string,
  operation: string,
): NativeDatabase {
  const DatabaseSync = process.getBuiltinModule('node:sqlite').DatabaseSync

  if (!(value instanceof DatabaseSync) || value.isOpen === false) {
    throw new QueryError({
      message: 'db0 node-sqlite did not expose an open DatabaseSync',
    })
  }

  try {
    value.prepare('select 1')
  } catch (cause) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      nativeField(cause, 'code') === 'ERR_INVALID_STATE'
    ) {
      throw new QueryError({
        message: 'db0 node-sqlite did not expose an open DatabaseSync',
        cause,
      })
    }

    throw driverError(cause, dialectId, 'select 1', sqliteClassifyDriverError, operation)
  }

  return value
}

/** Classifies only native preparation and statement execution. */
function nativeSql<T>(
  database: NativeDatabase,
  sql: string,
  dialectId: string,
  execute: (statement: NativeStatement) => T,
  operation = 'database session SQL execution',
): T {
  try {
    return execute(database.prepare(sql))
  } catch (cause) {
    throw driverError(cause, dialectId, sql, sqliteClassifyDriverError, operation)
  }
}

/** Proves transaction cleanliness without requiring properties absent on Node 22.5. */
function assertCleanTransaction(database: NativeDatabase, dialectId: string): void {
  if (database.isTransaction === true)
    throw new QueryError({ message: 'SQLite session has an open transaction' })

  if (database.isTransaction === false) return

  nativeSql(
    database,
    'begin',
    dialectId,
    (statement) => statement.run(),
    'transaction begin',
  )

  nativeSql(
    database,
    'rollback',
    dialectId,
    (statement) => statement.run(),
    'transaction rollback',
  )
}

/** Rolls back pending work and accepts only SQLite's native no-transaction error. */
function rollbackNative(database: NativeDatabase, dialectId: string): void {
  try {
    database.prepare('rollback').run()
  } catch (cause) {
    if (
      !(cause instanceof Error) ||
      !('code' in cause) ||
      cause.code !== 'ERR_SQLITE_ERROR' ||
      cause.message !== 'cannot rollback - no transaction is active'
    ) {
      throw driverError(
        cause,
        dialectId,
        'rollback',
        sqliteClassifyDriverError,
        'transaction rollback',
      )
    }
  }

  assertCleanTransaction(database, dialectId)
}

/**
 * Preserves large signed integers while returning safe native catalog integers as
 * numbers.
 */
function normalizeRows(rows: Record<string, unknown>[]): unknown[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === 'bigint' && Number.isSafeInteger(Number(value))
          ? Number(value)
          : value,
      ]),
    ),
  )
}

/** Reads complete native identity from the main database and DatabaseSync instance. */
function readIdentity(
  database: NativeDatabase,
  dialectId: string,
): OperationSessionIdentity {
  const rows = nativeSql(
    database,
    'pragma database_list',
    dialectId,
    (statement) => statement.all(),
    'database session identity check',
  )

  const main = rows.find((row) => (row as { name?: unknown }).name === 'main') as
    | { file?: unknown }
    | undefined

  if (typeof main?.file !== 'string')
    throw new QueryError({ message: 'SQLite did not identify its main database' })

  let physicalSession = nativeSessionIds.get(database)

  if (!physicalSession) {
    physicalSession = `node-sqlite-session:${++nextSessionId}`
    nativeSessionIds.set(database, physicalSession)
  }

  let identity: string

  if (main.file) {
    identity = `file:${realpathSync.native(main.file)}`
  } else {
    let memoryId = memoryDatabaseIds.get(database)

    if (!memoryId) {
      memoryId = `memory:${++nextMemoryId}`
      memoryDatabaseIds.set(database, memoryId)
    }

    identity = memoryId
  }

  return Object.freeze({
    database: identity,
    physicalSession,
    namespaceContext: Object.freeze({
      writableDefault: Object.freeze([
        Object.freeze({ role: 'database', spelling: 'main' }),
      ]),
    }),
  })
}

/** Compares all database, native-session, and writable-namespace evidence. */
function sameOperationSessionIdentity(
  left: OperationSessionIdentity,
  right: OperationSessionIdentity,
): boolean {
  return (
    left.database === right.database &&
    left.physicalSession === right.physicalSession &&
    left.namespaceContext?.writableDefault[0]?.role ===
      right.namespaceContext?.writableDefault[0]?.role &&
    left.namespaceContext?.writableDefault[0]?.spelling ===
      right.namespaceContext?.writableDefault[0]?.spelling &&
    left.namespaceContext?.writableDefault.length ===
      right.namespaceContext?.writableDefault.length
  )
}

/** Validates values before calling the native statement binding API. */
function bindings(params: readonly unknown[]): SqliteBinding[] {
  return params.map((value) => {
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'bigint' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      return value

    if (value instanceof Uint8Array) return value

    // Node 22.5 binds only Uint8Array views; reuse the same bytes without copying.
    if (ArrayBuffer.isView(value))
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

    throw new QueryError({ message: 'Unsupported node:sqlite parameter value' })
  })
}

/** Preserves failures except for the known nested-transaction mismatch. */
function queryFailure(cause: unknown, message: string): unknown {
  if (
    isErrorTag(cause, 'DriverError') &&
    cause.sql === 'begin' &&
    cause.cause instanceof Error &&
    cause.cause.message === 'cannot start a transaction within a transaction'
  )
    return new QueryError({ message, cause: cause.cause })

  return cause
}

type ProviderState = {
  closed: boolean
  activeLease?: Promise<void>
  closePromise?: Promise<void>
  detached: boolean
}

type ConnectorState = {
  providers: number
  poisoned: boolean
  leased: boolean
  native?: NativeDatabase
  closing?: Promise<void>
}

type NativeSessionState = { queue: Promise<void>; cancelled: boolean; released: boolean }

/** Verifies that db0 still owns the same clean native instance. */
async function verifyNative(
  connector: Connector,
  owner: ConnectorState,
  database: NativeDatabase,
  identity: OperationSessionIdentity,
  dialectId: string,
  probeOperation: string,
): Promise<void> {
  if (
    (await connector.getInstance()) !== database ||
    owner.native !== database ||
    nativeOwners.get(database) !== owner
  )
    throw new QueryError({ message: 'SQLite native session changed during operation' })

  nativeDatabase(database, dialectId, probeOperation)

  if (!sameOperationSessionIdentity(readIdentity(database, dialectId), identity))
    throw new QueryError({ message: 'SQLite session identity changed during operation' })
}

/** Disposes db0 resources and retains a failed call for close retry. */
async function dispose(connector: Connector, owner: ConnectorState): Promise<void> {
  const database = owner.native

  if (!database) return

  try {
    if (
      (await connector.getInstance()) !== database ||
      nativeOwners.get(database) !== owner
    )
      throw new QueryError({ message: 'SQLite native session changed before disposal' })

    await connector.dispose!()
    nativeOwners.delete(database)
    owner.native = undefined
  } catch (cause) {
    throw queryFailure(cause, 'Failed to dispose SQLite operation session')
  }
}

/** Shares teardown with concurrent closes and leaves a failed disposal retryable. */
function closeOwnedConnector(connector: Connector, owner: ConnectorState): Promise<void> {
  if (owner.closing) return owner.closing

  owner.closing = dispose(connector, owner)
    .then(() => {
      owner.poisoned = false
    })
    .catch((cause: unknown) => {
      owner.poisoned = true
      throw cause
    })
    .finally(() => {
      owner.closing = undefined
    })
  return owner.closing
}

/** Retains cleanup evidence and blocks new leases when disposal remains incomplete. */
async function disposeAfterFailure(
  connector: Connector,
  owner: ConnectorState,
  cause: unknown,
  message: string,
): Promise<unknown> {
  const primary = queryFailure(cause, message)
  try {
    await dispose(connector, owner)
  } catch (cleanup) {
    owner.poisoned = true
    return withOperationCleanupFailure(primary, cleanup)
  }

  return primary
}

/** Releases a session after proving reuse or discarding the native instance. */
async function releaseNativeSession(
  connector: Connector,
  owner: ConnectorState,
  database: NativeDatabase,
  identity: OperationSessionIdentity,
  state: NativeSessionState,
  finish: () => void,
  disposition: 'reuse' | 'discard',
  dialectId: string,
): Promise<void> {
  if (state.released) throw new QueryError({ message: 'SQLite lease was released twice' })

  state.released = true
  await state.queue

  try {
    if (state.cancelled || disposition === 'discard') {
      await dispose(connector, owner)
      return
    }

    await verifyNative(
      connector,
      owner,
      database,
      identity,
      dialectId,
      'operation session release probe',
    )

    rollbackNative(database, dialectId)

    await verifyNative(
      connector,
      owner,
      database,
      identity,
      dialectId,
      'operation session release probe',
    )
  } catch (cause) {
    throw await disposeAfterFailure(
      connector,
      owner,
      cause,
      'Failed to release SQLite operation session',
    )
  } finally {
    finish()
  }
}

/** Queues one native call and keeps the tail settled for later cleanup. */
function enqueue<T>(
  connector: Connector,
  owner: ConnectorState,
  database: NativeDatabase,
  identity: OperationSessionIdentity,
  state: NativeSessionState,
  query: CompiledQuery,
  execute: (statement: NativeStatement, params: SqliteBinding[]) => T,
  dialectId: string,
): Promise<T> {
  if (state.released || state.cancelled)
    return Promise.reject(new QueryError({ message: 'SQLite lease is inactive' }))

  const result = state.queue.then(async () => {
    if (state.cancelled) throw new QueryError({ message: 'SQLite lease was cancelled' })

    await verifyNative(
      connector,
      owner,
      database,
      identity,
      dialectId,
      'operation session query probe',
    )

    const params = bindings(query.params)
    let statement: NativeStatement
    try {
      statement = database.prepare(query.sql)
    } catch (cause) {
      throw driverError(
        cause,
        dialectId,
        query.sql,
        sqliteClassifyDriverError,
        'database session SQL preparation',
      )
    }

    return execute(statement, params)
  })

  state.queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** Keeps native row retrieval separate from Stratom's result normalization. */
function readRows(
  statement: NativeStatement,
  params: SqliteBinding[],
  dialectId: string,
  sql: string,
): unknown[] {
  let rows: Record<string, unknown>[]

  try {
    statement.setReadBigInts(true)
    rows = statement.all(...params)
  } catch (cause) {
    throw driverError(
      cause,
      dialectId,
      sql,
      sqliteClassifyDriverError,
      'database session query execution',
    )
  }

  return normalizeRows(rows)
}

/** Runs one native statement without enclosing caller-owned work. */
function runStatement(
  statement: NativeStatement,
  params: SqliteBinding[],
  dialectId: string,
  sql: string,
): number {
  try {
    return Number(statement.run(...params).changes)
  } catch (cause) {
    throw driverError(
      cause,
      dialectId,
      sql,
      sqliteClassifyDriverError,
      'database session statement execution',
    )
  }
}

/** Creates an operation session with an exclusive lease over one open DatabaseSync. */
function createNativeOperationSession(
  connector: Connector,
  owner: ConnectorState,
  database: NativeDatabase,
  identity: OperationSessionIdentity,
  finish: () => void,
  dialectId: string,
): OperationSession {
  const state: NativeSessionState = {
    queue: Promise.resolve(),
    cancelled: false,
    released: false,
  }

  const enqueueOnLease = <T>(
    query: CompiledQuery,
    execute: (statement: NativeStatement, params: SqliteBinding[]) => T,
  ) => enqueue(connector, owner, database, identity, state, query, execute, dialectId)

  return {
    identity,
    /** Reads rows with StatementSync.all. */
    query: (query) =>
      enqueueOnLease(query, (statement, params) =>
        readRows(statement, params, dialectId, query.sql),
      ),
    /** Executes a statement with StatementSync.run. */
    run: (query) =>
      enqueueOnLease(query, (statement, params) =>
        runStatement(statement, params, dialectId, query.sql),
      ),
    /** Poisons the lease; synchronous DatabaseSync calls finish naturally. */
    cancel: async () => {
      if (state.released) throw new QueryError({ message: 'SQLite lease was released' })

      state.cancelled = true
      await state.queue
    },
    /** Settles all work, then proves reuse or discards the native instance. */
    release: (disposition) =>
      releaseNativeSession(
        connector,
        owner,
        database,
        identity,
        state,
        finish,
        disposition,
        dialectId,
      ),
  }
}

/** Claims only an open native instance after excluding another connector's owner. */
async function claimNativeDatabase(
  connector: Connector,
  owner: ConnectorState,
  dialectId: string,
): Promise<NativeDatabase> {
  const database = await connector.getInstance()
  const DatabaseSync = process.getBuiltinModule('node:sqlite').DatabaseSync

  if (!(database instanceof DatabaseSync))
    throw new QueryError({ message: 'db0 node-sqlite did not expose a DatabaseSync' })

  const existingOwner = nativeOwners.get(database)

  if (existingOwner && existingOwner !== owner) {
    throw new QueryError({
      message: 'SQLite native session is owned by another connector',
    })
  }

  if (owner.native && owner.native !== database)
    throw new QueryError({ message: 'SQLite native session changed during operation' })

  const validated = nativeDatabase(database, dialectId, 'operation session open probe')
  nativeOwners.set(database, owner)
  owner.native = database
  return validated
}

/** Opens one native lease and clears its provider slot on failure. */
async function openNativeLease(
  connector: Connector,
  provider: ProviderState,
  owner: ConnectorState,
  dialectId: string,
): Promise<OperationSession> {
  if (owner.closing) await owner.closing

  if (provider.closed) throw new QueryError({ message: 'SQLite provider is closed' })

  if (owner.poisoned) {
    throw new QueryError({
      message: 'SQLite provider requires successful close after failed disposal',
    })
  }

  if (owner.leased) throw new QueryError({ message: 'SQLite session is already leased' })

  owner.leased = true
  let finish!: () => void
  provider.activeLease = new Promise<void>((resolve) => {
    finish = resolve
  })

  const finishLease = () => {
    owner.leased = false
    provider.activeLease = undefined
    finish()
  }

  try {
    const claimed = await claimNativeDatabase(connector, owner, dialectId)

    assertCleanTransaction(claimed, dialectId)

    return createNativeOperationSession(
      connector,
      owner,
      claimed,
      readIdentity(claimed, dialectId),
      finishLease,
      dialectId,
    )
  } catch (cause) {
    const error = owner.native
      ? await disposeAfterFailure(
          connector,
          owner,
          cause,
          'Failed to open SQLite operation session',
        )
      : queryFailure(cause, 'Failed to open SQLite operation session')

    finishLease()
    throw error
  }
}

/** Closes once after the active lease and permits a failed disposal retry. */
function closeNativeProvider(
  connector: Connector,
  provider: ProviderState,
  owner: ConnectorState,
): Promise<void> {
  if (provider.closePromise) return provider.closePromise

  provider.closed = true
  provider.closePromise = (provider.activeLease ?? Promise.resolve())
    .then(async () => {
      if (!provider.detached) {
        owner.providers--
        provider.detached = true
      }

      if (owner.providers === 0 || owner.poisoned)
        await closeOwnedConnector(connector, owner)
    })
    .catch((cause: unknown) => {
      provider.closePromise = undefined
      throw cause
    })
  return provider.closePromise
}

/** Adapts exactly db0 0.4.0's node-sqlite connector to pinned native sessions. */
export function createDb0NodeSqliteOperationSessionProvider(
  connector: Connector,
  dialectId = 'sqlite',
): OperationSessionProvider {
  // db0 returns undefined for unknown dialects despite its declared return type.
  const capabilities = getCapabilities(
    connector.dialect,
    connector.capabilityOverrides,
  ) as DatabaseCapabilities | undefined

  if (capabilities?.transactions === false) {
    throw new QueryError({
      message: `Connector "${connector.name}" cannot keep a transaction across statements. Stratom requires pinned sessions with native transactions. Provide an explicit operationSessionProvider backed by the underlying client's native transaction API (for example Client.transaction()), not db0.`,
    })
  }

  if (
    connector.name !== 'node-sqlite' ||
    connector.dialect !== 'sqlite' ||
    typeof connector.getInstance !== 'function' ||
    typeof connector.dispose !== 'function'
  ) {
    throw new QueryError({
      message:
        'Automatic SQLite operation sessions require db0 node-sqlite; provide an explicit operationSessionProvider for other connectors',
    })
  }

  let owner = connectorStates.get(connector)

  if (!owner) {
    owner = { providers: 0, poisoned: false, leased: false }
    connectorStates.set(connector, owner)
  }

  owner.providers++
  const state: ProviderState = { closed: false, detached: false }
  return {
    nativeTransactions: true,
    /** Opens one exclusive native session. */
    open: () => openNativeLease(connector, state, owner, dialectId),
    /** Closes after the active lease and supports retry after disposal failure. */
    close: () => closeNativeProvider(connector, state, owner),
  }
}
