import type { Connector } from 'db0'
import { realpathSync } from 'node:fs'

import type { CompiledQuery } from '@/dialects/types'
import type {
  OperationSession,
  OperationSessionIdentity,
  OperationSessionProvider,
} from '@/operations/operationSession'
import { QueryError } from '@/utils/error'

type NativeStatement = {
  all(...params: SqliteBinding[]): unknown[]
  run(...params: SqliteBinding[]): unknown
}

type NativeDatabase = {
  readonly isOpen: boolean
  readonly isTransaction: boolean
  prepare(sql: string): NativeStatement
}

type SqliteBinding = null | string | number | bigint | ArrayBufferView

let nextMemoryId = 0
let nextSessionId = 0
const nativeSessionIds = new WeakMap<object, string>()
const memoryDatabaseIds = new WeakMap<object, string>()

/** Accepts only the native DatabaseSync capabilities needed by a pinned lease. */
function nativeDatabase(value: unknown): NativeDatabase {
  const DatabaseSync = process.getBuiltinModule('node:sqlite').DatabaseSync

  if (!(value instanceof DatabaseSync) || !value.isOpen) {
    throw new QueryError({
      message: 'db0 node-sqlite did not expose an open DatabaseSync',
    })
  }

  return value
}

/** Reads complete native identity from the main database and DatabaseSync instance. */
function readIdentity(database: NativeDatabase): OperationSessionIdentity {
  const rows = database.prepare('pragma database_list').all()
  const main = rows.find((row) => (row as { name?: unknown }).name === 'main') as
    | { file?: unknown }
    | undefined

  if (typeof main?.file !== 'string') {
    throw new QueryError({ message: 'SQLite did not identify its main database' })
  }

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
function sameIdentity(
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

    if (ArrayBuffer.isView(value)) return value

    throw new QueryError({ message: 'Unsupported node:sqlite parameter value' })
  })
}

/** Converts third-party failures into the query boundary's error type. */
function queryFailure(cause: unknown, message: string): QueryError {
  return cause instanceof QueryError ? cause : new QueryError({ message, cause })
}

type ProviderState = {
  closed: boolean
  poisoned: boolean
  leased: boolean
  activeLease?: Promise<void>
  closePromise?: Promise<void>
}

type LeaseState = { queue: Promise<void>; cancelled: boolean; released: boolean }

/** Verifies that db0 still owns the same clean native instance. */
async function verifyNative(
  connector: Connector,
  database: NativeDatabase,
  identity: OperationSessionIdentity,
): Promise<void> {
  if (!database.isOpen || nativeDatabase(await connector.getInstance!()) !== database) {
    throw new QueryError({ message: 'SQLite native session changed during operation' })
  }

  if (!sameIdentity(readIdentity(database), identity)) {
    throw new QueryError({ message: 'SQLite session identity changed during operation' })
  }
}

/** Disposes db0 resources and retains a failed call for close retry. */
async function dispose(connector: Connector): Promise<void> {
  try {
    await connector.dispose!()
  } catch (cause) {
    throw queryFailure(cause, 'Failed to dispose SQLite operation session')
  }
}

/** Retains cleanup evidence and blocks new leases when disposal remains incomplete. */
async function disposeAfterFailure(
  connector: Connector,
  provider: ProviderState,
  cause: unknown,
  message: string,
): Promise<QueryError> {
  const primary = queryFailure(cause, message)
  try {
    await dispose(connector)
  } catch (cleanup) {
    provider.poisoned = true

    Object.assign(primary, {
      cleanupFailures: [{ stage: 'sessionCleanup', cause: cleanup }],
    })
  }

  return primary
}

/** Releases a session after proving reuse or discarding the native instance. */
async function releaseLease(
  connector: Connector,
  provider: ProviderState,
  database: NativeDatabase,
  identity: OperationSessionIdentity,
  state: LeaseState,
  finish: () => void,
  disposition: 'reuse' | 'discard',
): Promise<void> {
  if (state.released) throw new QueryError({ message: 'SQLite lease was released twice' })

  state.released = true
  await state.queue

  try {
    if (state.cancelled || disposition === 'discard') {
      await dispose(connector)
      return
    }

    if (database.isTransaction) database.prepare('rollback').run()

    if (database.isTransaction)
      throw new QueryError({ message: 'SQLite transaction remained open after rollback' })

    await verifyNative(connector, database, identity)
  } catch (cause) {
    throw await disposeAfterFailure(
      connector,
      provider,
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
  database: NativeDatabase,
  identity: OperationSessionIdentity,
  state: LeaseState,
  query: CompiledQuery,
  execute: (statement: NativeStatement, params: SqliteBinding[]) => T,
): Promise<T> {
  if (state.released || state.cancelled)
    return Promise.reject(new QueryError({ message: 'SQLite lease is inactive' }))

  const result = state.queue.then(async () => {
    if (state.cancelled) throw new QueryError({ message: 'SQLite lease was cancelled' })

    try {
      await verifyNative(connector, database, identity)
      return execute(database.prepare(query.sql), bindings(query.params))
    } catch (cause) {
      throw queryFailure(cause, 'SQLite operation failed')
    }
  })

  state.queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** Creates an exclusive lease over one open DatabaseSync. */
function createLease(
  connector: Connector,
  provider: ProviderState,
  database: NativeDatabase,
  identity: OperationSessionIdentity,
  finish: () => void,
): OperationSession {
  const state: LeaseState = {
    queue: Promise.resolve(),
    cancelled: false,
    released: false,
  }

  return {
    identity,
    /** Reads rows with StatementSync.all. */
    query: (query) =>
      enqueue(connector, database, identity, state, query, (statement, params) =>
        statement.all(...params),
      ),
    /** Executes a statement with StatementSync.run. */
    run: (query) =>
      enqueue(connector, database, identity, state, query, (statement, params) => {
        statement.run(...params)
      }),
    /** Poisons the lease; synchronous DatabaseSync calls finish naturally. */
    cancel: async () => {
      if (state.released) throw new QueryError({ message: 'SQLite lease was released' })

      state.cancelled = true
      await state.queue
    },
    /** Settles all work, then proves reuse or discards the native instance. */
    release: (disposition) =>
      releaseLease(connector, provider, database, identity, state, finish, disposition),
  }
}

/** Opens one native lease and clears its provider slot on failure. */
async function openLease(
  connector: Connector,
  state: ProviderState,
): Promise<OperationSession> {
  if (state.closed) throw new QueryError({ message: 'SQLite provider is closed' })

  if (state.poisoned)
    throw new QueryError({
      message: 'SQLite provider requires successful close after failed disposal',
    })

  if (state.leased) throw new QueryError({ message: 'SQLite session is already leased' })

  state.leased = true
  let finish!: () => void
  state.activeLease = new Promise<void>((resolve) => {
    finish = resolve
  })

  const finishLease = () => {
    state.leased = false
    state.activeLease = undefined
    finish()
  }

  try {
    const database = nativeDatabase(await connector.getInstance!())

    if (database.isTransaction)
      throw new QueryError({ message: 'SQLite session has an open transaction' })

    return createLease(connector, state, database, readIdentity(database), finishLease)
  } catch (cause) {
    const error = await disposeAfterFailure(
      connector,
      state,
      cause,
      'Failed to open SQLite operation session',
    )

    finishLease()
    throw error
  }
}

/** Closes once after the active lease and permits a failed disposal retry. */
function closeProvider(connector: Connector, state: ProviderState): Promise<void> {
  if (state.closePromise) return state.closePromise

  state.closed = true
  state.closePromise = (state.activeLease ?? Promise.resolve())
    .then(async () => {
      await dispose(connector)
      state.poisoned = false
    })
    .catch((cause: unknown) => {
      state.closePromise = undefined
      throw cause
    })
  return state.closePromise
}

/** Adapts exactly db0 0.4.0's node-sqlite connector to pinned native sessions. */
export function createDb0NodeSqliteOperationSessionProvider(
  connector: Connector,
): OperationSessionProvider {
  if (
    connector.name !== 'node-sqlite' ||
    connector.dialect !== 'sqlite' ||
    typeof connector.getInstance !== 'function' ||
    typeof connector.dispose !== 'function'
  )
    throw new QueryError({
      message:
        'Automatic SQLite operation sessions require db0 node-sqlite; provide an explicit operationSessionProvider for other connectors',
    })

  const state: ProviderState = { closed: false, poisoned: false, leased: false }
  return {
    nativeTransactions: true,
    /** Opens one exclusive native session. */
    open: () => openLease(connector, state),
    /** Closes after the active lease and supports retry after disposal failure. */
    close: () => closeProvider(connector, state),
  }
}
