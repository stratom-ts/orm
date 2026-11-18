import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

import type {
  CreateDatabaseConfig,
  Db,
  MigrationOwnershipDeclaration,
  TableHandle,
} from '@/index'
import { createDatabase } from '@/index'
import type { ValueMapConfig } from '@/query'

import type { DialectIntegrationAdapter } from '../support/dialectIntegrationContract'

import { collectClosedSqliteStatements } from './sqliteNativeLifetime'

type SqliteDatabaseOptions = Readonly<{
  naming?: CreateDatabaseConfig['naming']
  library?: { createDatabase: typeof createDatabase }
  map?: ValueMapConfig
  file?: boolean
  migrationOwnership?: readonly MigrationOwnershipDeclaration[]
  additionalCleanup?(): Promise<void>
}>

type CallbackSettlement<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected'; reason: unknown }>

type SqliteDatabaseContext<TSchemas extends readonly TableHandle[]> = Readonly<{
  connector: ReturnType<typeof nodeSqliteConnector>
  db: Db<TSchemas>
  /** Use only during the callback, sequentially with public db operations. */
  native: DatabaseSync
  filePath?: string
  nativeSql(sql: string): Promise<void>
}>

/** Owns one native SQLite connection and, when requested, its temporary database file. */
async function withSqliteDatabase<const TSchemas extends readonly TableHandle[], TResult>(
  schemas: TSchemas,
  callback: (context: SqliteDatabaseContext<TSchemas>) => Promise<TResult>,
  options: SqliteDatabaseOptions = {},
): Promise<TResult> {
  const directory = options.file
    ? await mkdtemp(join(tmpdir(), 'stratom-sqlite-'))
    : undefined

  const filePath = directory ? join(directory, 'test.sqlite') : undefined
  let connector: ReturnType<typeof nodeSqliteConnector> | undefined
  let db: Db<TSchemas> | undefined
  let settlement: CallbackSettlement<TResult>

  try {
    connector = nodeSqliteConnector(filePath ? { path: filePath } : { name: ':memory:' })
    db = (options.library?.createDatabase ?? createDatabase)({
      connector,
      schemas,
      map: options.map,
      naming: options.naming,
      ...(options.migrationOwnership === undefined
        ? {}
        : { migrationOwnership: options.migrationOwnership }),
    })
    const native = await connector.getInstance()
    const value = await callback({
      connector,
      db,
      native,
      filePath,
      /** Executes physical SQL on the owned connection, including foreign-key checks. */
      async nativeSql(sql) {
        native.exec('pragma foreign_keys = on')
        native.exec(sql)
      },
    })

    settlement = { status: 'fulfilled', value }
  } catch (reason) {
    settlement = { status: 'rejected', reason }
  }

  const cleanupErrors = await cleanupSqliteDatabase(db, connector, directory, options)

  return unwrapSqliteCallback(settlement, cleanupErrors)
}

/** Owns a native connector without creating a Client that could claim its provider. */
async function withSqliteConnector<TResult>(
  callback: (
    context: Readonly<{
      connector: ReturnType<typeof nodeSqliteConnector>
      native: DatabaseSync
    }>,
  ) => Promise<TResult>,
): Promise<TResult> {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  let settlement: CallbackSettlement<TResult>
  try {
    const native = await connector.getInstance()
    settlement = { status: 'fulfilled', value: await callback({ connector, native }) }
  } catch (reason) {
    settlement = { status: 'rejected', reason }
  }

  const cleanupErrors = await cleanupSqliteDatabase(undefined, connector, undefined, {})
  return unwrapSqliteCallback(settlement, cleanupErrors)
}

/** Returns callback success or reports primary and cleanup failures in order. */
function unwrapSqliteCallback<TResult>(
  settlement: CallbackSettlement<TResult>,
  cleanupErrors: unknown[],
): TResult {
  if (settlement.status === 'rejected') {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [settlement.reason, ...cleanupErrors],
        'SQLite test failed',
      )
    }

    throw settlement.reason
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'SQLite test cleanup failed')
  }

  return settlement.value
}

/** Attempts every owned cleanup action and retains its failures in order. */
async function cleanupSqliteDatabase(
  db: { close(): Promise<void> } | undefined,
  connector: ReturnType<typeof nodeSqliteConnector> | undefined,
  directory: string | undefined,
  options: SqliteDatabaseOptions,
): Promise<unknown[]> {
  const cleanupErrors: unknown[] = []
  try {
    await db?.close()
  } catch (cause) {
    cleanupErrors.push(cause)
  }

  try {
    // db.close() owns claimed sessions; this also closes a native-only connection.
    await connector?.dispose?.()
  } catch (cause) {
    cleanupErrors.push(cause)
  }

  try {
    await options.additionalCleanup?.()
  } catch (cause) {
    cleanupErrors.push(cause)
  }

  if (directory) {
    try {
      collectClosedSqliteStatements()
      await rm(directory, { recursive: true, force: true })
    } catch (cause) {
      cleanupErrors.push(cause)
    }
  }

  return cleanupErrors
}

const supported = { state: 'supported' as const }

const sqliteIntegrationAdapter: DialectIntegrationAdapter = {
  name: 'SQLite node-sqlite',
  dialectId: 'sqlite',
  capabilities: {
    lifecycle: supported,
    query: supported,
    transaction: supported,
    migration: supported,
    convergence: supported,
  },
  /** Verifies native SQLite availability before running shared scenarios. */
  async readiness() {
    await withSqliteDatabase([], async ({ db }) => db.ping())
  },
  /** Runs a shared scenario on one isolated native SQLite connection. */
  withDatabase(schemas, callback) {
    return withSqliteDatabase(schemas, (context) =>
      callback({
        ...context,
        /** Reads native declared types without the production normalization helper. */
        async readColumnTypes(table) {
          const rows = context.native
            .prepare('select name, type from pragma_table_info(?)')
            .all(table)

          return Object.fromEntries(
            rows.map((row) => [String(row.name), String(row.type)]),
          )
        },
      }),
    )
  },
}

export type { SqliteDatabaseContext }

export { withSqliteDatabase, withSqliteConnector, sqliteIntegrationAdapter }
