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
  before?(event: SessionEvent): Promise<void> | void
  after?(event: SessionEvent): Promise<void> | void
}>

type PostgresDatabaseOptions = Readonly<{
  useRegistrationDefault?: boolean
  applicationId?: string
  migrationOwnership?: readonly MigrationOwnershipDeclaration[]
  hooks?: SessionHooks
  sessionSchema?: 'isolated' | 'alternate'
  additionalCleanup?(): Promise<void>
}>

type PostgresClientOptions = Omit<
  PostgresDatabaseOptions,
  'sessionSchema' | 'additionalCleanup'
>

type CallbackSettlement<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected'; reason: unknown }>

type PostgresDatabaseContext<TSchemas extends readonly TableHandle[]> = Readonly<{
  db: Db<TSchemas>
  schema: string
  alternateSchema: string
  admin: Client
  connector: PostgresConnector
  createDatabase<const TAdditionalSchemas extends readonly TableHandle[]>(
    schemas: TAdditionalSchemas,
    options?: PostgresClientOptions,
  ): Db<TAdditionalSchemas>
}>

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function newTestSchema(): string {
  return `stratom_it_${process.pid}_${randomUUID().replaceAll('-', '')}`
}

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
    async open(): Promise<OperationSession> {
      const session = await provider.open()

      const event = (sql: string): SessionEvent => ({
        sql,
        physicalSession: session.identity.physicalSession,
      })

      return {
        identity: session.identity,
        async query(compiled): Promise<unknown[]> {
          const observed = event(compiled.sql)
          await hooks.before?.(observed)
          const rows = await session.query(compiled)
          await hooks.after?.(observed)
          return rows
        },
        async run(compiled): Promise<void> {
          const observed = event(compiled.sql)
          await hooks.before?.(observed)
          await session.run(compiled)
          await hooks.after?.(observed)
        },
        cancel: () => session.cancel(),
        release: (disposition) => session.release(disposition),
      }
    },
    close: () => provider.close(),
  }
}

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
  let db: Db<TSchemas> | undefined
  const callbackSettlement = await (async (): Promise<CallbackSettlement<TResult>> => {
    try {
      await admin.query(`create schema ${quoteIdentifier(schema)}`)

      cleanup.push(async () => {
        await admin.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`)
      })

      await admin.query(`create schema ${quoteIdentifier(alternateSchema)}`)

      cleanup.push(async () => {
        await admin.query(
          `drop schema if exists ${quoteIdentifier(alternateSchema)} cascade`,
        )
      })

      if (options.additionalCleanup) cleanup.push(options.additionalCleanup)

      if (options.sessionSchema) {
        const instance = await connector.getInstance()
        await instance.query(
          `set search_path to ${quoteIdentifier(
            options.sessionSchema === 'isolated' ? schema : alternateSchema,
          )}`,
        )
      }

      db = createPostgresDatabase(connector, schema, schemas, options)

      const value = await callback({
        db,
        schema,
        alternateSchema,
        admin,
        connector,
        createDatabase(additionalSchemas, additionalOptions = {}) {
          const additional = createPostgresDatabase(
            postgresql({ url: postgresUrl }),
            schema,
            additionalSchemas,
            additionalOptions,
          )
          cleanup.push(() => additional.close())
          return additional
        },
      })
      return { status: 'fulfilled', value }
    } catch (reason) {
      return { status: 'rejected', reason }
    }
  })()

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
  withDatabase(schemas, callback) {
    return withPostgresDatabase(schemas, callback)
  },
}
