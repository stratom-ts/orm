import type { Connector } from 'db0'

import type { CompiledQuery } from '@/dialects'
import type {
  OperationSession,
  OperationSessionIdentity,
  OperationSessionProvider,
} from '@/operations/operationSession'
import { QueryError } from '@/utils/error'

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
  _getActiveQuery?(): unknown
  queryQueue?: unknown[]
  _queryQueue?: unknown[]
  connection?: {
    stream?: {
      destroy(error?: Error): void
    }
  }
  end?(): Promise<void>
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
): Promise<OperationSessionIdentity> {
  const result = await client.query(POSTGRES_OPERATION_IDENTITY_SQL)
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

/**
 * Creates the exact operation-session provider for db0 0.3.4's PostgreSQL
 * connector, whose `getInstance()` is one lazily connected native `pg.Client`.
 *
 * @example
 *   const provider = createDb0PostgresqlOperationSessionProvider(connector)
 *
 * @param connector - Db0 PostgreSQL connector.
 */
export function createDb0PostgresqlOperationSessionProvider(
  connector: Connector,
): OperationSessionProvider {
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

  /** Disposes the connector while normalizing synchronous failures to rejections. */
  const disposeConnector = (): Promise<void> => {
    try {
      return Promise.resolve(connector.dispose!()).then(() => undefined)
    } catch (cause) {
      return Promise.reject(cause)
    }
  }

  let leased = false
  let closed = false
  let closePromise: Promise<void> | undefined
  let activeLease: Promise<void> | undefined

  return {
    nativeTransactions: true,

    /**
     * Opens an exclusive operation session on the connector's native client.
     *
     * @example
     *   const session = await provider.open()
     */
    async open(): Promise<OperationSession> {
      if (closed) {
        throw new QueryError({ message: 'Operation session provider has been closed' })
      }

      if (leased) {
        throw new QueryError({
          message: 'PostgreSQL operation session is already leased',
        })
      }

      leased = true
      let finishLease!: () => void
      const lease = new Promise<void>((resolve) => {
        finishLease = resolve
      })
      activeLease = lease

      let client: NativePostgresClient
      let identity: OperationSessionIdentity

      try {
        client = asNativePostgresClient(await connector.getInstance())
        assertReusableNativeClient(client)
        identity = await readIdentity(client)
      } catch (cause) {
        await disposeConnector().catch(() => undefined)
        leased = false
        activeLease = undefined
        finishLease()
        if (cause instanceof QueryError) throw cause
        throw new QueryError({
          message:
            cause instanceof Error
              ? `Failed to open PostgreSQL operation session: ${cause.message}`
              : 'Failed to open PostgreSQL operation session',
          cause,
        })
      }

      let released = false
      let cancelled = false
      let requiresCleanup = false
      let activeController: AbortController | undefined
      let queue = Promise.resolve()

      /**
       * Serializes a session operation behind previously enqueued work.
       *
       * @param operation - Asynchronous session operation.
       */
      const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        if (released) {
          return Promise.reject(
            new QueryError({ message: 'Operation session has been released' }),
          )
        }

        if (cancelled) {
          return Promise.reject(
            new QueryError({ message: 'Operation session has been cancelled' }),
          )
        }

        const result = queue.then(() => {
          if (cancelled) {
            throw new QueryError({ message: 'Operation session has been cancelled' })
          }

          return operation()
        })
        queue = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      }

      /**
       * Executes a compiled query on the verified native client.
       *
       * @param query - Compiled query to execute.
       */
      const executeNative = async (
        query: CompiledQuery,
      ): Promise<NativePostgresResult> => {
        if (asNativePostgresClient(await connector.getInstance()) !== client) {
          throw new QueryError({
            message: 'PostgreSQL physical session changed during an operation',
          })
        }

        const controller = new AbortController()
        activeController = controller
        requiresCleanup ||= scanPostgresSql(query.sql).requiresCleanup

        try {
          return await client.query({
            text: query.sql,
            values: query.params,
            signal: controller.signal,
          })
        } finally {
          activeController = undefined
        }
      }

      return {
        identity,

        /**
         * Executes a query and returns its rows.
         *
         * @example
         *   const rows = await session.query(query)
         *
         * @param query - Compiled query to execute.
         */
        query(query): Promise<unknown[]> {
          return enqueue(async () => (await executeNative(query)).rows ?? [])
        },

        /**
         * Executes a statement without returning rows.
         *
         * @example
         *   await session.run(query)
         *
         * @param query - Compiled query to execute.
         */
        run(query): Promise<void> {
          return enqueue(async () => {
            await executeNative(query)
          })
        },

        /**
         * Cancels the session and hard-discards an active native query.
         *
         * @example
         *   await session.cancel()
         */
        async cancel(): Promise<void> {
          if (released) {
            throw new QueryError({ message: 'Operation session has been released' })
          }

          cancelled = true
          activeController?.abort()

          if (getActiveQuery(client) != null) {
            if (client.end) {
              // This hard-discard teardown is not a PostgreSQL backend cancel request.
              await client.end().catch(() => undefined)
            } else {
              client.connection?.stream?.destroy()
            }
          }
        },

        /**
         * Releases the session for reuse or disposal.
         *
         * @example
         *   await session.release('reuse')
         *
         * @param disposition - Whether to reuse or discard the physical session.
         */
        async release(disposition): Promise<void> {
          if (released) {
            throw new QueryError({
              message: 'Operation session was released more than once',
            })
          }

          released = true
          await queue

          let releaseFailed = false
          let releaseError: unknown

          try {
            if (disposition === 'discard' || cancelled) {
              await disposeConnector()
              return
            }

            assertReusableNativeClient(client)

            if (asNativePostgresClient(await connector.getInstance()) !== client) {
              throw new QueryError({
                message: 'PostgreSQL physical session changed before release',
              })
            }

            if (requiresCleanup) {
              await client.query(POSTGRES_OPERATION_ROLLBACK_SQL)
              await client.query(POSTGRES_OPERATION_UNLOCK_SQL)
            }

            const releasedIdentity = await readIdentity(client)

            if (!sameOperationSessionIdentity(releasedIdentity, identity)) {
              throw new QueryError({
                message: 'PostgreSQL session identity changed before release',
              })
            }
          } catch (cause) {
            releaseFailed = true
            releaseError = cause
            await disposeConnector().catch(() => undefined)
          } finally {
            leased = false
            activeLease = undefined
            finishLease()
          }

          if (releaseFailed) throw releaseError
        },
      }
    },

    /**
     * Closes the provider after any active lease finishes.
     *
     * @example
     *   await provider.close()
     */
    close(): Promise<void> {
      if (closePromise) return closePromise

      closed = true
      const closing = (activeLease ?? Promise.resolve()).then(disposeConnector)
      closePromise = closing.catch((cause) => {
        closePromise = undefined
        throw cause
      })
      return closePromise
    },
  }
}
