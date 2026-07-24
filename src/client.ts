import type { MigrateBuilder } from '@/ddl'
import { createMigrateBuilder } from '@/ddl'
import { isTableHandle } from '@/defineTable'
import type { Dialect } from '@/dialects'
import { postgresDialect } from '@/dialects'
import type {
  DeleteBuilder,
  InsertBuilder,
  InsertValuesBuilder,
  QueryBuilder,
  UpdateBuilder,
  UpdateSetBuilder,
  ValueMapConfig,
} from '@/query'
import {
  createDb0Executor,
  createDeleteBuilder,
  createInsertBuilder,
  createTableBuilder,
  createUpdateBuilder,
  createValueMapper,
  validateInsertRow,
  validateUpdatePatch,
} from '@/query'
import type { TableHandle } from '@/types'
import type { InferSelect } from '@/types/views'
import { QueryError, SchemaError } from '@/utils/error'
import { tableKey } from '@/utils/tableKey'
import type { Connector, Database } from 'db0'
import { createDatabase } from 'db0'

export type { ValueMapConfig } from '@/query'
export type { TableHandle } from '@/types'

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
 * Stratom client: owns the db0 database lifecycle and table registry.
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
   * Insert rows into a registered table.
   *
   * @example
   * ```ts
   * await db.insert(User).values({ name: 'Alice' }).executeTakeFirstOrThrow()
   * ```
   */
  insert<THandle extends TableHandle>(
    handle: THandle,
  ): InsertValuesBuilder<THandle>
  /**
   * Update rows in a registered table.
   *
   * @example
   * ```ts
   * await db.update(User).set({ name: 'Bob' }).where(User.id, 'eq', 1).execute()
   * ```
   */
  update<THandle extends TableHandle>(
    handle: THandle,
  ): UpdateSetBuilder<THandle>
  /**
   * Delete rows from a registered table.
   * Returns all deleted rows by default.
   *
   * @example
   * ```ts
   * const deleted = await db.delete(User).where(User.id, 'eq', 1).executeTakeFirstOrThrow()
   * ```
   */
  delete<THandle extends TableHandle>(
    handle: THandle,
  ): DeleteBuilder<THandle, InferSelect<THandle>>
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
    const info = schema.getTableMetadata()
    const key = tableKey(info.schema, info.name)
    if (seen.has(key)) {
      throw new SchemaError({
        message: `duplicate table registration for "${key}"`,
      })
    }
    seen.add(key)
  }
}

/**
 * Creates a Stratom client from a db0 connector and table handles.
 *
 * Stratom calls `createDatabase(connector)` and owns that instance.
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
 *   await trx.insert(User).values({ ... }).execute()
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
    const info = handle.getTableMetadata()
    registry.set(tableKey(info.schema, info.name), handle)
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
      const info = handle.getTableMetadata()
      const key = tableKey(info.schema, info.name)
      if (!registry.has(key)) {
        throw new SchemaError({
          message: `table "${key}" is not registered on this client; pass it in createDb({ schemas })`,
        })
      }
      return createTableBuilder({ handle, dialect, executor, mapper })
    }

    const insert = <THandle extends TableHandle>(
      handle: THandle,
    ): InsertValuesBuilder<THandle> => {
      ensureOpen()
      if (!isTableHandle(handle)) {
        throw new SchemaError({
          message: 'db.insert() expects a table handle from defineTable()',
        })
      }
      const info = handle.getTableMetadata()
      const key = tableKey(info.schema, info.name)
      if (!registry.has(key)) {
        throw new SchemaError({
          message: `table "${key}" is not registered on this client; pass it in createDb({ schemas })`,
        })
      }
      return {
        values: (rowOrRows) => {
          const list = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]
          if (list.length === 0) {
            throw new QueryError({
              message: `insert into "${info.name}" requires at least one row`,
            })
          }
          const validated = list.map((row) => validateInsertRow(handle, row))
          return createInsertBuilder({
            handle,
            dialect,
            executor,
            mapper,
            rows: validated,
            returning: { kind: 'all' },
          }) as InsertBuilder<THandle, InferSelect<THandle>>
        },
      }
    }

    const validateHandle = (handle: TableHandle, method: string) => {
      if (!isTableHandle(handle)) {
        throw new SchemaError({
          message: `db.${method}() expects a table handle from defineTable()`,
        })
      }
      const info = handle.getTableMetadata()
      const key = tableKey(info.schema, info.name)
      if (!registry.has(key)) {
        throw new SchemaError({
          message: `table "${key}" is not registered on this client; pass it in createDb({ schemas })`,
        })
      }
    }

    const update = <THandle extends TableHandle>(
      handle: THandle,
    ): UpdateSetBuilder<THandle> => {
      ensureOpen()
      validateHandle(handle, 'update')
      return {
        set: (patch) => {
          const validated = validateUpdatePatch(handle, patch)
          return createUpdateBuilder({
            handle,
            dialect,
            executor,
            mapper,
            patch: validated,
            allowAll: false,
            returning: { kind: 'all' },
          }) as UpdateBuilder<THandle, InferSelect<THandle>>
        },
      }
    }

    const delete_ = <THandle extends TableHandle>(
      handle: THandle,
    ): DeleteBuilder<THandle, InferSelect<THandle>> => {
      ensureOpen()
      validateHandle(handle, 'delete')
      return createDeleteBuilder({
        handle,
        dialect,
        executor,
        mapper,
        allowAll: false,
        returning: { kind: 'all' },
      }) as DeleteBuilder<THandle, InferSelect<THandle>>
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
      insert,
      update,
      delete: delete_,
      migrate,
      transaction,
      close,
      [Symbol.asyncDispose]: close,
    }
  }

  return createClient(rootExecutor)
}
