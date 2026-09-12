import { Client } from 'pg'

const RETRY_INTERVAL_MS = 250
const READINESS_TIMEOUT_MS = 30_000

/** Waits for the PostgreSQL service used by this Dialect's integration suite. */
export async function waitForPostgres(): Promise<void> {
  const url = process.env.POSTGRESQL_URL

  if (!url) {
    throw new Error(
      'PostgreSQL integration tests require POSTGRESQL_URL. Start Docker with `docker compose up -d --wait` and copy `.env.example` to `.env`.',
    )
  }

  const deadline = Date.now() + READINESS_TIMEOUT_MS

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const attemptTimeout = Math.max(1, Math.min(2_000, Math.floor(remaining / 2)))
    const client = new Client({
      connectionString: url,
      connectionTimeoutMillis: attemptTimeout,
      query_timeout: attemptTimeout,
    })

    try {
      await client.connect()
      await client.query('select 1')
      await client.end()
      return
    } catch {
      await client.end().catch(() => undefined)
      const retryDelay = Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now()))
      await new Promise((resolve) => setTimeout(resolve, retryDelay))
    }
  }

  throw new Error(
    'PostgreSQL integration tests could not connect. Start Docker with docker compose up -d --wait and verify the PostgreSQL health check and POSTGRESQL_URL.',
  )
}
