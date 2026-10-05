import postgresql from 'db0/connectors/postgresql'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

import type { Db } from '@/client'
import type {
  MigrationOwnershipDeclaration,
  OperationSession,
  OperationSessionProvider,
  TableHandle,
} from '@/index'
import { createDatabase, createDb0PostgresqlOperationSessionProvider } from '@/index'

import { waitForPostgres } from './postgres.setup'
import type { DialectIntegrationAdapter } from './support/dialectIntegrationContract'

const postgresUrl = process.env.POSTGRESQL_URL
type PostgresConnector = ReturnType<typeof postgresql>

export type SessionEvent = Readonly<{
  sql: string
  physicalSession: string
}>

type SessionHooks = Readonly<{
  /**
   * Observes a physical SQL call before native execution.
   *
   * @param event - Observed SQL call and physical-session identity supplied to a hook.
   */
  before?(event: SessionEvent): Promise<void> | void
  /**
   * Observes a physical SQL call after native execution.
   *
   * @param event - Observed SQL call and physical-session identity supplied to a hook.
   */
  after?(event: SessionEvent): Promise<void> | void
}>

type PostgresDatabaseOptions = Readonly<{
  useRegistrationDefault?: boolean
  applicationId?: string
  migrationOwnership?: readonly MigrationOwnershipDeclaration[]
  hooks?: SessionHooks
  sessionSchema?: 'isolated' | 'alternate'
  /** Runs the extra cleanup action exercised by the integration failure scenario. */
  additionalCleanup?(): Promise<void>
}>

type PostgresClientOptions = Omit<
  PostgresDatabaseOptions,
  'sessionSchema' | 'additionalCleanup'
>

type CallbackSettlement<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected'; reason: unknown }>

export type PostgresDatabaseContext<TSchemas extends readonly TableHandle[]> = Readonly<{
  db: Db<TSchemas>
  schema: string
  alternateSchema: string
  admin: Client
  connector: PostgresConnector
  /**
   * Creates and registers cleanup for an additional client in the isolated integration
   * namespace.
   *
   * @param schemas - Registered table handles defining the desired schema.
   * @param options - Fixture controls for outcomes, observed calls, and failure
   *   scenarios.
   *
   * @returns And registers cleanup for an additional client in the isolated integration
   *   namespace.
   */
  createDatabase<const TAdditionalSchemas extends readonly TableHandle[]>(
    schemas: TAdditionalSchemas,
    options?: PostgresClientOptions,
  ): Db<TAdditionalSchemas>
}>

/** Quotes PostgreSQL identifiers used to create and inspect isolated test namespaces. */
export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

/**
 * Generates a process-specific random schema name to isolate concurrent integration
 * tests.
 */
function newTestSchema(): string {
  return `stratom_it_${process.pid}_${randomUUID().replaceAll('-', '')}`
}

/**
 * Connects an administrative PostgreSQL client using the configured integration database
 * URL.
 *
 * @returns The connected administrative PostgreSQL client owned by the harness.
 */
export async function createAdminClient(): Promise<Client> {
  if (!postgresUrl) {
    throw new Error('POSTGRESQL_URL is required for PostgreSQL integration tests')
  }

  const client = new Client({ connectionString: postgresUrl })
  await client.connect()
  return client
}

/** Delegates to the real provider while exposing deterministic test-only hooks. */
function observeSessionProvider(
  provider: OperationSessionProvider,
  hooks: SessionHooks,
): OperationSessionProvider {
  return {
    nativeTransactions: true,
    /** Opens an exclusive fixture session with lifecycle controls. */
    async open(): Promise<OperationSession> {
      const session = await provider.open()

      /** Associates the physical SQL call with the current session identity. */
      const event = (sql: string): SessionEvent => ({
        sql,
        physicalSession: session.identity.physicalSession,
      })

      return {
        identity: session.identity,
        /** Runs fixture SQL and records physical-session ownership. */
        async query(compiled): Promise<unknown[]> {
          const observed = event(compiled.sql)
          await hooks.before?.(observed)
          const rows = await session.query(compiled)
          await hooks.after?.(observed)
          return rows
        },
        /** Runs a fixture statement with configured outcomes. */
        async run(compiled): Promise<void> {
          const observed = event(compiled.sql)
          await hooks.before?.(observed)
          await session.run(compiled)
          await hooks.after?.(observed)
        },
        /** Cancels the active physical-session operation. */
        cancel: () => session.cancel(),
        /** Releases the fixture lease with configured cleanup behavior. */
        release: (disposition) => session.release(disposition),
      }
    },
    /** Closes the fixture provider after its leases settle. */
    close: () => provider.close(),
  }
}

/**
 * Binds a database client to the isolated schema and optional session observation hooks.
 *
 * @param connector - Connector that owns native connection resources.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 * @param schemas - Registered table handles defining the desired schema.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns The database client bound to the isolated namespace and observation hooks.
 */
function createPostgresDatabase<const TSchemas extends readonly TableHandle[]>(
  connector: PostgresConnector,
  schema: string,
  schemas: TSchemas,
  options: PostgresClientOptions,
): Db<TSchemas> {
  const realProvider = createDb0PostgresqlOperationSessionProvider(connector)
  const operationSessionProvider = options.hooks
    ? observeSessionProvider(realProvider, options.hooks)
    : realProvider

  return createDatabase({
    connector,
    schemas,
    operationSessionProvider,
    ...(options.useRegistrationDefault === false
      ? {}
      : { defaultNamespace: [{ role: 'schema' as const, spelling: schema }] }),
    ...(options.applicationId === undefined
      ? {}
      : { applicationId: options.applicationId }),
    ...(options.migrationOwnership === undefined
      ? {}
      : { migrationOwnership: options.migrationOwnership }),
  })
}

/** Runs a callback with a unique namespace and retains callback and cleanup errors. */
export async function withPostgresDatabase<
  const TSchemas extends readonly TableHandle[],
  TResult,
>(
  schemas: TSchemas,
  callback: (context: PostgresDatabaseContext<TSchemas>) => Promise<TResult>,
  options: PostgresDatabaseOptions = {},
): Promise<TResult> {
  if (!postgresUrl) {
    throw new Error('POSTGRESQL_URL is required for PostgreSQL integration tests')
  }

  const schema = newTestSchema()
  const alternateSchema = newTestSchema()
  const admin = await createAdminClient()
  const connector = postgresql({ url: postgresUrl })
  const cleanup: (() => Promise<void>)[] = []
  const databaseState: PostgresTestDatabaseState<TSchemas> = { db: undefined }
  const callbackSettlement = await runPostgresCallback({
    url: postgresUrl,
    schemas,
    callback,
    options,
    schema,
    alternateSchema,
    admin,
    connector,
    cleanup,
    databaseState,
  })

  const cleanupErrors = await cleanupPostgresDatabase(
    databaseState.db,
    connector,
    admin,
    cleanup,
  )

  return unwrapPostgresCallback<TResult>(callbackSettlement, cleanupErrors)
}

const supported = { state: 'supported' as const }

export const postgresIntegrationAdapter: DialectIntegrationAdapter = {
  name: 'PostgreSQL',
  readiness: waitForPostgres,
  capabilities: {
    lifecycle: supported,
    query: supported,
    transaction: supported,
    migration: supported,
    convergence: supported,
  },
  /** Runs the shared integration scenario with the adapter's isolated database client. */
  withDatabase(schemas, callback) {
    return withPostgresDatabase(schemas, callback)
  },
}

/**
 * Returns callback success or combines its rejection with cleanup failures in observation
 * order.
 *
 * @param callbackSettlement - Captured callback success or rejection, including undefined
 *   rejection values.
 * @param cleanupErrors - Cleanup rejections collected after the callback settles.
 *
 * @returns The callback value when both callback and cleanup succeed.
 */
function unwrapPostgresCallback<TResult>(
  callbackSettlement: CallbackSettlement<TResult>,
  cleanupErrors: unknown[],
) {
  if (callbackSettlement.status === 'rejected') {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [callbackSettlement.reason, ...cleanupErrors],
        callbackSettlement.reason instanceof Error
          ? callbackSettlement.reason.message
          : 'PostgreSQL test failed',
      )
    }

    throw callbackSettlement.reason
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'PostgreSQL test cleanup failed')
  }

  return callbackSettlement.value
}

/**
 * Creates isolated test namespaces and registers their cleanup in creation order.
 *
 * @param admin - Administrative PostgreSQL client that owns isolated namespace setup and
 *   cleanup.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 * @param cleanup - Cleanup actions registered in resource-creation order.
 * @param alternateSchema - Second isolated namespace used to test session-default
 *   behavior.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 */
async function preparePostgresNamespaces(
  admin: Client,
  schema: string,
  cleanup: (() => Promise<void>)[],
  alternateSchema: string,
  options: Readonly<{
    useRegistrationDefault?: boolean
    applicationId?: string
    migrationOwnership?: readonly MigrationOwnershipDeclaration[]
    hooks?: SessionHooks
    sessionSchema?: 'isolated' | 'alternate'
    additionalCleanup?(): Promise<void>
  }>,
) {
  await admin.query(`create schema ${quoteIdentifier(schema)}`)

  cleanup.push(async () => {
    await admin.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`)
  })

  await admin.query(`create schema ${quoteIdentifier(alternateSchema)}`)

  cleanup.push(async () => {
    await admin.query(`drop schema if exists ${quoteIdentifier(alternateSchema)} cascade`)
  })

  if (options.additionalCleanup) cleanup.push(options.additionalCleanup)
}

/**
 * Closes clients and removes namespaces in reverse creation order while retaining every
 * cleanup error.
 *
 * @param db - Database client exercised by this test scenario.
 * @param connector - Connector that owns native connection resources.
 * @param admin - Administrative PostgreSQL client that owns isolated namespace setup and
 *   cleanup.
 * @param cleanup - Cleanup actions registered in resource-creation order.
 *
 * @returns Cleanup rejections in reverse resource-creation order.
 */
async function cleanupPostgresDatabase(
  db: { close(): Promise<void> } | undefined,
  connector: ReturnType<typeof postgresql>,
  admin: Client,
  cleanup: (() => Promise<void>)[],
) {
  const cleanupErrors: unknown[] = []
  try {
    if (db) await db.close()
    else await connector.dispose?.()
  } catch (cause) {
    cleanupErrors.push(cause)
  }

  for (const clean of [...cleanup].reverse()) {
    try {
      await clean()
    } catch (cause) {
      cleanupErrors.push(cause)
    }
  }

  try {
    await admin.end()
  } catch (cause) {
    cleanupErrors.push(cause)
  }

  return cleanupErrors
}

type PostgresTestDatabaseState<TSchemas extends readonly TableHandle[]> = {
  db: Db<TSchemas> | undefined
}

type PostgresCallbackSetup<TSchemas extends readonly TableHandle[], TResult> = {
  url: string
  schemas: TSchemas
  callback: (context: PostgresDatabaseContext<TSchemas>) => Promise<TResult>
  options: PostgresDatabaseOptions
  schema: string
  alternateSchema: string
  admin: Client
  connector: PostgresConnector
  cleanup: (() => Promise<void>)[]
  databaseState: PostgresTestDatabaseState<TSchemas>
}

/**
 * Prepares namespace defaults and captures callback success or rejection before resource
 * cleanup.
 *
 * @param input - Postgres callback setup inputs and shared accumulators.
 *
 * @returns The callback value after the operation and required cleanup complete.
 */
async function runPostgresCallback<TSchemas extends readonly TableHandle[], TResult>(
  input: PostgresCallbackSetup<TSchemas, TResult>,
): Promise<CallbackSettlement<TResult>> {
  const { callback, options, schema, alternateSchema, admin, connector, cleanup } = input
  try {
    await preparePostgresNamespaces(admin, schema, cleanup, alternateSchema, options)

    if (options.sessionSchema) {
      const instance = await connector.getInstance()
      await instance.query(
        `set search_path to ${quoteIdentifier(
          options.sessionSchema === 'isolated' ? schema : alternateSchema,
        )}`,
      )
    }

    const value = await callback(createPostgresCallbackContext(input))
    return { status: 'fulfilled', value }
  } catch (reason) {
    return { status: 'rejected', reason }
  }
}

/**
 * Creates the test client and exposes additional clients under the same isolated
 * namespace.
 *
 * @param input - Postgres callback setup inputs and shared accumulators.
 *
 * @returns The test client and exposes additional clients under the same isolated
 *   namespace.
 */
function createPostgresCallbackContext<TSchemas extends readonly TableHandle[], TResult>(
  input: PostgresCallbackSetup<TSchemas, TResult>,
): PostgresDatabaseContext<TSchemas> {
  const {
    databaseState,
    connector,
    schema,
    schemas,
    options,
    alternateSchema,
    admin,
    cleanup,
  } = input
  databaseState.db = createPostgresDatabase(connector, schema, schemas, options)
  return {
    db: databaseState.db,
    schema,
    alternateSchema,
    admin,
    connector,
    /**
     * Creates and registers cleanup for an additional client in the isolated integration
     * namespace.
     */
    createDatabase(additionalSchemas, additionalOptions = {}) {
      const additional = createPostgresDatabase(
        postgresql({ url: input.url }),
        schema,
        additionalSchemas,
        additionalOptions,
      )
      cleanup.push(() => additional.close())
      return additional
    },
  }
}
