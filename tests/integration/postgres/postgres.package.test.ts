import { bigint, boolean, date, integer, number, object, pipe, string } from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { waitForPostgres } from './postgres.setup'
import type { PostgresDatabaseContext } from './postgresIntegration'
import { createAdminClient, withPostgresDatabase } from './postgresIntegration'

type Library = typeof import('@/index')

// A variable specifier keeps typecheck independent of a prior build.
const packageName = 'stratom'
let library: Library

beforeAll(async () => {
  await waitForPostgres()
  library = (await import(packageName)) as Library
})

/** Describes the native PostgreSQL column types independently of package inference. */
async function expectPhysicalColumns(
  admin: Awaited<ReturnType<typeof createAdminClient>>,
  schema: string,
) {
  const result = await admin.query<{ column_name: string; data_type: string }>(
    `select column_name, data_type from information_schema.columns
     where table_schema = $1 and table_name = 'package_records' order by ordinal_position`,
    [schema],
  )

  expect(result.rows).toEqual([
    { column_name: 'id', data_type: 'integer' },
    { column_name: 'value', data_type: 'bigint' },
    { column_name: 'active', data_type: 'boolean' },
    { column_name: 'stamp', data_type: 'timestamp with time zone' },
    { column_name: 'data', data_type: 'jsonb' },
  ])
}

/** Checks the fixture released its namespaces and native PostgreSQL sessions. */
async function expectReleased(schemas: readonly string[], sessions: readonly string[]) {
  const admin = await createAdminClient()
  try {
    const namespaces = await admin.query<{ nspname: string }>(
      'select nspname from pg_namespace where nspname = any($1::text[])',
      [schemas],
    )

    const backends = await admin.query<{ pid: number }>(
      'select pid from pg_stat_activity where pid = any($1::int[])',
      [sessions.map(Number)],
    )

    expect(namespaces.rows).toEqual([])
    expect(backends.rows).toEqual([])
  } finally {
    await admin.end()
  }
}

/** Proves the built client maps values and enforces root transaction routing. */
async function expectPostgresValues(
  db: PostgresDatabaseContext<readonly [Records]>['db'],
  Records: Records,
) {
  const row = {
    id: 1,
    value: 9007199254740993n,
    active: true,
    stamp: new Date('2026-01-02T03:04:05.000Z'),
    data: { label: 'committed' },
  }

  await db.insert(Records).values(row).execute()

  expect(await db.from(Records).where({ id: 1 }).execute()).toEqual([
    { ...row, value: '9007199254740993' },
  ])

  const transactionRow = { ...row, id: 2 }
  await expect(
    db.transaction(async (transaction) => {
      await expect(db.from(Records).execute()).rejects.toThrow(/scoped client/)
      await transaction.insert(Records).values(transactionRow).execute()
      throw new Error('rollback package transaction')
    }),
  ).rejects.toThrow('rollback package transaction')

  expect(await db.from(Records).where({ id: 2 }).execute()).toEqual([])

  await db.transaction(async (transaction) => {
    await transaction.insert(Records).values(transactionRow).execute()
  })

  expect(await db.from(Records).where({ id: 2 }).execute()).toEqual([
    { ...transactionRow, value: '9007199254740993' },
  ])
}

/** Defines the packaged client's representative PostgreSQL relation. */
function recordsTable(library: Library) {
  return library.defineTable(
    'package_records',
    {
      id: pipe(number(), integer()),
      value: bigint(),
      active: boolean(),
      stamp: date(),
      data: object({ label: string() }),
    },
    { primaryKey: 'id' },
  )
}

type Records = ReturnType<typeof recordsTable>

it('maps, migrates and releases the built package on native PostgreSQL', async () => {
  const Records = recordsTable(library)

  const sessions = new Set<string>()
  const schemas = await withPostgresDatabase(
    [Records],
    async ({ db, admin, schema, alternateSchema }) => {
      const identity = await admin.query<{ pid: string }>(
        'select pg_backend_pid()::text as pid',
      )

      sessions.add(identity.rows[0]!.pid)
      expect((await db.migrate().plan()).steps.length).toBeGreaterThan(0)
      await db.migrate().execute()
      expect(await db.migrate().plan()).toEqual({ steps: [] })
      await expectPhysicalColumns(admin, schema)

      await expectPostgresValues(db, Records)
      return [schema, alternateSchema] as const
    },
    {
      library,
      hooks: {
        before: ({ physicalSession }) => {
          sessions.add(physicalSession)
        },
      },
    },
  )

  expect(sessions.size).toBeGreaterThan(1)
  await expectReleased(schemas, [...sessions])
})
