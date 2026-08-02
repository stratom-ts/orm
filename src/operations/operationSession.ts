import type { Connector } from 'db0'

import type { CompiledQuery } from '@/dialects'
import { QueryError } from '@/utils/error'

import { scanPostgresSql } from './postgresSql'

/** Whether a completed physical session may be reused or must be discarded. */
export type OperationSessionDisposition = 'reuse' | 'discard'

/** Stable identity of the database and physical backend serving an operation. */
export type OperationSessionIdentity = Readonly<{
  database: string
  physicalSession: string
}>

/** An exclusive physical database session used for one root operation. */
export type OperationSession = {
  readonly identity: OperationSessionIdentity
  query(query: CompiledQuery): Promise<unknown[]>
  run(query: CompiledQuery): Promise<void>
  cancel(): Promise<void>
  release(disposition: OperationSessionDisposition): Promise<void>
}

/** Opens exclusive physical sessions with native transaction affinity. */
export type OperationSessionProvider = {
  readonly nativeTransactions: true
  open(): Promise<OperationSession>
  close(): Promise<void>
}

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
  'select pg_backend_pid()::text as "physicalSession", current_database() as "database"'
export const POSTGRES_OPERATION_ROLLBACK_SQL = 'rollback /* stratom operation release */'
export const POSTGRES_OPERATION_UNLOCK_SQL =
  'select pg_advisory_unlock_all() /* stratom operation release */'

function getActiveQuery(client: NativePostgresClient): unknown {
  if (typeof client._getActiveQuery === 'function') return client._getActiveQuery()
  if ('_activeQuery' in client) return client._activeQuery
  return client.activeQuery
}

function getQueryQueue(client: NativePostgresClient): unknown[] | undefined {
  if (Array.isArray(client._queryQueue)) return client._queryQueue
  return client.queryQueue
}

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

async function readIdentity(
  client: NativePostgresClient,
): Promise<OperationSessionIdentity> {
  const result = await client.query(POSTGRES_OPERATION_IDENTITY_SQL)
  const row = result.rows?.[0] as
    | { database?: unknown; physicalSession?: unknown }
    | undefined
  const database = row?.database
  const physicalSession = row?.physicalSession
  if (
    typeof database !== 'string' ||
    database.length === 0 ||
    typeof physicalSession !== 'string' ||
    physicalSession !== String(client.processID) ||
    (client.database !== undefined && client.database !== database)
  ) {
    throw new QueryError({
      message:
        'The db0 PostgreSQL connector could not prove backend and database identity',
    })
  }
  return Object.freeze({ database, physicalSession })
}

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

/**
 * Creates the exact operation-session provider for db0 0.3.4's PostgreSQL
 * connector, whose `getInstance()` is one lazily connected native `pg.Client`.
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
  const disposeConnector = (): Promise<void> => {
    try {
      return Promise.resolve(connector.dispose!()).then(() => undefined)
    } catch (cause) {
      return Promise.reject(cause)
    }
  }
  const identities = new WeakMap<object, OperationSessionIdentity>()

  let leased = false
  let closed = false
  let closePromise: Promise<void> | undefined
  let activeLease: Promise<void> | undefined

  return {
    nativeTransactions: true,

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
        const cachedIdentity = identities.get(client)
        if (cachedIdentity) {
          if (
            cachedIdentity.database !== client.database ||
            cachedIdentity.physicalSession !== String(client.processID)
          ) {
            throw new QueryError({
              message: 'PostgreSQL cached session identity no longer matches the client',
            })
          }
          identity = cachedIdentity
        } else {
          identity = await readIdentity(client)
          identities.set(client, identity)
        }
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

        query(query): Promise<unknown[]> {
          return enqueue(async () => (await executeNative(query)).rows ?? [])
        },

        run(query): Promise<void> {
          return enqueue(async () => {
            await executeNative(query)
          })
        },

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
            if (
              identity.database !== client.database ||
              identity.physicalSession !== String(client.processID)
            ) {
              throw new QueryError({
                message: 'PostgreSQL session identity changed before release',
              })
            }
            if (requiresCleanup) {
              await client.query(POSTGRES_OPERATION_ROLLBACK_SQL)
              await client.query(POSTGRES_OPERATION_UNLOCK_SQL)
              const releasedIdentity = await readIdentity(client)
              if (
                releasedIdentity.database !== identity.database ||
                releasedIdentity.physicalSession !== identity.physicalSession
              ) {
                throw new QueryError({
                  message: 'PostgreSQL session identity changed before release',
                })
              }
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
