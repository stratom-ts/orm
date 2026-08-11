import type { Connector } from 'db0'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import type { CompiledQuery } from '@/dialects'
import { QueryError } from '@/utils/error'

import type {
  OperationSession,
  OperationSessionIdentity,
  OperationSessionProvider,
} from './operationSession'

type NativeStatement = {
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): unknown
}

type NativeDatabase = {
  readonly isOpen: boolean
  readonly isTransaction: boolean
  prepare(sql: string): NativeStatement
  exec(sql: string): void
  close(): void
}

const nativePhysicalIds = new WeakMap<object, string>()
const nativeMemoryIdentities = new WeakMap<object, string>()
let nextPhysicalId = 1
let nextMemoryId = 1

function queryError(message: string, cause?: unknown): QueryError {
  return new QueryError({ message, ...(cause === undefined ? {} : { cause }) })
}

function asNativeDatabase(value: unknown): NativeDatabase {
  const sqlite = process.getBuiltinModule?.('node:sqlite') as
    | { DatabaseSync?: new (...args: never[]) => object }
    | undefined
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof sqlite?.DatabaseSync !== 'function' ||
    !(value instanceof sqlite.DatabaseSync) ||
    typeof (value as Partial<NativeDatabase>).prepare !== 'function' ||
    typeof (value as Partial<NativeDatabase>).exec !== 'function' ||
    typeof (value as Partial<NativeDatabase>).close !== 'function' ||
    typeof (value as Partial<NativeDatabase>).isOpen !== 'boolean' ||
    typeof (value as Partial<NativeDatabase>).isTransaction !== 'boolean'
  ) {
    throw queryError(
      'The db0 node-sqlite connector did not expose an open native node:sqlite DatabaseSync',
    )
  }
  return value as NativeDatabase
}

function ensureOpen(database: NativeDatabase): void {
  if (database.isOpen !== true) {
    throw queryError('The node:sqlite DatabaseSync is closed')
  }
}

function ensureParams(params: readonly unknown[]): void {
  for (const value of params) {
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint' &&
      !ArrayBuffer.isView(value)
    ) {
      throw queryError(
        `node:sqlite does not support the query parameter type '${typeof value}'`,
      )
    }
  }
}

function physicalId(database: object): string {
  let id = nativePhysicalIds.get(database)
  if (!id) {
    id = `node-sqlite:${nextPhysicalId++}`
    nativePhysicalIds.set(database, id)
  }
  return id
}

function canonicalMainLocation(location: string): string {
  if (location.length === 0 || location === ':memory:') return ''
  const candidate = isAbsolute(location) ? location : resolve(location)
  try {
    return realpathSync.native(candidate)
  } catch {
    return resolve(candidate)
  }
}

function readMainLocation(database: NativeDatabase): string {
  let rows: unknown[]
  try {
    rows = database.prepare('pragma database_list').all()
  } catch (cause) {
    if (cause instanceof QueryError) throw cause
    throw queryError('Failed to read the node:sqlite main database identity', cause)
  }
  if (!Array.isArray(rows)) {
    throw queryError('The node:sqlite database identity query did not return rows')
  }
  const main = rows.find(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      (row as { name?: unknown }).name === 'main',
  ) as { file?: unknown } | undefined
  if (!main || typeof main.file !== 'string') {
    throw queryError(
      'The node:sqlite database identity did not include the main database',
    )
  }
  return canonicalMainLocation(main.file)
}

function identityFor(database: NativeDatabase): OperationSessionIdentity {
  const location = readMainLocation(database)
  let databaseIdentity: string
  if (location) {
    databaseIdentity = JSON.stringify({ dialect: 'sqlite', database: 'main', location })
  } else {
    databaseIdentity = nativeMemoryIdentities.get(database) ?? ''
    if (!databaseIdentity) {
      databaseIdentity = JSON.stringify({
        dialect: 'sqlite',
        database: 'main',
        memory: nextMemoryId++,
      })
      nativeMemoryIdentities.set(database, databaseIdentity)
    }
  }
  return Object.freeze({
    database: databaseIdentity,
    physicalSession: physicalId(database),
  })
}

function sameIdentity(a: OperationSessionIdentity, b: OperationSessionIdentity): boolean {
  return a.database === b.database && a.physicalSession === b.physicalSession
}

/** Creates an exclusive operation-session provider for db0's node:sqlite connector. */
export function createDb0NodeSqliteOperationSessionProvider(
  connector: Connector,
): OperationSessionProvider {
  if (
    connector.name !== 'node-sqlite' ||
    connector.dialect !== 'sqlite' ||
    typeof connector.getInstance !== 'function' ||
    typeof connector.dispose !== 'function'
  ) {
    throw queryError(
      'Automatic operation sessions require the db0 node-sqlite connector; provide an explicit operationSessionProvider for a custom connector',
    )
  }

  const identities = new WeakMap<object, OperationSessionIdentity>()
  let leased = false
  let closed = false
  let closePromise: Promise<void> | undefined
  let activeLease: Promise<void> | undefined

  const getNative = async (): Promise<NativeDatabase> => {
    let value: unknown
    try {
      value = await connector.getInstance()
    } catch (cause) {
      throw queryError('Failed to get the node:sqlite native database', cause)
    }
    try {
      return asNativeDatabase(value)
    } catch (cause) {
      if (cause instanceof QueryError) throw cause
      throw queryError('Failed to validate the node:sqlite native database', cause)
    }
  }
  const disposeConnector = async (): Promise<void> => {
    try {
      await connector.dispose!()
    } catch (cause) {
      throw queryError('Failed to dispose the node:sqlite connector', cause)
    }
  }

  return {
    nativeTransactions: true,
    async open(): Promise<OperationSession> {
      if (closed) throw queryError('Operation session provider has been closed')
      if (leased) throw queryError('node:sqlite operation session is already leased')
      leased = true
      let finishLease!: () => void
      const lease = new Promise<void>((resolveLease) => {
        finishLease = resolveLease
      })
      activeLease = lease

      let database: NativeDatabase
      let identity: OperationSessionIdentity
      try {
        database = await getNative()
        ensureOpen(database)
        const cached = identities.get(database)
        if (cached) {
          const current = identityForCurrent(database, cached)
          if (!sameIdentity(current, cached)) {
            throw queryError(
              'node:sqlite cached session identity no longer matches the native database',
            )
          }
          identity = cached
        } else {
          identity = identityFor(database)
          identities.set(database, identity)
        }
      } catch (cause) {
        await disposeConnector().catch(() => undefined)
        leased = false
        activeLease = undefined
        finishLease()
        if (cause instanceof QueryError) throw cause
        throw queryError('Failed to open node:sqlite operation session', cause)
      }

      let released = false
      let releasing = false
      let cancelled = false
      let queue = Promise.resolve()

      const verify = async (): Promise<void> => {
        if (released) throw queryError('Operation session has been released')
        if (cancelled) throw queryError('Operation session has been cancelled')
        const current = await getNative()
        if (current !== database) {
          throw queryError('node:sqlite physical session changed during an operation')
        }
        ensureOpen(current)
        const currentIdentity = identityForCurrent(current, identity)
        if (!sameIdentity(currentIdentity, identity)) {
          throw queryError('node:sqlite session identity changed during an operation')
        }
      }

      const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
        if (released || releasing)
          return Promise.reject(queryError('Operation session has been released'))
        if (cancelled)
          return Promise.reject(queryError('Operation session has been cancelled'))
        const result = queue.then(async () => {
          if (cancelled) throw queryError('Operation session has been cancelled')
          await verify()
          if (released) throw queryError('Operation session has been released')
          if (cancelled) throw queryError('Operation session has been cancelled')
          return operation()
        })
        queue = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      }

      return {
        identity,
        query(query: CompiledQuery): Promise<unknown[]> {
          return enqueue(async () => {
            ensureParams(query.params)
            try {
              const statement = database.prepare(query.sql)
              return statement.all(...query.params)
            } catch (cause) {
              if (cause instanceof QueryError) throw cause
              throw queryError('SQLite query execution failed', cause)
            }
          })
        },
        run(query: CompiledQuery): Promise<void> {
          return enqueue(async () => {
            ensureParams(query.params)
            try {
              const statement = database.prepare(query.sql)
              statement.run(...query.params)
            } catch (cause) {
              if (cause instanceof QueryError) throw cause
              throw queryError('SQLite statement execution failed', cause)
            }
          })
        },
        async cancel(): Promise<void> {
          if (released) throw queryError('Operation session has been released')
          cancelled = true
          // DatabaseSync calls cannot be interrupted; release waits for the call to return.
          await queue
        },
        async release(disposition): Promise<void> {
          if (released || releasing)
            throw queryError('Operation session was released more than once')
          releasing = true
          await queue
          released = true
          let failed = false
          let failure: unknown
          try {
            if (disposition === 'discard' || cancelled) {
              await disposeConnector()
              return
            }
            const current = await getNative()
            if (current !== database) {
              throw queryError('node:sqlite physical session changed before release')
            }
            await verifyRelease(database, identity)
            if (database.isTransaction) {
              try {
                database.exec('rollback')
              } catch (cause) {
                if (cause instanceof QueryError) throw cause
                throw queryError('SQLite rollback during session release failed', cause)
              }
              if (database.isTransaction) {
                throw queryError(
                  'The node:sqlite transaction remained open during release',
                )
              }
            }
            await verifyRelease(database, identity)
          } catch (cause) {
            failed = true
            failure = cause
            await disposeConnector().catch(() => undefined)
          } finally {
            leased = false
            activeLease = undefined
            finishLease()
          }
          if (failed) throw failure
        },
      }
    },
    close(): Promise<void> {
      if (closePromise) return closePromise
      closed = true
      closePromise = (activeLease ?? Promise.resolve())
        .then(() => disposeConnector())
        .catch((cause) => {
          closePromise = undefined
          throw cause
        })
      return closePromise
    },
  }
}

function identityForCurrent(
  database: NativeDatabase,
  original: OperationSessionIdentity,
): OperationSessionIdentity {
  const location = readMainLocation(database)
  const expected = original.database
  const memory = location.length === 0
  const databaseIdentity = memory
    ? expected
    : JSON.stringify({ dialect: 'sqlite', database: 'main', location })
  return Object.freeze({
    database: databaseIdentity,
    physicalSession: physicalId(database),
  })
}

async function verifyRelease(
  database: NativeDatabase,
  identity: OperationSessionIdentity,
): Promise<void> {
  ensureOpen(database)
  const current = identityForCurrent(database, identity)
  if (!sameIdentity(current, identity)) {
    throw queryError('node:sqlite session identity changed before release')
  }
}
