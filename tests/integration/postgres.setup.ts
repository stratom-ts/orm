import 'dotenv/config'
import { Client } from 'pg'

const url = process.env.POSTGRESQL_URL

if (!url) {
  throw new Error(
    'PostgreSQL integration tests require POSTGRESQL_URL. Start Docker with `docker compose up -d --wait` and copy `.env.example` to `.env`.',
  )
}

const deadline = Date.now() + 30_000
let connected = false

while (Date.now() < deadline) {
  const client = new Client({ connectionString: url })

  try {
    await client.connect()
    await client.query('select 1')
    await client.end()
    connected = true
    break
  } catch {
    await client.end().catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

if (!connected) {
  throw new Error(
    'PostgreSQL integration tests could not connect. Start Docker with docker compose up -d --wait and verify the PostgreSQL health check and POSTGRESQL_URL.',
  )
}
