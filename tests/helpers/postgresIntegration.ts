import postgresql from 'db0/connectors/postgresql'
import { randomUUID } from 'node:crypto'
import { Client } from 'pg'

import type { Db } from '@/client'
import type { TableHandle } from '@/index'
import { createDatabase } from '@/index'

export const postgresUrl = process.env.POSTGRESQL_URL

export function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

export function newTestSchema(): string {
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

export async function withPostgresDatabase<
  TSchemas extends readonly TableHandle[],
  TResult,
>(
  schemas: TSchemas,
  callback: (context: {
    db: Db<TSchemas>
    schema: string
    admin: Client
  }) => Promise<TResult>,
): Promise<TResult> {
  if (!postgresUrl) {
    throw new Error('POSTGRESQL_URL is required for PostgreSQL integration tests')
  }

  const schema = newTestSchema()
  const admin = await createAdminClient()

  const db = createDatabase({
    connector: postgresql({ url: postgresUrl }),
    schemas,
    defaultNamespace: [{ role: 'schema', spelling: schema }],
  })

  let callbackCompleted = false
  let callbackResult!: TResult
  let callbackError: unknown

  try {
    callbackResult = await callback({ db, schema, admin })
    callbackCompleted = true
  } catch (cause) {
    callbackError = cause
  }

  const cleanupErrors: unknown[] = []

  try {
    await db.close()
  } catch (cause) {
    cleanupErrors.push(cause)
  }

  try {
    await admin.query(`drop schema if exists ${quoteIdentifier(schema)} cascade`)
  } catch (cause) {
    cleanupErrors.push(cause)
  }

  try {
    await admin.end()
  } catch (cause) {
    cleanupErrors.push(cause)
  }

  if (!callbackCompleted) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [callbackError, ...cleanupErrors],
        callbackError instanceof Error ? callbackError.message : 'PostgreSQL test failed',
      )
    }

    throw callbackError
  }

  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'PostgreSQL test cleanup failed')
  }

  return callbackResult
}
