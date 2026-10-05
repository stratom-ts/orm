import { beforeAll, describe, expect, it } from 'vitest'

import { waitForPostgres } from './postgres.setup'
import { createAdminClient, withPostgresDatabase } from './postgresIntegration'

/**
 * Checks schemas absent in the current test scenario.
 *
 * @param schemas - Registered table handles defining the desired schema.
 */
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

type ObservedSession = Readonly<{
  role: string
  physicalSession: string
}>

/**
 * Checks backends absent in the current test scenario.
 *
 * @param sessions - Physical-session observations indexed by native session identity.
 */
async function expectBackendsAbsent(sessions: readonly ObservedSession[]): Promise<void> {
  const admin = await createAdminClient()

  try {
    const remaining = await admin.query<{ pid: string }>(
      'select pid::text as pid from pg_stat_activity where pid = any($1::int[]) order by pid',
      [sessions.map(({ physicalSession }) => Number(physicalSession))],
    )

    const rolesBySession = new Map(
      sessions.map(({ role, physicalSession }) => [physicalSession, role] as const),
    )

    expect(
      remaining.rows,
      `Open PostgreSQL backends: ${
        remaining.rows
          .map(({ pid }) => `${rolesBySession.get(pid) ?? 'unknown'}=${pid}`)
          .join(', ') || 'none'
      }; observed sessions: ${sessions
        .map(({ role, physicalSession }) => `${role}=${physicalSession}`)
        .join(', ')}`,
    ).toEqual([])
  } finally {
    await admin.end()
  }
}

describe('PostgreSQL integration harness', () => {
  registerLifecycleIntegration()

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
        /** Runs the extra cleanup action exercised by the integration failure scenario. */
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

/** Registers the scenario that closes every client and removes both isolated schemas. */
function registerLifecycleIntegration() {
  beforeAll(waitForPostgres)

  it('closes every client and removes both isolated schemas', async () => {
    const sessions = new Map<string, ObservedSession>()
    /**
     * Creates a hook that records physical-session ownership for the selected client
     * role.
     */
    const observeSession = (role: string) => (event: { physicalSession: string }) => {
      sessions.set(event.physicalSession, {
        role,
        physicalSession: event.physicalSession,
      })
    }

    const schemas = await withPostgresDatabase(
      [] as const,
      async ({ db, schema, alternateSchema, admin, createDatabase }) => {
        const adminIdentity = await admin.query<{ physicalSession: string }>(
          'select pg_backend_pid()::text as "physicalSession"',
        )

        const physicalSession = adminIdentity.rows[0]!.physicalSession
        sessions.set(physicalSession, { role: 'admin', physicalSession })
        const additional = createDatabase([] as const, {
          hooks: { before: observeSession('additional') },
        })

        await db.ping()
        await additional.ping()
        return [schema, alternateSchema] as const
      },
      { hooks: { before: observeSession('primary') } },
    )

    expect(new Set([...sessions.values()].map(({ role }) => role))).toEqual(
      new Set(['admin', 'primary', 'additional']),
    )

    await expectSchemasAbsent(schemas)
    await expectBackendsAbsent([...sessions.values()])
  })
}
