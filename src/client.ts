import type { Connector, Database } from 'db0'
import { createDatabase } from 'db0'

import type { MigrateBuilder } from '@/ddl'
import { createMigrateBuilder } from '@/ddl'
import { isTableHandle } from '@/defineTable'
import { resolveDialect } from '@/dialects'
import type {
  DeleteBuilder,
  Executor,
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
import { MigrationError, QueryError, SchemaError } from '@/utils/error'
import { tableKey } from '@/utils/tableKey'

export type { ValueMapConfig } from '@/query'
export type { TableHandle } from '@/types'

type TransactionContext = {
  nextSavepointId: number
}

type TransactionScope = {
  active: boolean
  context: TransactionContext
}

/** Options for {@link createDb}. */
export type CreateDbConfig<
  TSchemas extends readonly TableHandle[] = readonly TableHandle[],
> = {
  /** Db0 connector (e.g. postgresql from `db0/connectors/postgresql`). */
  connector: Connector
  /** Registered table handles; may be empty. */
  schemas: TSchemas
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
export type Db<TSchemas extends readonly TableHandle[] = readonly TableHandle[]> = {
  /** Registered table handles from `createDb`. */
  readonly schemas: TSchemas
  /** Trivial connectivity check (`SELECT 1` via the owned db0 instance). */
  ping(): Promise<void>
  /** Start a query rooted on a registered table handle. */
  from<THandle extends TableHandle>(handle: THandle): QueryBuilder<THandle>
  /**
   * Insert rows into a registered table.
   *
   * @example
   *   ;```ts
   *   await db.insert(User).values({ name: 'Alice' }).executeTakeFirstOrThrow()
   * ```
   */
  insert<THandle extends TableHandle>(handle: THandle): InsertValuesBuilder<THandle>
  /**
   * Update rows in a registered table.
   *
   * @example
   *   ;```ts
   *   await db.update(User).set({ name: 'Bob' }).where(User.id, 'eq', 1).execute()
   * ```
   */
  update<THandle extends TableHandle>(handle: THandle): UpdateSetBuilder<THandle>
  /**
   * Delete rows from a registered table.
   * Returns all deleted rows by default.
   *
   * @example
   *   ;```ts
   *   const deleted = await db
   *     .delete(User)
   *     .where(User.id, 'eq', 1)
   *     .executeTakeFirstOrThrow()
   * ```
   */
  delete<THandle extends TableHandle>(
    handle: THandle,
  ): DeleteBuilder<THandle, InferSelect<THandle>>
  /** Desired-state migrations for registered table handles. */
  migrate(): MigrateBuilder
  /**
   * Callback transaction: commits on success, rolls back on error.
   * Nested calls use SAVEPOINT / ROLLBACK TO / RELEASE.
   */
  transaction<T>(fn: (trx: Db<TSchemas>) => Promise<T>): Promise<T>
  /** Releases underlying connection resources. Idempotent after first call. */
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
 * @param config - Connector and registered schemas.
 *
 * @returns Client with registry, `from`, `transaction`, `ping`, `close`
 *
 * @example```ts
 * import { postgresql } from 'db0/connectors/postgresql'
 *
 *   const db = createDb({
 *   connector: postgresql({ url: process.env.DATABASE_URL! }),
 *   schemas: [User],
 *   })
 *   await db.transaction(async (trx) => {
 *   await trx.insert(User).values({ ... }).execute()
 *   })
 *   await db.close()
 * ```
 */
export function createDb<
  const TSchemas extends readonly TableHandle[] = readonly TableHandle[],
>(config: CreateDbConfig<TSchemas>): Db<TSchemas> {
  assertHandles(config.schemas)

  const database: Database = createDatabase(config.connector)
  const dialect = resolveDialect(config.connector.dialect)
  const schemas = config.schemas
  const registry = new Map<string, TableHandle>()
  for (const handle of schemas) {
    const info = handle.getTableMetadata()
    registry.set(tableKey(info.schema, info.name), handle)
  }

  const baseExecutor = createDb0Executor(database)
  const mapper = createValueMapper(dialect, config.map)
  let closed = false
  let transactionActive = false
  let rootClientBlocked = false
  let connectionQueue = Promise.resolve()

  const ensureOpen = () => {
    if (closed) {
      throw new QueryError({ message: 'Database has been closed' })
    }
  }

  const schedule = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = connectionQueue.then(operation)
    connectionQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const rootExecutor: Executor = {
    execute(query) {
      ensureOpen()
      if (rootClientBlocked) {
        throw new QueryError({
          message:
            'Cannot use the root database client inside a transaction callback; use the transaction client (trx) instead',
        })
      }
      return schedule(() => baseExecutor.execute(query))
    },
    run(query) {
      ensureOpen()
      if (rootClientBlocked) {
        throw new QueryError({
          message:
            'Cannot use the root database client inside a transaction callback; use the transaction client (trx) instead',
        })
      }
      return schedule(() => baseExecutor.run(query))
    },
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await connectionQueue
    await database.dispose()
  }

  const createClient = (
    executor: Executor,
    transactionScope?: TransactionScope,
  ): Db<TSchemas> => {
    const ensureClientOpen = () => {
      ensureOpen()
      if (transactionScope && !transactionScope.active) {
        throw new QueryError({ message: 'Transaction client is no longer active' })
      }
    }

    const clientExecutor: Executor = transactionScope
      ? {
          execute(query) {
            ensureClientOpen()
            return executor.execute(query)
          },
          run(query) {
            ensureClientOpen()
            return executor.run(query)
          },
        }
      : executor

    const ping = async (): Promise<void> => {
      ensureClientOpen()
      try {
        await clientExecutor.execute({ sql: 'select 1', params: [] })
      } catch (cause) {
        if (cause instanceof QueryError) throw cause
        throw new QueryError({
          message: cause instanceof Error ? cause.message : 'Connectivity check failed',
          cause,
        })
      }
    }

    const from = <THandle extends TableHandle>(
      handle: THandle,
    ): QueryBuilder<THandle> => {
      ensureClientOpen()
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
      return createTableBuilder({ handle, dialect, executor: clientExecutor, mapper })
    }

    const insert = <THandle extends TableHandle>(
      handle: THandle,
    ): InsertValuesBuilder<THandle> => {
      ensureClientOpen()
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
            executor: clientExecutor,
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
      ensureClientOpen()
      validateHandle(handle, 'update')
      return {
        set: (patch) => {
          const validated = validateUpdatePatch(handle, patch)
          return createUpdateBuilder({
            handle,
            dialect,
            executor: clientExecutor,
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
      ensureClientOpen()
      validateHandle(handle, 'delete')
      return createDeleteBuilder({
        handle,
        dialect,
        executor: clientExecutor,
        mapper,
        allowAll: false,
        returning: { kind: 'all' },
      }) as DeleteBuilder<THandle, InferSelect<THandle>>
    }

    const migrate = (): MigrateBuilder => {
      ensureClientOpen()
      return createMigrateBuilder({
        schemas,
        dialect,
        executor: clientExecutor,
        assertCanExecute() {
          if (transactionScope || transactionActive) {
            throw new MigrationError({
              message: 'Cannot execute migrations inside a transaction',
            })
          }
        },
      })
    }

    const transaction = async <T>(fn: (trx: Db<TSchemas>) => Promise<T>): Promise<T> => {
      ensureClientOpen()

      if (!transactionScope) {
        return schedule(async () => {
          ensureOpen()
          if (rootClientBlocked) {
            throw new QueryError({
              message:
                'Cannot start a nested transaction on the root client inside a transaction callback; use the transaction client (trx) instead',
            })
          }
          await baseExecutor.run({ sql: 'begin', params: [] })
          transactionActive = true
          rootClientBlocked = true
          const scope: TransactionScope = {
            active: true,
            context: { nextSavepointId: 1 },
          }
          try {
            const result = await fn(createClient(baseExecutor, scope))
            scope.active = false
            rootClientBlocked = false
            await baseExecutor.run({ sql: 'commit', params: [] })
            transactionActive = false
            return result
          } catch (error) {
            scope.active = false
            rootClientBlocked = false
            try {
              await baseExecutor.run({ sql: 'rollback', params: [] })
            } catch {
              // ignore rollback failures; rethrow original
            } finally {
              transactionActive = false
            }
            throw error
          }
        })
      }

      const savepointName = `sp_${transactionScope.context.nextSavepointId++}`
      await clientExecutor.run({ sql: `savepoint ${savepointName}`, params: [] })
      const nestedScope: TransactionScope = {
        active: true,
        context: transactionScope.context,
      }
      try {
        const result = await fn(createClient(baseExecutor, nestedScope))
        nestedScope.active = false
        await clientExecutor.run({
          sql: `release savepoint ${savepointName}`,
          params: [],
        })
        return result
      } catch (error) {
        nestedScope.active = false
        try {
          await clientExecutor.run({
            sql: `rollback to savepoint ${savepointName}`,
            params: [],
          })
          await clientExecutor.run({
            sql: `release savepoint ${savepointName}`,
            params: [],
          })
        } catch {
          // ignore rollback failures; rethrow original
        }
        throw error
      }
    }

    const closeClient = async (): Promise<void> => {
      if (transactionScope) {
        ensureClientOpen()
        throw new QueryError({ message: 'Transaction clients cannot close the database' })
      }
      await close()
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
      close: closeClient,
      [Symbol.asyncDispose]: closeClient,
    }
  }

  return createClient(rootExecutor)
}
