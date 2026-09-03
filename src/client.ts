import type { Connector } from 'db0'
import { AsyncLocalStorage } from 'node:async_hooks'

import type { MigrateBuilder } from '@/ddl'
import { createMigrateBuilder } from '@/ddl'
import { isTableHandle } from '@/defineTable'
import { resolveDialect } from '@/dialects'
import type {
  NamespaceIdentifierInput,
  RelationIdentityInput,
} from '@/migrations/canonicalRelationIdentity'
import { validateApplicationId } from '@/migrations/coordinationScope'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import type { OperationContext } from '@/operations/coordinator'
import { OperationCoordinator } from '@/operations/coordinator'
import type { OperationSessionProvider } from '@/operations/operationSession'
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
import { MigrationError, QueryError, SchemaError, attempt } from '@/utils/error'

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

/**
 * Checks whether one transaction scope is nested beneath another.
 *
 * @param candidate - Scope that may be a descendant.
 * @param ancestor - Potential ancestor scope.
 */
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

/** Creates the error reported after failed savepoint cleanup poisons a transaction. */
function transactionPoisonedError(): QueryError {
  return new QueryError({
    message: 'Transaction is no longer usable after savepoint cleanup failed',
  })
}

/**
 * Queues work on a transaction scope while enforcing scope ownership.
 *
 * @param scope - Transaction scope that owns the operation.
 * @param operation - Asynchronous work to schedule.
 */
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

/**
 * Waits until all work queued on a transaction scope has settled.
 *
 * @param scope - Transaction scope to drain.
 */
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
  /** Optional explicit migration authority beyond exact complete registered relations. */
  migrationOwnership?: readonly MigrationOwnershipDeclaration[]
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
 * Formats a structured authored relation for diagnostics.
 *
 * @param relation - Structured authored relation intent.
 */
function formatAuthoredRelation(relation: RelationIdentityInput): string {
  const segments =
    relation.namespace?.map(
      ({ role, spelling }) => `${role}:${JSON.stringify(spelling)}`,
    ) ?? []
  segments.push(`relation:${JSON.stringify(relation.relation)}`)
  return `[${segments.join(', ')}]`
}

/** Exact authored relation key used before dialect/session resolution. */
function authoredRelationKey(info: ReturnType<TableHandle['getTableMetadata']>): string {
  return JSON.stringify([
    info.relation.namespace?.map((segment) => [segment.role, segment.spelling]),
    info.relation.relation,
  ])
}

/**
 * Asserts that all schemas are valid table handles with unique keys.
 *
 * @example
 *   assertHandles([User, Post])
 *
 * @param schemas - Array of table handles to validate.
 *
 * @throws SchemaError - When a value is not a table handle or keys are duplicated.
 */
function assertHandles(schemas: readonly TableHandle[]): void {
  const seen = new Set<string>()

  for (const schema of schemas) {
    if (!isTableHandle(schema)) {
      throw new SchemaError({
        message: 'createDatabase schemas must be table handles from defineTable()',
      })
    }

    const info = schema.getTableMetadata()
    const key = authoredRelationKey(info)

    if (seen.has(key)) {
      throw new SchemaError({
        message: `duplicate table registration for ${formatAuthoredRelation(info.relation)}`,
      })
    }

    seen.add(key)
  }
}

/**
 * Creates a Stratom client from a db0 connector and table handles.
 *
 * @example
 *   import { postgresql } from 'db0/connectors/postgresql'
 *
 *   const db = createDatabase({
 *     connector: postgresql({ url: process.env.DATABASE_URL! }),
 *     schemas: [User],
 *   })
 *   await db.transaction(async (trx) => {
 *     await trx.insert(User).values({ name: 'Alice' }).execute()
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
  const registry = new Map<string, TableHandle>()

  for (const handle of schemas) {
    const info = handle.getTableMetadata()
    registry.set(authoredRelationKey(info), handle)
  }

  /**
   * Checks whether a table handle's authored relation is registered.
   *
   * @param handle - Table handle to check.
   */
  const isRegistered = (handle: TableHandle): boolean => {
    const info = handle.getTableMetadata()
    return registry.has(authoredRelationKey(info))
  }

  const operationSessionProvider =
    config.operationSessionProvider ??
    dialect.operations.createSessionProvider(config.connector)
  const coordinator = new OperationCoordinator(operationSessionProvider)
  const query = dialect.query.resolve(schemas)
  const mapper = createValueMapper(dialect, config.map, schemas, query)
  let closed = false
  let closePromise: Promise<void> | undefined

  /** Asserts that the root database client remains open. */
  const ensureOpen = () => {
    if (closed) {
      throw new QueryError({ message: 'Database has been closed' })
    }
  }

  const rootExecutor: Executor = {
    /**
     * Executes a row-returning query through the operation coordinator.
     *
     * @param query - Compiled query to execute.
     */
    execute(compiled) {
      ensureOpen()
      return coordinator.run(({ executor, identity }) => {
        compiled.assertSession?.(identity)
        return executor.execute(compiled)
      })
    },
    /**
     * Runs a statement through the operation coordinator.
     *
     * @param query - Compiled statement to run.
     */
    run(compiled) {
      ensureOpen()
      return coordinator.run(({ executor, identity }) => {
        compiled.assertSession?.(identity)
        return executor.run(compiled)
      })
    },
  }

  /** Closes the root database client and its operation coordinator. */
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

  /**
   * Creates a root or transaction-scoped database client.
   *
   * @param executor - Executor backing the client.
   * @param transactionScope - Optional transaction scope for the client.
   */
  const createClient = (
    executor: Executor,
    transactionScope?: TransactionScope,
  ): Db<TSchemas> => {
    /** Asserts that this root or transaction-scoped client remains open. */
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
          /**
           * Executes a row-returning query in the transaction queue.
           *
           * @param query - Compiled query to execute.
           */
          execute(compiled) {
            ensureClientOpen()
            return scheduleTransactionScope(transactionScope, () => {
              compiled.assertSession?.(transactionScope.operation.identity)
              return executor.execute(compiled)
            })
          },
          /**
           * Runs a statement in the transaction queue.
           *
           * @param query - Compiled statement to run.
           */
          run(compiled) {
            ensureClientOpen()
            return scheduleTransactionScope(transactionScope, () => {
              compiled.assertSession?.(transactionScope.operation.identity)
              return executor.run(compiled)
            })
          },
        }
      : executor

    /**
     * Checks database connectivity with a trivial query.
     *
     * @example
     *   await db.ping()
     */
    const ping = async (): Promise<void> => {
      ensureClientOpen()

      try {
        await clientExecutor.execute(dialect.operations.compile({ kind: 'ping' }))
      } catch (cause) {
        if (cause instanceof QueryError) throw cause
        throw new QueryError({
          message: cause instanceof Error ? cause.message : 'Connectivity check failed',
          cause,
        })
      }
    }

    /**
     * Starts a query rooted on a registered table.
     *
     * @example
     *   const query = db.from(User)
     *
     * @param handle - Registered table handle to query.
     */
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
          message: `table ${formatAuthoredRelation(info.relation)} is not registered on this client; pass it in createDatabase({ schemas })`,
        })
      }

      return createTableBuilder({
        handle,
        dialect,
        query,
        executor: clientExecutor,
        mapper,
      })
    }

    /**
     * Starts an insert into a registered table.
     *
     * @example
     *   await db.insert(User).values({ name: 'Alice' }).execute()
     *
     * @param handle - Registered table handle to insert into.
     */
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
          message: `table ${formatAuthoredRelation(info.relation)} is not registered on this client; pass it in createDatabase({ schemas })`,
        })
      }

      return {
        /**
         * Supplies one or more rows for the insert.
         *
         * @example
         *   const rows = [{ name: 'Alice' }, { name: 'Bob' }]
         *   await db.insert(User).values(rows).execute()
         *
         * @param rowOrRows - Insert row or non-empty array of rows.
         */
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
            query,
            executor: clientExecutor,
            mapper,
            rows: validated,
            returning: { kind: 'all' },
          }) as InsertBuilder<THandle, InferSelect<THandle>>
        },
      }
    }

    /**
     * Asserts that a method received a registered table handle.
     *
     * @param handle - Table handle to validate.
     * @param method - Database method name used in diagnostics.
     */
    const validateHandle = (handle: TableHandle, method: string) => {
      if (!isTableHandle(handle)) {
        throw new SchemaError({
          message: `db.${method}() expects a table handle from defineTable()`,
        })
      }

      const info = handle.getTableMetadata()

      if (!isRegistered(handle)) {
        throw new SchemaError({
          message: `table ${formatAuthoredRelation(info.relation)} is not registered on this client; pass it in createDatabase({ schemas })`,
        })
      }
    }

    /**
     * Starts an update of a registered table.
     *
     * @example
     *   await db.update(User).set({ name: 'Bob' }).where(User.id, 'eq', 1).execute()
     *
     * @param handle - Registered table handle to update.
     */
    const update = <THandle extends TableHandle>(
      handle: THandle,
    ): UpdateSetBuilder<THandle> => {
      ensureClientOpen()
      validateHandle(handle, 'update')
      return {
        /**
         * Supplies the column patch for the update.
         *
         * @example
         *   await db.update(User).set({ name: 'Bob' }).where(User.id, 'eq', 1).execute()
         *
         * @param patch - Non-empty patch of updatable columns.
         */
        set: (patch) => {
          const validated = validateUpdatePatch(handle, patch)
          return createUpdateBuilder({
            handle,
            dialect,
            query,
            executor: clientExecutor,
            mapper,
            patch: validated,
            allowAll: false,
            returning: { kind: 'all' },
          }) as UpdateBuilder<THandle, InferSelect<THandle>>
        },
      }
    }

    /**
     * Starts a delete from a registered table.
     *
     * @example
     *   await db.delete(User).where(User.id, 'eq', 1).execute()
     *
     * @param handle - Registered table handle to delete from.
     */
    const delete_ = <THandle extends TableHandle>(
      handle: THandle,
    ): DeleteBuilder<THandle, InferSelect<THandle>> => {
      ensureClientOpen()
      validateHandle(handle, 'delete')
      return createDeleteBuilder({
        handle,
        dialect,
        query,
        executor: clientExecutor,
        mapper,
        allowAll: false,
        returning: { kind: 'all' },
      }) as DeleteBuilder<THandle, InferSelect<THandle>>
    }

    /**
     * Creates a desired-state migration builder for the registered tables.
     *
     * @example
     *   const plan = await db.migrate().dryRun()
     */
    const migrate = (): MigrateBuilder => {
      ensureClientOpen()
      return createMigrateBuilder({
        schemas,
        migration: dialect.migration,
        /**
         * Runs migration work in the current transaction scope or a root operation.
         *
         * @param operation - Migration operation to execute with session context.
         */
        runOperation: async (operation) => {
          if (transactionScope) {
            ensureClientOpen()
            return operation(
              clientExecutor,
              transactionScope.operation.identity.database,
              transactionScope.operation.discard,
              transactionScope.operation.cancel,
            )
          }

          ensureOpen()
          return coordinator.run(({ executor, identity, discard, cancel }) =>
            operation(executor, identity.database, discard, cancel),
          )
        },
        ...(config.applicationId === undefined
          ? {}
          : { applicationId: config.applicationId }),
        ...(config.defaultNamespace === undefined
          ? {}
          : { defaultNamespace: config.defaultNamespace }),
        ...(config.migrationOwnership === undefined
          ? {}
          : { migrationOwnership: config.migrationOwnership }),
        /** Prevents migration execution from inside a transaction client. */
        assertCanExecute() {
          if (transactionScope) {
            throw new MigrationError({
              message: 'Cannot execute migrations inside a transaction',
            })
          }
        },
      })
    }

    /**
     * Runs a callback in a transaction or nested savepoint.
     *
     * @example
     *   await db.transaction(async (trx) => {
     *     await trx.insert(User).values({ name: 'Alice' }).execute()
     *   })
     *
     * @param fn - Callback receiving the transaction-scoped client.
     */
    const transaction = async <T>(fn: (trx: Db<TSchemas>) => Promise<T>): Promise<T> => {
      ensureClientOpen()
      const inheritedTransactionFrame = activeTransactionScope.getStore()

      if (!transactionScope) {
        return coordinator.run(async (operation) => {
          await operation.executor.run(dialect.operations.compile({ kind: 'begin' }))
          const scope: TransactionScope = {
            active: true,
            context: { nextSavepointId: 1, poisoned: false },
            operation,
            parent: undefined,
            queue: Promise.resolve(),
          }

          try {
            const callback = await attempt(() =>
              activeTransactionScope.run(
                { scope, parent: inheritedTransactionFrame },
                () => fn(createClient(operation.executor, scope)),
              ),
            )
            await drainTransactionScope(scope)
            if (!callback.ok) throw callback.error
            if (scope.context.poisoned) throw transactionPoisonedError()
            scope.active = false
            await operation.executor.run(dialect.operations.compile({ kind: 'commit' }))
            return callback.value
          } catch (error) {
            scope.active = false
            const rollback = await attempt(() =>
              operation.executor.run(dialect.operations.compile({ kind: 'rollback' })),
            )
            if (!rollback.ok) operation.discard()
            throw error
          }
        })
      }

      return scheduleTransactionScope(transactionScope, async () => {
        const rawExecutor = transactionScope.operation.executor
        const savepointId = transactionScope.context.nextSavepointId++

        try {
          await rawExecutor.run(
            dialect.operations.compile({ kind: 'createSavepoint', id: savepointId }),
          )
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
            await rawExecutor.run(
              dialect.operations.compile({
                kind: 'rollbackToSavepoint',
                id: savepointId,
              }),
            )
          } catch {
            transactionScope.context.poisoned = true
            transactionScope.operation.discard()
            throw callbackError
          }

          try {
            await rawExecutor.run(
              dialect.operations.compile({ kind: 'releaseSavepoint', id: savepointId }),
            )
          } catch {
            transactionScope.context.poisoned = true
            transactionScope.operation.discard()
            throw callbackError
          }

          throw callbackError
        }

        if (transactionScope.context.poisoned) throw transactionPoisonedError()

        try {
          await rawExecutor.run(
            dialect.operations.compile({ kind: 'releaseSavepoint', id: savepointId }),
          )
        } catch (error) {
          transactionScope.context.poisoned = true
          transactionScope.operation.discard()
          throw error
        }

        return result as T
      })
    }

    /**
     * Closes a root client and rejects attempts to close transaction clients.
     *
     * @example
     *   await db.close()
     */
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
