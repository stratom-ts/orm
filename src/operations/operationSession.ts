import type { Connector } from 'db0'

import type { CompiledQuery } from '@/dialects'
import { QueryError } from '@/utils/error'

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

function getActiveQuery(client: NativePostgresClient): unknown {
  if (typeof client._getActiveQuery === 'function') return client._getActiveQuery()
  if ('_activeQuery' in client) return client._activeQuery
  return client.activeQuery
}

function getQueryQueue(client: NativePostgresClient): unknown[] | undefined {
  if (Array.isArray(client._queryQueue)) return client._queryQueue
  return client.queryQueue
}

function normalizeParams(sql: string): string {
  let index = 0
  return sql.replaceAll('?', () => `$${++index}`)
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
  const result = await client.query(
    'select pg_backend_pid()::text as "physicalSession", current_database() as "database"',
  )
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
  const disposeConnector = (): Promise<void> =>
    Promise.resolve(connector.dispose!()).then(() => undefined)

  let leased = false
  let closed = false
  let closePromise: Promise<void> | undefined

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

      let client: NativePostgresClient
      let identity: OperationSessionIdentity
      try {
        client = asNativePostgresClient(await connector.getInstance())
        assertReusableNativeClient(client)
        identity = await readIdentity(client)
      } catch (cause) {
        leased = false
        await disposeConnector().catch(() => undefined)
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
        try {
          return await client.query({
            text: normalizeParams(query.sql),
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
              void client.end().catch(() => undefined)
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
            await client.query('rollback /* stratom operation release */')
            await client.query(
              'select pg_advisory_unlock_all() /* stratom operation release */',
            )
            const releasedIdentity = await readIdentity(client)
            if (
              releasedIdentity.database !== identity.database ||
              releasedIdentity.physicalSession !== identity.physicalSession
            ) {
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
          }
          if (releaseFailed) throw releaseError
        },
      }
    },

    close(): Promise<void> {
      if (closePromise) return closePromise
      closed = true
      return (closePromise = disposeConnector())
    },
  }
}
