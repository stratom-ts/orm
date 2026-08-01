import type { Connector } from 'db0'
import { AsyncLocalStorage } from 'node:async_hooks'

import type { MigrateBuilder } from '@/ddl'
import { createMigrateBuilder } from '@/ddl'
import { isTableHandle } from '@/defineTable'
import { resolveDialect } from '@/dialects'
import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import { validateApplicationId } from '@/migrations/coordinationScope'
import type { OperationContext } from '@/operations/coordinator'
import { OperationCoordinator } from '@/operations/coordinator'
import type { OperationSessionProvider } from '@/operations/operationSession'
import { createDb0PostgresqlOperationSessionProvider } from '@/operations/operationSession'
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

export type { ValueMapConfig } from '@/query'
export type { TableHandle } from '@/types'

type TransactionContext = {
  nextSavepointId: number
  poisoned: boolean
}

type TransactionScope = {
  active: boolean
  context: TransactionContext
  operation: OperationContext
  parent: TransactionScope | undefined
  queue: Promise<void>
}

type TransactionScopeFrame = {
  readonly scope: TransactionScope
  readonly parent: TransactionScopeFrame | undefined
}

const activeTransactionScope = new AsyncLocalStorage<TransactionScopeFrame>()

function isDescendantScope(
  candidate: TransactionScope,
  ancestor: TransactionScope,
): boolean {
  let scope: TransactionScope | undefined = candidate.parent
  while (scope) {
    if (scope === ancestor) return true
    scope = scope.parent
  }
  return false
}

function transactionPoisonedError(): QueryError {
  return new QueryError({
    message: 'Transaction is no longer usable after savepoint cleanup failed',
  })
}

function scheduleTransactionScope<T>(
  scope: TransactionScope,
  operation: () => Promise<T>,
): Promise<T> {
  let frame = activeTransactionScope.getStore()
  while (frame) {
    if (
      frame.scope.active &&
      frame.scope !== scope &&
      isDescendantScope(frame.scope, scope)
    ) {
      return Promise.reject(
        new QueryError({
          message:
            'Cannot use an ancestor transaction client inside a nested transaction callback; use the nested callback client instead',
        }),
      )
    }
    frame = frame.parent
  }
  if (!scope.active) {
    return Promise.reject(
      new QueryError({ message: 'Transaction client is no longer active' }),
    )
  }

  const previous = scope.queue
  let finish!: () => void
  scope.queue = new Promise<void>((resolve) => {
    finish = resolve
  })

  return (async () => {
    await previous
    try {
      if (!scope.active) {
        throw new QueryError({ message: 'Transaction client is no longer active' })
      }
      if (scope.context.poisoned) throw transactionPoisonedError()
      return await operation()
    } finally {
      finish()
    }
  })()
}

async function drainTransactionScope(scope: TransactionScope): Promise<void> {
  while (true) {
    const tail = scope.queue
    await tail
    if (scope.queue === tail) return
  }
}

/** Options for {@link createDatabase}. */
export type CreateDatabaseConfig<
  TSchemas extends readonly TableHandle[] = readonly TableHandle[],
> = {
  /** Db0 connector (e.g. postgresql from `db0/connectors/postgresql`). */
  connector: Connector
  /** Registered table handles; may be empty. */
  schemas: TSchemas
  /** Explicit default namespace for migration registrations with omitted namespaces. */
  defaultNamespace?: readonly NamespaceIdentifierInput[]
  /** Explicit provider for a custom connector. It owns its sessions and shutdown. */
  operationSessionProvider?: OperationSessionProvider
  /** Stable application identity for future application-scoped migration coordination. */
  applicationId?: string
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
  /** Registered table handles from `createDatabase`. */
  readonly schemas: TSchemas
  /** Trivial connectivity check (`SELECT 1` via the owned db0 instance). */
  ping(): Promise<void>
  /** Start a query rooted on a registered table handle. */
  from<THandle extends TableHandle>(handle: THandle): QueryBuilder<THandle>
  /**
   * Insert rows into a registered table.
   *
   * @example
   *   await db.insert(User).values({ name: 'Alice' }).executeTakeFirstOrThrow()
   */
  insert<THandle extends TableHandle>(handle: THandle): InsertValuesBuilder<THandle>
  /**
   * Update rows in a registered table.
   *
   * @example
   *   await db.update(User).set({ name: 'Bob' }).where(User.id, 'eq', 1).execute()
   */
  update<THandle extends TableHandle>(handle: THandle): UpdateSetBuilder<THandle>
  /**
   * Delete rows from a registered table.
   * Returns all deleted rows by default.
   *
   * @example
   *   const deleted = await db
   *     .delete(User)
   *     .where(User.id, 'eq', 1)
   *     .executeTakeFirstOrThrow()
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

/**
 * Asserts that all schemas are valid table handles with unique keys.
 *
 * @example
 *   assertHandles([User, Post])
 *
 * @param schemas - Array of table handles to validate.
 *
 * @throws SchemaError - When a value is not a table handle or keys are duplicated
 */
function formatAuthoredRelation(schema: string | undefined, relation: string): string {
  return schema === undefined
    ? JSON.stringify(relation)
    : `${JSON.stringify(schema)}.${JSON.stringify(relation)}`
}

function assertHandles(schemas: readonly TableHandle[]): void {
  const seen = new Map<string | undefined, Set<string>>()
  for (const schema of schemas) {
    if (!isTableHandle(schema)) {
      throw new SchemaError({
        message: 'createDatabase schemas must be table handles from defineTable()',
      })
    }
    const info = schema.getTableMetadata()
    let relations = seen.get(info.schema)
    if (!relations) {
      relations = new Set()
      seen.set(info.schema, relations)
    }
    if (relations.has(info.name)) {
      throw new SchemaError({
        message: `duplicate table registration for ${formatAuthoredRelation(info.schema, info.name)}`,
      })
    }
    relations.add(info.name)
  }
}

/**
 * Creates a Stratom client from a db0 connector and table handles.
 *
 * @example
 *   import { postgresql } from 'db0/connectors/postgresql'
 *
 *   const db = createDatabase({
 *   connector: postgresql({ url: process.env.DATABASE_URL! }),
 *   schemas: [User],
 *   })
 *   await db.transaction(async (trx) => {
 *   await trx.insert(User).values({ ... }).execute()
 *   })
 *   await db.close()
 *
 * @param config - Connector and registered schemas.
 *
 * @returns Client with `schemas`, `from`, `insert`, `update`, `delete`, `migrate`,
 *   `transaction`, `ping`, and `close`
 */
export function createDatabase<
  const TSchemas extends readonly TableHandle[] = readonly TableHandle[],
>(config: CreateDatabaseConfig<TSchemas>): Db<TSchemas> {
  assertHandles(config.schemas)
  if (config.applicationId !== undefined) validateApplicationId(config.applicationId)

  const dialect = resolveDialect(config.connector.dialect)
  const schemas = config.schemas
  const registry = new Map<string | undefined, Map<string, TableHandle>>()
  for (const handle of schemas) {
    const info = handle.getTableMetadata()
    let relations = registry.get(info.schema)
    if (!relations) {
      relations = new Map()
      registry.set(info.schema, relations)
    }
    relations.set(info.name, handle)
  }

  const isRegistered = (handle: TableHandle): boolean => {
    const info = handle.getTableMetadata()
    return registry.get(info.schema)?.has(info.name) ?? false
  }

  const operationSessionProvider =
    config.operationSessionProvider ??
    createDb0PostgresqlOperationSessionProvider(config.connector)
  const coordinator = new OperationCoordinator(operationSessionProvider)
  const mapper = createValueMapper(dialect, config.map)
  let closed = false
  let closePromise: Promise<void> | undefined

  const ensureOpen = () => {
    if (closed) {
      throw new QueryError({ message: 'Database has been closed' })
    }
  }

  const rootExecutor: Executor = {
    execute(query) {
      ensureOpen()
      return coordinator.run(({ executor }) => executor.execute(query))
    },
    run(query) {
      ensureOpen()
      return coordinator.run(({ executor }) => executor.run(query))
    },
  }

  const close = (): Promise<void> => {
    if (coordinator.currentToken()) {
      return Promise.reject(
        new QueryError({
          message:
            'Cannot close the root database client inside an active operation callback',
        }),
      )
    }
    if (closePromise) return closePromise
    closed = true
    return (closePromise = coordinator.close())
  }

  const createClient = (
    executor: Executor,
    transactionScope?: TransactionScope,
  ): Db<TSchemas> => {
    const ensureClientOpen = () => {
      if (transactionScope) {
        if (!transactionScope.active) {
          throw new QueryError({ message: 'Transaction client is no longer active' })
        }
      } else {
        ensureOpen()
      }
    }

    const clientExecutor: Executor = transactionScope
      ? {
          execute(query) {
            ensureClientOpen()
            return scheduleTransactionScope(transactionScope, () =>
              executor.execute(query),
            )
          },
          run(query) {
            ensureClientOpen()
            return scheduleTransactionScope(transactionScope, () => executor.run(query))
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
      if (!isRegistered(handle)) {
        throw new SchemaError({
          message: `table ${formatAuthoredRelation(info.schema, info.name)} is not registered on this client; pass it in createDatabase({ schemas })`,
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
      if (!isRegistered(handle)) {
        throw new SchemaError({
          message: `table ${formatAuthoredRelation(info.schema, info.name)} is not registered on this client; pass it in createDatabase({ schemas })`,
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
      if (!isRegistered(handle)) {
        throw new SchemaError({
          message: `table ${formatAuthoredRelation(info.schema, info.name)} is not registered on this client; pass it in createDatabase({ schemas })`,
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
        runOperation: async (operation) => {
          if (transactionScope) {
            ensureClientOpen()
            return operation(
              clientExecutor,
              transactionScope.operation.identity.database,
              transactionScope.operation.discard,
            )
          }
          ensureOpen()
          return coordinator.run(({ executor, identity, discard }) =>
            operation(executor, identity.database, discard),
          )
        },
        ...(config.applicationId === undefined
          ? {}
          : { applicationId: config.applicationId }),
        ...(config.defaultNamespace === undefined
          ? {}
          : { defaultNamespace: config.defaultNamespace }),
        assertCanExecute() {
          if (transactionScope) {
            throw new MigrationError({
              message: 'Cannot execute migrations inside a transaction',
            })
          }
        },
      })
    }

    const transaction = async <T>(fn: (trx: Db<TSchemas>) => Promise<T>): Promise<T> => {
      ensureClientOpen()
      const inheritedTransactionFrame = activeTransactionScope.getStore()

      if (!transactionScope) {
        return coordinator.run(async (operation) => {
          await operation.executor.run({ sql: 'begin', params: [] })
          const scope: TransactionScope = {
            active: true,
            context: { nextSavepointId: 1, poisoned: false },
            operation,
            parent: undefined,
            queue: Promise.resolve(),
          }
          try {
            let callbackFailed = false
            let callbackError: unknown
            let result: T | undefined
            try {
              result = await activeTransactionScope.run(
                { scope, parent: inheritedTransactionFrame },
                () => fn(createClient(operation.executor, scope)),
              )
            } catch (cause) {
              callbackFailed = true
              callbackError = cause
            }
            await drainTransactionScope(scope)
            if (callbackFailed) throw callbackError
            if (scope.context.poisoned) throw transactionPoisonedError()
            scope.active = false
            await operation.executor.run({ sql: 'commit', params: [] })
            return result as T
          } catch (error) {
            scope.active = false
            try {
              await operation.executor.run({ sql: 'rollback', params: [] })
            } catch {
              operation.discard()
            }
            throw error
          }
        })
      }

      return scheduleTransactionScope(transactionScope, async () => {
        const rawExecutor = transactionScope.operation.executor
        const savepointName = `sp_${transactionScope.context.nextSavepointId++}`
        try {
          await rawExecutor.run({ sql: `savepoint ${savepointName}`, params: [] })
        } catch (error) {
          transactionScope.context.poisoned = true
          transactionScope.operation.discard()
          throw error
        }
        const nestedScope: TransactionScope = {
          active: true,
          context: transactionScope.context,
          operation: transactionScope.operation,
          parent: transactionScope,
          queue: Promise.resolve(),
        }
        let callbackFailed = false
        let callbackError: unknown
        let result: T | undefined
        try {
          result = await activeTransactionScope.run(
            { scope: nestedScope, parent: inheritedTransactionFrame },
            () => fn(createClient(rawExecutor, nestedScope)),
          )
        } catch (cause) {
          callbackFailed = true
          callbackError = cause
        }
        await drainTransactionScope(nestedScope)
        nestedScope.active = false

        if (callbackFailed) {
          if (transactionScope.context.poisoned) throw callbackError
          try {
            await rawExecutor.run({
              sql: `rollback to savepoint ${savepointName}`,
              params: [],
            })
          } catch {
            transactionScope.context.poisoned = true
            transactionScope.operation.discard()
            throw callbackError
          }
          try {
            await rawExecutor.run({
              sql: `release savepoint ${savepointName}`,
              params: [],
            })
          } catch {
            transactionScope.context.poisoned = true
            transactionScope.operation.discard()
            throw callbackError
          }
          throw callbackError
        }

        if (transactionScope.context.poisoned) throw transactionPoisonedError()
        try {
          await rawExecutor.run({
            sql: `release savepoint ${savepointName}`,
            params: [],
          })
        } catch (error) {
          transactionScope.context.poisoned = true
          transactionScope.operation.discard()
          throw error
        }
        return result as T
      })
    }

    const closeClient = (): Promise<void> => {
      if (transactionScope) {
        try {
          ensureClientOpen()
        } catch (cause) {
          return Promise.reject(cause)
        }
        return Promise.reject(
          new QueryError({ message: 'Transaction clients cannot close the database' }),
        )
      }
      return close()
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
