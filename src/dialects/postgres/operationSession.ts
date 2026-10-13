import type { Connector } from 'db0'

import type { CompiledQuery } from '@/dialects'
import type {
  OperationSession,
  OperationSessionIdentity,
  OperationSessionProvider,
} from '@/operations/operationSession'
import { QueryError, driverError } from '@/utils/error'

import { postgresClassifyDriverError } from './classifyDriverError'
import { scanPostgresSql } from './postgresSql'

type NativePostgresResult = {
  rows?: unknown[]
}

type NativePostgresClient = {
  processID?: number
  database?: string
  readyForQuery?: boolean
  activeQuery?: unknown
  _activeQuery?: unknown
  /**
   * Reads the native client's currently active query for cancellation and reuse checks.
   *
   * @returns The native query currently active on the client.
   */
  _getActiveQuery?(): unknown
  queryQueue?: unknown[]
  _queryQueue?: unknown[]
  connection?: {
    stream?: {
      /**
       * Destroys the native transport when the session cannot be reused safely.
       *
       * @param error - Primary operation rejection, including primitive or undefined
       *   values.
       */
      destroy(error?: Error): void
    }
  }
  /** Closes the native PostgreSQL client and its physical connection. */
  end?(): Promise<void>
  /**
   * Executes a row-returning query on the pinned physical session.
   *
   * @param query - Compiled SQL and ordered parameter bindings for the current physical
   *   call.
   * @param values - Ordered values supplied for SQL parameter binding.
   *
   * @returns Native result rows from the session-bound physical SQL call.
   */
  query(
    query:
      | string
      | {
          text: string
          values: unknown[]
          signal?: AbortSignal
        },
    values?: unknown[],
  ): Promise<NativePostgresResult>
}

export const POSTGRES_OPERATION_IDENTITY_SQL =
  'select pg_backend_pid()::text as "physicalSession", current_database() as "database", current_schema() as "schema"'
export const POSTGRES_OPERATION_ROLLBACK_SQL = 'rollback /* stratom operation release */'
export const POSTGRES_OPERATION_UNLOCK_SQL =
  'select pg_advisory_unlock_all() /* stratom operation release */'

/**
 * Reads the active query across the supported pg.Client internals.
 *
 * @param client - Native PostgreSQL client.
 */
function getActiveQuery(client: NativePostgresClient): unknown {
  if (typeof client._getActiveQuery === 'function') return client._getActiveQuery()
  if ('_activeQuery' in client) return client._activeQuery

  return client.activeQuery
}

/**
 * Reads the query queue across the supported pg.Client internals.
 *
 * @param client - Native PostgreSQL client.
 */
function getQueryQueue(client: NativePostgresClient): unknown[] | undefined {
  if (Array.isArray(client._queryQueue)) return client._queryQueue

  return client.queryQueue
}

/**
 * Validates and narrows a db0 connector instance to the required pg.Client shape.
 *
 * @param value - Connector instance to validate.
 */
function asNativePostgresClient(value: unknown): NativePostgresClient {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('query' in value) ||
    typeof value.query !== 'function' ||
    !('processID' in value) ||
    typeof value.processID !== 'number' ||
    !Number.isInteger(value.processID) ||
    value.processID <= 0
  ) {
    throw new QueryError({
      message:
        'The db0 PostgreSQL connector did not expose the exact native pg.Client identity, readiness, queue, and cancellation capabilities',
    })
  }

  const client = value as NativePostgresClient

  if (
    typeof client.database !== 'string' ||
    client.database.length === 0 ||
    typeof client.readyForQuery !== 'boolean' ||
    !(
      '_activeQuery' in client ||
      typeof client._getActiveQuery === 'function' ||
      'activeQuery' in client
    ) ||
    !Array.isArray(getQueryQueue(client)) ||
    !(
      typeof client.end === 'function' ||
      typeof client.connection?.stream?.destroy === 'function'
    )
  ) {
    throw new QueryError({
      message:
        'The db0 PostgreSQL connector did not expose the exact native pg.Client identity, readiness, queue, and cancellation capabilities',
    })
  }

  return client
}

/**
 * Reads and verifies a native PostgreSQL session identity.
 *
 * @param client - Native PostgreSQL client.
 */
async function readIdentity(
  client: NativePostgresClient,
  dialectId: string,
): Promise<OperationSessionIdentity> {
  const result = await queryNativeSql(client, POSTGRES_OPERATION_IDENTITY_SQL, dialectId)
  const row = result.rows?.[0] as
    | { database?: unknown; physicalSession?: unknown; schema?: unknown }
    | undefined

  const database = row?.database
  const physicalSession = row?.physicalSession
  const schema = row?.schema

  if (
    typeof database !== 'string' ||
    database.length === 0 ||
    typeof schema !== 'string' ||
    schema.length === 0 ||
    typeof physicalSession !== 'string' ||
    physicalSession !== String(client.processID) ||
    (client.database !== undefined && client.database !== database)
  ) {
    throw new QueryError({
      message:
        'The db0 PostgreSQL connector could not prove backend, database, and namespace identity',
    })
  }

  return Object.freeze({
    database,
    physicalSession,
    namespaceContext: Object.freeze({
      writableDefault: Object.freeze([
        Object.freeze({ role: 'database' as const, spelling: database }),
        Object.freeze({ role: 'schema' as const, spelling: schema }),
      ]),
    }),
  })
}

/** Classifies a native provider command without enclosing identity checks. */
async function queryNativeSql(
  client: NativePostgresClient,
  sql: string,
  dialectId: string,
): Promise<NativePostgresResult> {
  try {
    return await client.query(sql)
  } catch (cause) {
    throw driverError(cause, dialectId, sql, postgresClassifyDriverError)
  }
}

/**
 * Asserts that a native client has no active or queued query.
 *
 * @param client - Native PostgreSQL client.
 */
function assertReusableNativeClient(client: NativePostgresClient): void {
  if (
    client.readyForQuery !== undefined &&
    (client.readyForQuery !== true ||
      getActiveQuery(client) != null ||
      (getQueryQueue(client)?.length ?? 0) !== 0)
  ) {
    throw new QueryError({
      message: 'The PostgreSQL native client was not clean for operation use',
    })
  }
}

/** Compares the complete evidence that makes a physical session reusable. */
function sameOperationSessionIdentity(
  left: OperationSessionIdentity,
  right: OperationSessionIdentity,
): boolean {
  const leftNamespace = left.namespaceContext?.writableDefault
  const rightNamespace = right.namespaceContext?.writableDefault

  return (
    left.database === right.database &&
    left.physicalSession === right.physicalSession &&
    leftNamespace?.length === rightNamespace?.length &&
    leftNamespace?.every(
      (segment, index) =>
        segment.role === rightNamespace?.[index]?.role &&
        segment.spelling === rightNamespace[index]?.spelling,
    ) === true
  )
}

/** Verifies reuse after clearing transaction and advisory lock state. */
async function verifyReleasedSession(
  connector: Connector,
  client: NativePostgresClient,
  identity: OperationSessionIdentity,
  requiresCleanup: boolean,
  dialectId: string,
): Promise<void> {
  assertReusableNativeClient(client)

  if (asNativePostgresClient(await connector.getInstance()) !== client) {
    throw new QueryError({
      message: 'PostgreSQL physical session changed before release',
    })
  }

  if (requiresCleanup) {
    await queryNativeSql(client, POSTGRES_OPERATION_ROLLBACK_SQL, dialectId)
    await queryNativeSql(client, POSTGRES_OPERATION_UNLOCK_SQL, dialectId)
  }

  const releasedIdentity = await readIdentity(client, dialectId)

  if (!sameOperationSessionIdentity(releasedIdentity, identity)) {
    throw new QueryError({
      message: 'PostgreSQL session identity changed before release',
    })
  }
}

/** Hard-discards an active native call after cancellation. */
async function discardActiveQuery(client: NativePostgresClient): Promise<void> {
  if (getActiveQuery(client) != null) {
    if (client.end) {
      // This hard-discard teardown is not a PostgreSQL backend cancel request.
      await client.end().catch(() => undefined)
    } else {
      client.connection?.stream?.destroy()
    }
  }
}

/** Serializes native calls and owns cleanup for one verified PostgreSQL lease. */
type NativeSessionState = {
  released: boolean
  cancelled: boolean
  requiresCleanup: boolean
  activeController: AbortController | undefined
  queue: Promise<void>
}

/** Serializes work on one native PostgreSQL session. */
function enqueueSessionOperation<T>(
  state: NativeSessionState,
  operation: () => Promise<T>,
): Promise<T> {
  if (state.released) {
    return Promise.reject(
      new QueryError({ message: 'Operation session has been released' }),
    )
  }

  if (state.cancelled) {
    return Promise.reject(
      new QueryError({ message: 'Operation session has been cancelled' }),
    )
  }

  const result = state.queue.then(() => {
    if (state.cancelled) {
      throw new QueryError({ message: 'Operation session has been cancelled' })
    }

    return operation()
  })

  state.queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/** Executes a query on the verified physical PostgreSQL session. */
async function executeNativeQuery(
  connector: Connector,
  client: NativePostgresClient,
  state: NativeSessionState,
  query: CompiledQuery,
  dialectId: string,
): Promise<NativePostgresResult> {
  if (asNativePostgresClient(await connector.getInstance()) !== client) {
    throw new QueryError({
      message: 'PostgreSQL physical session changed during an operation',
    })
  }

  const controller = new AbortController()
  state.activeController = controller
  state.requiresCleanup ||= scanPostgresSql(query.sql).requiresCleanup

  try {
    return await client.query({
      text: query.sql,
      values: query.params,
      signal: controller.signal,
    })
  } catch (cause) {
    throw driverError(cause, dialectId, query.sql, postgresClassifyDriverError)
  } finally {
    state.activeController = undefined
  }
}

/** Cancels a native call and discards its uncertain physical session. */
async function cancelNativeSession(
  client: NativePostgresClient,
  state: NativeSessionState,
): Promise<void> {
  if (state.released) {
    throw new QueryError({ message: 'Operation session has been released' })
  }

  state.cancelled = true
  state.activeController?.abort()

  await discardActiveQuery(client)
}

/** Releases one lease after its queued work and cleanup finish. */
async function releaseNativeSession(
  connector: Connector,
  client: NativePostgresClient,
  identity: OperationSessionIdentity,
  state: NativeSessionState,
  disposeConnector: () => Promise<void>,
  finishLease: () => void,
  disposition: Parameters<OperationSession['release']>[0],
  dialectId: string,
): Promise<void> {
  if (state.released) {
    throw new QueryError({
      message: 'Operation session was released more than once',
    })
  }

  state.released = true
  await state.queue

  let releaseFailed = false
  let releaseError: unknown

  try {
    if (disposition === 'discard' || state.cancelled) {
      await disposeConnector()
      return
    }

    await verifyReleasedSession(
      connector,
      client,
      identity,
      state.requiresCleanup,
      dialectId,
    )
  } catch (cause) {
    releaseFailed = true
    releaseError = cause
    await disposeConnector().catch(() => undefined)
  } finally {
    finishLease()
  }

  if (releaseFailed) throw releaseError
}

/**
 * Binds a lease's query, cancellation, and release operations to its native PostgreSQL
 * client.
 *
 * @param connector - Connector that owns native connection resources.
 * @param client - Native client used for queries, cancellation, or identity checks.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param disposeConnector - Callback that disposes the connector's native resources.
 * @param finishLease - Callback that resolves the active lease after release completes.
 *
 * @returns A session exposing the lease's identity, query, cancellation, and release
 *   controls.
 */
function createNativeOperationSession(
  connector: Connector,
  client: NativePostgresClient,
  identity: OperationSessionIdentity,
  disposeConnector: () => Promise<void>,
  finishLease: () => void,
  dialectId: string,
): OperationSession {
  const state: NativeSessionState = {
    released: false,
    cancelled: false,
    requiresCleanup: false,
    activeController: undefined,
    queue: Promise.resolve(),
  }

  return {
    identity,
    /** Executes a row-returning query on the pinned physical session. */
    query: (query) =>
      enqueueSessionOperation(
        state,
        async () =>
          (await executeNativeQuery(connector, client, state, query, dialectId)).rows ??
          [],
      ),
    /** Executes a statement without requiring result rows. */
    run: (query) =>
      enqueueSessionOperation(state, async () => {
        await executeNativeQuery(connector, client, state, query, dialectId)
      }),
    /** Cancels the active physical-session operation. */
    cancel: () => cancelNativeSession(client, state),
    /** Settles queued work and releases the lease for reuse or discard. */
    release: (disposition) =>
      releaseNativeSession(
        connector,
        client,
        identity,
        state,
        disposeConnector,
        finishLease,
        disposition,
        dialectId,
      ),
  }
}

/**
 * Creates the exact operation-session provider for db0 0.4.0's PostgreSQL
 * connector, whose `getInstance()` is one lazily connected native `pg.Client`.
 *
 * @example
 *   const provider = createDb0PostgresOperationSessionProvider(connector)
 *
 * @param connector - Db0 PostgreSQL connector.
 */
export function createDb0PostgresOperationSessionProvider(
  connector: Connector,
  dialectId = 'postgresql',
): OperationSessionProvider {
  assertDb0PostgresConnector(connector)

  /** Disposes the connector while normalizing synchronous failures to rejections. */
  const dispose = () => disposeConnector(connector)

  const state: NativeProviderState = {
    leased: false,
    closed: false,
    closePromise: undefined,
    activeLease: undefined,
  }

  return {
    nativeTransactions: true,
    /** Opens an exclusive physical-session lease. */
    open: () => openNativeLease(state, connector, dispose, dialectId),
    /** Closes owned resources after active work has settled. */
    close: () => closeNativeProvider(state, dispose),
  }
}

/**
 * Requires the connector capabilities needed for exact native PostgreSQL session
 * ownership.
 *
 * @param connector - Connector that owns native connection resources.
 */
function assertDb0PostgresConnector(connector: Connector): void {
  if (
    connector.name !== 'postgresql' ||
    connector.dialect !== 'postgresql' ||
    typeof connector.getInstance !== 'function' ||
    typeof connector.dispose !== 'function'
  ) {
    throw new QueryError({
      message:
        'Automatic operation sessions require the db0 PostgreSQL connector; provide an explicit operationSessionProvider for a custom connector',
    })
  }
}

/**
 * Disposes the connector and exposes synchronous disposal failures as promise rejections.
 *
 * @param connector - Connector that owns native connection resources.
 */
function disposeConnector(connector: Connector): Promise<void> {
  try {
    return Promise.resolve(connector.dispose!()).then(() => undefined)
  } catch (cause) {
    return Promise.reject(cause)
  }
}

type NativeProviderState = {
  leased: boolean
  closed: boolean
  closePromise: Promise<void> | undefined
  activeLease: Promise<void> | undefined
}

/**
 * Opens an exclusive operation session on the connector's native client.
 *
 * @example
 *   const session = await provider.open()
 */
async function openNativeLease(
  state: NativeProviderState,
  connector: Connector,
  dispose: () => Promise<void>,
  dialectId: string,
): Promise<OperationSession> {
  if (state.closed) {
    throw new QueryError({ message: 'Operation session provider has been closed' })
  }

  if (state.leased) {
    throw new QueryError({
      message: 'PostgreSQL operation session is already leased',
    })
  }

  state.leased = true
  let finishLease!: () => void
  const lease = new Promise<void>((resolve) => {
    finishLease = resolve
  })

  state.activeLease = lease

  const {
    client,
    identity,
  }: { client: NativePostgresClient; identity: OperationSessionIdentity } =
    await readNativeLeaseIdentity(connector, dispose, state, finishLease, dialectId)

  return createNativeOperationSession(
    connector,
    client,
    identity,
    dispose,
    () => {
      state.leased = false
      state.activeLease = undefined
      finishLease()
    },
    dialectId,
  )
}

/**
 * Captures native session identity and disposes leases whose identity cannot be verified.
 *
 * @param connector - Connector that owns native connection resources.
 * @param dispose - Callback that closes the connector and retains disposal failures.
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 * @param finishLease - Callback that resolves the active lease after release completes.
 *
 * @returns Verified native identity, with unverifiable leases disposed before rejection.
 */
async function readNativeLeaseIdentity(
  connector: Connector,
  dispose: () => Promise<void>,
  state: NativeProviderState,
  finishLease: () => void,
  dialectId: string,
) {
  let client: NativePostgresClient
  let identity: OperationSessionIdentity

  try {
    let instance: unknown
    try {
      instance = await connector.getInstance()
    } catch (cause) {
      throw new QueryError({
        message:
          cause instanceof Error
            ? `Failed to open PostgreSQL operation session: ${cause.message}`
            : 'Failed to open PostgreSQL operation session',
        cause,
      })
    }

    client = asNativePostgresClient(instance)
    assertReusableNativeClient(client)
    identity = await readIdentity(client, dialectId)
  } catch (cause) {
    await dispose().catch(() => undefined)
    state.leased = false
    state.activeLease = undefined
    finishLease()

    throw cause
  }

  return { client, identity }
}

/**
 * Closes the provider after any active lease finishes.
 *
 * @example
 *   await provider.close()
 */
function closeNativeProvider(
  state: NativeProviderState,
  dispose: () => Promise<void>,
): Promise<void> {
  if (state.closePromise) return state.closePromise

  state.closed = true
  const closing = (state.activeLease ?? Promise.resolve()).then(dispose)
  state.closePromise = closing.catch((cause: unknown) => {
    state.closePromise = undefined
    throw cause
  })
  return state.closePromise
}
