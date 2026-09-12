import { beforeAll, describe, expect, it } from 'vitest'

import { waitForPostgres } from './postgres.setup'
import { createAdminClient, withPostgresDatabase } from './postgresIntegration'

async function expectSchemasAbsent(schemas: readonly string[]): Promise<void> {
  const admin = await createAdminClient()

  try {
    const remaining = await admin.query<{ nspname: string }>(
      'select nspname from pg_namespace where nspname = any($1::text[]) order by nspname',
      [[...schemas]],
    )
    expect(remaining.rows).toEqual([])
  } finally {
    await admin.end()
  }
}

async function expectBackendsAbsent(physicalSessions: readonly string[]): Promise<void> {
  const admin = await createAdminClient()

  try {
    const remaining = await admin.query<{ pid: string }>(
      'select pid::text as pid from pg_stat_activity where pid = any($1::int[]) order by pid',
      [physicalSessions.map(Number)],
    )
    expect(remaining.rows).toEqual([])
  } finally {
    await admin.end()
  }
}

describe('PostgreSQL integration harness', () => {
  beforeAll(waitForPostgres)

  it('closes every client and removes both isolated schemas', async () => {
    const physicalSessions = new Set<string>()
    const observeSession = (event: { physicalSession: string }) => {
      physicalSessions.add(event.physicalSession)
    }

    const schemas = await withPostgresDatabase(
      [] as const,
      async ({ db, schema, alternateSchema, admin, createDatabase }) => {
        const adminIdentity = await admin.query<{ physicalSession: string }>(
          'select pg_backend_pid()::text as "physicalSession"',
        )
        physicalSessions.add(adminIdentity.rows[0]!.physicalSession)
        const additional = createDatabase([] as const, {
          hooks: { before: observeSession },
        })
        await db.ping()
        await additional.ping()
        return [schema, alternateSchema] as const
      },
      { hooks: { before: observeSession } },
    )

    expect([...physicalSessions]).toHaveLength(3)
    await expectSchemasAbsent(schemas)
    await expectBackendsAbsent([...physicalSessions])
  })

  it('retains callback and cleanup failures while still removing both schemas', async () => {
    const primary = new Error('primary callback failure')
    const cleanup = new Error('additional cleanup failure')
    let schemas: readonly string[] = []

    const failure = await withPostgresDatabase(
      [] as const,
      async ({ schema, alternateSchema }) => {
        schemas = [schema, alternateSchema]
        throw primary
      },
      {
        async additionalCleanup() {
          throw cleanup
        },
      },
    ).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(primary)
    expect((failure as AggregateError).errors).toContain(cleanup)
    await expectSchemasAbsent(schemas)
  })
})
