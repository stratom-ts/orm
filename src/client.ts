import type { Dialect } from '@/dialects'
import { postgresDialect } from '@/dialects'
import { isTableHandle } from '@/defineTable'
import type { TableHandle } from '@/defineTable'
import { createMigrateBuilder } from '@/ddl'
import type { MigrateBuilder } from '@/ddl'
import {
  createDb0Executor,
  createTableBuilder,
  createValueMapper,
} from '@/query'
import type { QueryBuilder, ValueMapConfig } from '@/query'
import { QueryError, SchemaError } from '@/utils/error'
import { tableKey } from '@/utils/tableKey'
import { createDatabase } from 'db0'
import type { Connector, Database } from 'db0'

export type { TableHandle } from '@/defineTable'
export type { ValueMapConfig } from '@/query'

/** Options for {@link createDb}. */
export type CreateDbConfig<
  TSchemas extends readonly TableHandle[] = readonly TableHandle[],
> = {
  /** db0 connector (e.g. postgresql from `db0/connectors/postgresql`). */
  connector: Connector
  /** Registered table handles; may be empty. */
  schemas: TSchemas
  /** Dialect plugin; defaults to Postgres. */
  dialect?: Dialect
  /**
   * Global JS↔SQL value mapping overrides (applied after column metadata,
   * before dialect defaults when column overrides are absent).
   */
  map?: ValueMapConfig
}

/**
 * schema-orm client: owns the db0 database lifecycle and table registry.
 * Transaction clients (`trx`) share the same surface for from/transaction.
 */
export type Db<
  TSchemas extends readonly TableHandle[] = readonly TableHandle[],
> = {
  /** Registered table handles from `createDb`. */
  readonly schemas: TSchemas
  /**
   * Trivial connectivity check (`SELECT 1` via the owned db0 instance).
   */
  ping(): Promise<void>
  /**
   * Start a query rooted on a registered table handle.
   */
  from<THandle extends TableHandle>(handle: THandle): QueryBuilder<THandle>
  /**
   * Desired-state migrations for registered table handles.
   */
  migrate(): MigrateBuilder
  /**
   * Callback transaction: commits on success, rolls back on error.
   * Nested calls use SAVEPOINT / ROLLBACK TO / RELEASE.
   */
  transaction<T>(fn: (trx: Db<TSchemas>) => Promise<T>): Promise<T>
  /**
   * Releases underlying connection resources. Idempotent after first call.
   */
  close(): Promise<void>
  [Symbol.asyncDispose](): Promise<void>
}

function assertHandles(schemas: readonly TableHandle[]): void {
  const seen = new Set<string>()
  for (const schema of schemas) {
    if (!isTableHandle(schema)) {
      throw new SchemaError({
        message: 'createDb schemas must be table handles from defineTable()',
      })
    }
    const key = tableKey(schema.schema, schema.name)
    if (seen.has(key)) {
      throw new SchemaError({
        message: `duplicate table registration for "${key}"`,
      })
    }
    seen.add(key)
  }
}

/**
 * Creates a schema-orm client from a db0 connector and table handles.
 *
 * schema-orm calls `createDatabase(connector)` and owns that instance.
 * No auto-migrate; no Kysely.
 *
 * @param config - Connector and registered schemas
 * @returns Client with registry, `from`, `transaction`, `ping`, `close`
 *
 * @example
 * ```ts
 * import { postgresql } from 'db0/connectors/postgresql'
 *
 * const db = createDb({
 *   connector: postgresql({ url: process.env.DATABASE_URL! }),
 *   schemas: [User],
 * })
 * await db.transaction(async (trx) => {
 *   await trx.from(User).insert({ ... }).execute()
 * })
 * await db.close()
 * ```
 */
export function createDb<
  const TSchemas extends readonly TableHandle[] = readonly TableHandle[],
>(config: CreateDbConfig<TSchemas>): Db<TSchemas> {
  assertHandles(config.schemas)

  const database: Database = createDatabase(config.connector)
  const dialect = config.dialect ?? postgresDialect
  const schemas = config.schemas
  const registry = new Map<string, TableHandle>()
  for (const handle of schemas) {
    registry.set(tableKey(handle.schema, handle.name), handle)
  }

  const rootExecutor = createDb0Executor(database)
  const mapper = createValueMapper(dialect, config.map)
  let closed = false
  /** Depth of open transactions/savepoints on this client (0 = none). */
  let txDepth = 0

  const ensureOpen = () => {
    if (closed) {
      throw new QueryError({ message: 'Database has been closed' })
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await database.dispose()
  }

  const ping = async (): Promise<void> => {
    ensureOpen()
    try {
      await database.sql`select 1`
    } catch (cause) {
      throw new QueryError({
        message:
          cause instanceof Error ? cause.message : 'Connectivity check failed',
        cause,
      })
    }
  }

  const createClient = (
    executor: ReturnType<typeof createDb0Executor>,
  ): Db<TSchemas> => {
    const from = <THandle extends TableHandle>(
      handle: THandle,
    ): QueryBuilder<THandle> => {
      ensureOpen()
      if (!isTableHandle(handle)) {
        throw new SchemaError({
          message: 'db.from() expects a table handle from defineTable()',
        })
      }
      const key = tableKey(handle.schema, handle.name)
      if (!registry.has(key)) {
        throw new SchemaError({
          message: `table "${key}" is not registered on this client; pass it in createDb({ schemas })`,
        })
      }
      return createTableBuilder({ handle, dialect, executor, mapper })
    }

    const migrate = (): MigrateBuilder => {
      ensureOpen()
      return createMigrateBuilder({ schemas, dialect, executor })
    }

    const transaction = async <T>(
      fn: (trx: Db<TSchemas>) => Promise<T>,
    ): Promise<T> => {
      ensureOpen()
      const isOuter = txDepth === 0
      const savepointName = isOuter ? undefined : `sp_${txDepth}`

      if (isOuter) {
        await executor.run({ sql: 'begin', params: [] })
      } else {
        await executor.run({
          sql: `savepoint ${savepointName}`,
          params: [],
        })
      }
      txDepth += 1

      try {
        const trx = createClient(executor)
        const result = await fn(trx)
        if (isOuter) {
          await executor.run({ sql: 'commit', params: [] })
        } else {
          await executor.run({
            sql: `release savepoint ${savepointName}`,
            params: [],
          })
        }
        return result
      } catch (error) {
        try {
          if (isOuter) {
            await executor.run({ sql: 'rollback', params: [] })
          } else {
            await executor.run({
              sql: `rollback to savepoint ${savepointName}`,
              params: [],
            })
            await executor.run({
              sql: `release savepoint ${savepointName}`,
              params: [],
            })
          }
        } catch {
          // ignore rollback failures; rethrow original
        }
        throw error
      } finally {
        txDepth -= 1
      }
    }

    return {
      schemas,
      ping,
      from,
      migrate,
      transaction,
      close,
      [Symbol.asyncDispose]: close,
    }
  }

  return createClient(rootExecutor)
}
