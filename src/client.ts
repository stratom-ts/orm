import type { Connector } from 'db0'
import { AsyncLocalStorage } from 'node:async_hooks'

import type { MigrateBuilder } from '@/ddl'
import { createMigrateBuilder } from '@/ddl'
import { isTableHandle } from '@/defineTable'
import type { DialectOperations } from '@/dialects'
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
  const ownershipError = transactionScopeOwnershipError(scope)

  if (ownershipError) return Promise.reject(ownershipError)

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
  for (;;) {
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
  /** Closes the database client when its asynchronous disposal scope exits. */
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

/** Runs a root transaction and retains the callback failure during rollback. */
async function runRootTransaction<T>(
  coordinator: OperationCoordinator,
  operations: DialectOperations,
  inheritedTransactionFrame: TransactionScopeFrame | undefined,
  fn: (scope: TransactionScope) => Promise<T>,
): Promise<T> {
  return coordinator.run(async (operation) => {
    await operation.executor.run(operations.compile({ kind: 'begin' }))
    const scope: TransactionScope = {
      active: true,
      context: { nextSavepointId: 1, poisoned: false },
      operation,
      parent: undefined,
      queue: Promise.resolve(),
    }

    try {
      const callback = await attempt(() =>
        activeTransactionScope.run({ scope, parent: inheritedTransactionFrame }, () =>
          fn(scope),
        ),
      )
      await drainTransactionScope(scope)

      if (!callback.ok) throw callback.error
      if (scope.context.poisoned) throw transactionPoisonedError()

      scope.active = false
      await operation.executor.run(operations.compile({ kind: 'commit' }))
      return callback.value
    } catch (error) {
      scope.active = false
      const rollback = await attempt(() =>
        operation.executor.run(operations.compile({ kind: 'rollback' })),
      )

      if (!rollback.ok) operation.discard()

      throw error
    }
  })
}

/** Runs a nested transaction with savepoint cleanup and queue ownership. */
async function runNestedTransaction<T>(
  transactionScope: TransactionScope,
  operations: DialectOperations,
  inheritedTransactionFrame: TransactionScopeFrame | undefined,
  fn: (scope: TransactionScope) => Promise<T>,
): Promise<T> {
  return scheduleTransactionScope(transactionScope, async () => {
    const savepointId = transactionScope.context.nextSavepointId++

    await executeSavepoint(transactionScope, operations, 'createSavepoint', savepointId)

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
        () => fn(nestedScope),
      )
    } catch (cause) {
      callbackFailed = true
      callbackError = cause
    }

    await drainTransactionScope(nestedScope)
    nestedScope.active = false

    if (callbackFailed)
      await rollbackNestedTransaction(
        transactionScope,
        operations,
        savepointId,
        callbackError,
      )

    if (transactionScope.context.poisoned) throw transactionPoisonedError()

    await executeSavepoint(transactionScope, operations, 'releaseSavepoint', savepointId)

    return result as T
  })
}

type ClientQueryContext = Omit<Parameters<typeof createTableBuilder>[0], 'handle'> & {
  ensureClientOpen: () => void
  isRegistered: (handle: TableHandle) => boolean
}

/** Creates the query and insert entry points for a database client. */
function createReadInsertMethods(context: ClientQueryContext) {
  return {
    /** Starts a read query for a registered table handle. */
    from: <THandle extends TableHandle>(handle: THandle) => queryFrom(handle, context),
    /** Starts an insert operation for a registered table handle. */
    insert: <THandle extends TableHandle>(handle: THandle) => insertInto(handle, context),
  }
}

/** Creates the update and delete entry points for a database client. */
function createUpdateDeleteMethods(context: ClientQueryContext) {
  return {
    /** Starts an update operation for a registered table handle. */
    update: <THandle extends TableHandle>(handle: THandle) =>
      updateTable(handle, context),
    /** Starts a delete operation for a registered table handle. */
    delete: <THandle extends TableHandle>(handle: THandle) => deleteFrom(handle, context),
  }
}

/** Binds executor calls to the transaction queue when the client owns a scope. */
function createClientExecutor(
  executor: Executor,
  transactionScope: TransactionScope | undefined,
  ensureClientOpen: () => void,
): Executor {
  return transactionScope
    ? {
        /**
         * Executes a row-returning query in the transaction queue.
         *
         * @param compiled - Compiled SQL, bound parameters, and optional session
         *   preconditions.
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
         * @param compiled - Compiled SQL, bound parameters, and optional session
         *   preconditions.
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
}

/**
 * Checks database connectivity with a trivial query.
 *
 * @example
 *   await db.ping()
 */
async function pingClient(
  clientExecutor: Executor,
  operations: DialectOperations,
  ensureClientOpen: () => void,
): Promise<void> {
  ensureClientOpen()

  try {
    await clientExecutor.execute(operations.compile({ kind: 'ping' }))
  } catch (cause) {
    if (cause instanceof QueryError) throw cause

    throw new QueryError({
      message: cause instanceof Error ? cause.message : 'Connectivity check failed',
      cause,
    })
  }
}

/** Checks registration by exact authored relation identity. */
function createRegistrationCheck(schemas: readonly TableHandle[]) {
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

  return isRegistered
}

/**
 * Creates a desired-state migration builder for the registered tables.
 *
 * @example
 *   const plan = await db.migrate().plan()
 *   const preview = await db.migrate().dryRun()
 */
function createClientMigration(
  config: CreateDatabaseConfig,
  dialect: ReturnType<typeof resolveDialect>,
  coordinator: OperationCoordinator,
  clientExecutor: Executor,
  ensureClientOpen: () => void,
  ensureOpen: () => void,
  transactionScope?: TransactionScope,
): MigrateBuilder {
  ensureClientOpen()
  return createMigrateBuilder({
    schemas: config.schemas,
    migration: dialect.migration,
    runOperation: createMigrationRunner(
      coordinator,
      clientExecutor,
      ensureClientOpen,
      ensureOpen,
      transactionScope,
    ),
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

/** Owns root client execution and shutdown through the operation coordinator. */
function createDatabaseLifecycle(coordinator: OperationCoordinator) {
  let closed = false
  let closePromise: Promise<void> | undefined

  /** Asserts that the root database client remains open. */
  const ensureOpen = () => {
    if (closed) {
      throw new QueryError({ message: 'Database has been closed' })
    }
  }

  const rootExecutor = createRootExecutor(coordinator, ensureOpen)

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

  return { ensureOpen, rootExecutor, close }
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
  const context = createDatabaseContext(config)

  /**
   * Creates a root or transaction-scoped database client.
   *
   * @param executor - Executor backing the client.
   * @param transactionScope - Optional transaction scope for the client.
   */
  const createClient = (
    executor: Executor,
    transactionScope?: TransactionScope,
  ): Db<TSchemas> => createScopedClient(context, executor, transactionScope, createClient)

  return createClient(context.rootExecutor)
}

/** Rejects work after client closure or transaction-scope expiration. */
function assertClientOpen(
  ensureOpen: () => void,
  transactionScope: TransactionScope | undefined,
): void {
  if (transactionScope) {
    if (!transactionScope.active) {
      throw new QueryError({ message: 'Transaction client is no longer active' })
    }
  } else {
    ensureOpen()
  }
}

/**
 * Closes a root client and rejects attempts to close transaction clients.
 *
 * @example
 *   await db.close()
 */

function closeClient(
  ensureClientOpen: () => void,
  close: () => Promise<void>,
  transactionScope: TransactionScope | undefined,
): Promise<void> {
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

/**
 * Builds a database client bound to its executor and transaction scope.
 *
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param transactionScope - Owning transaction queue and nested-scope lifecycle state.
 * @param createClient - Factory for a client bound to a supplied transaction executor.
 *
 * @returns A database client bound to its executor and transaction scope.
 */
function createScopedClient<TSchemas extends readonly TableHandle[]>(
  context: DatabaseClientContext<TSchemas>,
  executor: Executor,
  transactionScope: TransactionScope | undefined,
  createClient: (executor: Executor, transactionScope?: TransactionScope) => Db<TSchemas>,
): Db<TSchemas> {
  const { ensureOpen, dialect, close, schemas } = context

  /** Asserts that this root or transaction-scoped client remains open. */
  const ensureClientOpen = () => assertClientOpen(ensureOpen, transactionScope)

  const clientExecutor = createClientExecutor(
    executor,
    transactionScope,
    ensureClientOpen,
  )

  /** Checks connectivity through the current operation executor. */
  const ping = () => pingClient(clientExecutor, dialect.operations, ensureClientOpen)

  const queryContext = { ...context, executor: clientExecutor, ensureClientOpen }
  const { from, insert } = createReadInsertMethods(queryContext)

  const { update, delete: delete_ } = createUpdateDeleteMethods(queryContext)

  /** Creates migration operations for the registered desired schema. */
  const migrate = () =>
    createScopedMigration(context, clientExecutor, ensureClientOpen, transactionScope)
  /** Runs a transaction that commits on success and rolls back on failure. */
  const transaction = <T>(fn: (trx: Db<TSchemas>) => Promise<T>) =>
    runClientTransaction(fn, context, transactionScope, ensureClientOpen, createClient)

  /** Closes the root client; rejects transaction-scoped closure. */
  const closeScopedClient = () => closeClient(ensureClientOpen, close, transactionScope)

  return {
    schemas,
    ping,
    from,
    insert,
    update,
    delete: delete_,
    migrate,
    transaction,
    close: closeScopedClient,
    [Symbol.asyncDispose]: closeScopedClient,
  }
}

/**
 * Resolves the connector's dialect, registered handles, and value mapping once.
 *
 * @param config - Connector, registered schemas, and client options.
 *
 * @returns The connector's dialect, registered handles, and value mapping once.
 */
function createDatabaseContext<TSchemas extends readonly TableHandle[]>(
  config: CreateDatabaseConfig<TSchemas>,
) {
  assertHandles(config.schemas)

  if (config.applicationId !== undefined) validateApplicationId(config.applicationId)

  const dialect = resolveDialect(config.connector.dialect)
  const schemas = config.schemas
  const isRegistered = createRegistrationCheck(schemas)
  const operationSessionProvider =
    config.operationSessionProvider ??
    dialect.operations.createSessionProvider(config.connector)
  const coordinator = new OperationCoordinator(operationSessionProvider)
  const query = dialect.query.resolve(
    schemas,
    config.defaultNamespace === undefined
      ? undefined
      : { registrationDefault: config.defaultNamespace },
  )
  const mapper = createValueMapper(dialect, config.map, schemas, query)
  const { ensureOpen, rootExecutor, close } = createDatabaseLifecycle(coordinator)
  return {
    config,
    dialect,
    schemas,
    query,
    mapper,
    coordinator,
    ensureOpen,
    close,
    isRegistered,
    rootExecutor,
  }
}

type DatabaseClientContext<TSchemas extends readonly TableHandle[]> = ReturnType<
  typeof createDatabaseContext<TSchemas>
>

/**
 * Selects a root transaction or nested savepoint while preserving scope ownership.
 *
 * @param fn - Work to run inside the transaction.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 * @param transactionScope - Owning transaction queue and nested-scope lifecycle state.
 * @param ensureClientOpen - Guard that rejects closed or expired client scopes.
 * @param createClient - Factory for a client bound to a supplied transaction executor.
 *
 * @returns The callback value after its root transaction or nested savepoint completes.
 */
async function runClientTransaction<TSchemas extends readonly TableHandle[], T>(
  fn: (trx: Db<TSchemas>) => Promise<T>,
  context: DatabaseClientContext<TSchemas>,
  transactionScope: TransactionScope | undefined,
  ensureClientOpen: () => void,
  createClient: (executor: Executor, transactionScope?: TransactionScope) => Db<TSchemas>,
): Promise<T> {
  const { coordinator, dialect } = context
  ensureClientOpen()
  const inheritedTransactionFrame = activeTransactionScope.getStore()

  if (!transactionScope) {
    return runRootTransaction(
      coordinator,
      dialect.operations,
      inheritedTransactionFrame,
      (scope) => fn(createClient(scope.operation.executor, scope)),
    )
  }

  return runNestedTransaction(
    transactionScope,
    dialect.operations,
    inheritedTransactionFrame,
    (scope) => fn(createClient(scope.operation.executor, scope)),
  )
}

/**
 * Creates a read builder after checking the handle's registration.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 *
 * @returns A table query builder with the client's execution and value-mapping context.
 */
function queryFrom<THandle extends TableHandle>(
  handle: THandle,
  context: ClientQueryContext,
): QueryBuilder<THandle> {
  const {
    dialect,
    query,
    mapper,
    executor: clientExecutor,
    ensureClientOpen,
    isRegistered,
  } = context
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
 * Creates an insert entry point with schema validation and value mapping.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 *
 * @returns An insert entry point using the registered handle's validation and value
 *   mapping.
 */
function insertInto<THandle extends TableHandle>(
  handle: THandle,
  context: ClientQueryContext,
): InsertValuesBuilder<THandle> {
  const {
    dialect,
    query,
    mapper,
    executor: clientExecutor,
    ensureClientOpen,
    isRegistered,
  } = context
  ensureClientOpen()

  const info = assertRegisteredHandle(handle, 'insert', isRegistered)

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
 * Rejects operations on handles absent from the client's registration.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param method - Public client method named in invalid-handle diagnostics.
 * @param isRegistered - Predicate checking whether the table handle belongs to this
 *   client.
 *
 * @returns The registered table's column entries; invalid or unregistered handles throw.
 */
function assertRegisteredHandle(
  handle: TableHandle,
  method: string,
  isRegistered: ClientQueryContext['isRegistered'],
) {
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

  return info
}

/**
 * Creates an update entry point with patch validation and value mapping.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 *
 * @returns An update entry point using the registered handle's writable-column
 *   validation.
 */
function updateTable<THandle extends TableHandle>(
  handle: THandle,
  context: ClientQueryContext,
): UpdateSetBuilder<THandle> {
  const {
    dialect,
    query,
    mapper,
    executor: clientExecutor,
    ensureClientOpen,
    isRegistered,
  } = context
  ensureClientOpen()
  assertRegisteredHandle(handle, 'update', isRegistered)
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
 * Creates a delete entry point for a registered handle.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 *
 * @returns A delete builder bound to the registered handle and client executor.
 */
function deleteFrom<THandle extends TableHandle>(
  handle: THandle,
  context: ClientQueryContext,
): DeleteBuilder<THandle, InferSelect<THandle>> {
  const {
    dialect,
    query,
    mapper,
    executor: clientExecutor,
    ensureClientOpen,
    isRegistered,
  } = context
  ensureClientOpen()
  assertRegisteredHandle(handle, 'delete', isRegistered)
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
 * Rolls back a savepoint while retaining the callback's primary failure.
 *
 * @param transactionScope - Owning transaction queue and nested-scope lifecycle state.
 * @param operations - Session lifecycle operations used for transaction and savepoint
 *   boundaries.
 * @param savepointId - Savepoint sequence number used to identify nested transaction
 *   commands.
 * @param callbackError - Original callback rejection retained during transaction cleanup.
 */
async function rollbackNestedTransaction(
  transactionScope: TransactionScope,
  operations: DialectOperations,
  savepointId: number,
  callbackError: unknown,
): Promise<never> {
  const rawExecutor = transactionScope.operation.executor

  if (transactionScope.context.poisoned) throw callbackError

  try {
    await rawExecutor.run(
      operations.compile({
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
      operations.compile({ kind: 'releaseSavepoint', id: savepointId }),
    )
  } catch {
    transactionScope.context.poisoned = true
    transactionScope.operation.discard()
    throw callbackError
  }

  throw callbackError
}

/**
 * Queues a savepoint lifecycle command on its owning transaction scope.
 *
 * @param transactionScope - Owning transaction queue and nested-scope lifecycle state.
 * @param operations - Session lifecycle operations used for transaction and savepoint
 *   boundaries.
 * @param kind - Native relation or query kind used to select fixture evidence.
 * @param savepointId - Savepoint sequence number used to identify nested transaction
 *   commands.
 */
async function executeSavepoint(
  transactionScope: TransactionScope,
  operations: DialectOperations,
  kind: 'createSavepoint' | 'releaseSavepoint',
  savepointId: number,
): Promise<void> {
  const rawExecutor = transactionScope.operation.executor
  try {
    await rawExecutor.run(operations.compile({ kind, id: savepointId }))
  } catch (error) {
    transactionScope.context.poisoned = true
    transactionScope.operation.discard()
    throw error
  }
}

/**
 * Routes query and statement execution through exclusive operation sessions.
 *
 * @param coordinator - Coordinator that serializes root operations and session release.
 * @param ensureOpen - Guard that rejects work after root client shutdown.
 *
 * @returns An executor routing SQL through exclusive root operation sessions.
 */
function createRootExecutor(
  coordinator: OperationCoordinator,
  ensureOpen: () => void,
): Executor {
  return {
    /**
     * Executes a row-returning query through the operation coordinator.
     *
     * @param compiled - Compiled SQL, bound parameters, and optional session
     *   preconditions.
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
     * @param compiled - Compiled SQL, bound parameters, and optional session
     *   preconditions.
     */
    run(compiled) {
      ensureOpen()
      return coordinator.run(({ executor, identity }) => {
        compiled.assertSession?.(identity)
        return executor.run(compiled)
      })
    },
  }
}

/**
 * Runs migration work on the active transaction or a new operation session.
 *
 * @param coordinator - Coordinator that serializes root operations and session release.
 * @param clientExecutor - Executor bound to the current database client or transaction
 *   scope.
 * @param ensureClientOpen - Guard that rejects closed or expired client scopes.
 * @param ensureOpen - Guard that rejects work after root client shutdown.
 * @param transactionScope - Owning transaction queue and nested-scope lifecycle state.
 *
 * @returns The callback value after the operation and required cleanup complete.
 */
function createMigrationRunner(
  coordinator: OperationCoordinator,
  clientExecutor: Executor,
  ensureClientOpen: () => void,
  ensureOpen: () => void,
  transactionScope: TransactionScope | undefined,
): Parameters<typeof createMigrateBuilder>[0]['runOperation'] {
  return async (operation) => {
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
  }
}

/**
 * Describes work attempted from the wrong nested transaction scope.
 *
 * @param scope - Requested catalog or coordination scope for this scenario.
 *
 * @returns An error describing access outside the owning transaction scope.
 */
function transactionScopeOwnershipError(scope: TransactionScope): QueryError | undefined {
  let frame = activeTransactionScope.getStore()
  while (frame) {
    if (
      frame.scope.active &&
      frame.scope !== scope &&
      isDescendantScope(frame.scope, scope)
    ) {
      return new QueryError({
        message:
          'Cannot use an ancestor transaction client inside a nested transaction callback; use the nested callback client instead',
      })
    }

    frame = frame.parent
  }

  return undefined
}

/**
 * Binds desired-state migration to the current client and transaction scope.
 *
 * @param context - Resolved client dependencies and desired schema.
 * @param clientExecutor - Executor bound to this client scope.
 * @param ensureClientOpen - Guard for client and transaction lifetime.
 * @param transactionScope - Active transaction scope, when present.
 *
 * @returns A migration builder using this scope's executor and lifecycle guards.
 */
function createScopedMigration<TSchemas extends readonly TableHandle[]>(
  context: DatabaseClientContext<TSchemas>,
  clientExecutor: Executor,
  ensureClientOpen: () => void,
  transactionScope: TransactionScope | undefined,
) {
  return createClientMigration(
    context.config,
    context.dialect,
    context.coordinator,
    clientExecutor,
    ensureClientOpen,
    context.ensureOpen,
    transactionScope,
  )
}
