import { randomUUID } from 'node:crypto'
import type { Client } from 'pg'
import { array, boolean, date, integer, number, object, pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/index'
import { QueryError, column, defineTable, eq, reference } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

const OmittedItems = defineTable(
  'omitted_items',
  { id: string(), value: string() },
  { primaryKey: 'id' },
)

const Accounts = defineTable(
  'accounts',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    email: string(),
  },
  {
    primaryKey: 'id',
    indexes: [{ name: 'accounts_email_uidx', columns: ['email'], unique: true }],
  },
)

const Events = defineTable(
  'events',
  {
    id: pipe(
      number(),
      integer(),
      column({ generation: { kind: 'identity', mode: 'byDefault' } }),
    ),
    accountId: reference(Accounts, 'id'),
    literalSql: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'now(); drop table events' } }),
    ),
    enabled: pipe(
      boolean(),
      column({ databaseDefault: { kind: 'literal', value: true } }),
    ),
    score: pipe(number(), column({ databaseDefault: { kind: 'literal', value: 7 } })),
    createdAt: pipe(
      date(),
      column({
        databaseDefault: {
          kind: 'portableExpression',
          expression: 'currentTimestamp',
        },
      }),
    ),
    payload: object({ label: string() }),
    tags: array(string()),
  },
  {
    primaryKey: 'id',
    indexes: [{ name: 'events_created_at_idx', columns: ['createdAt'] }],
  },
)

beforeAll(waitForPostgres)

describe('PostgreSQL namespace and value integration', () => {
  it('uses the real current schema when registration omits a namespace', async () => {
    await withPostgresDatabase(
      [OmittedItems],
      async ({ db, schema, admin, connector }) => {
        const current = await (
          await connector.getInstance()
        ).query<{
          current_schema: string
        }>('select current_schema()')
        expect(current.rows[0]?.current_schema).toBe(schema)

        await db.migrate().execute()
        await db.insert(OmittedItems).values({ id: 'one', value: 'isolated' }).execute()

        const rows = await admin.query<{ value: string }>(
          `select value from ${quoteIdentifier(schema)}.${quoteIdentifier('omitted_items')}`,
        )
        expect(rows.rows).toEqual([{ value: 'isolated' }])
        await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
      },
      { useRegistrationDefault: false, sessionSchema: 'isolated' },
    )
  })
})

describe('PostgreSQL namespace and value integration: lets an explicit registration default win over current_schema()', () => {
  it('lets an explicit registration default win over current_schema()', async () => {
    await withPostgresDatabase(
      [OmittedItems],
      async ({ db, schema, alternateSchema, admin, connector }) => {
        const current = await (
          await connector.getInstance()
        ).query<{
          current_schema: string
        }>('select current_schema()')
        expect(current.rows[0]?.current_schema).toBe(alternateSchema)

        await db.migrate().execute()
        await db.insert(OmittedItems).values({ id: 'one', value: 'explicit' }).execute()

        const target = await admin.query<{ value: string }>(
          `select value from ${quoteIdentifier(schema)}.${quoteIdentifier('omitted_items')}`,
        )
        const alternate = await admin.query<{ exists: boolean }>(
          `select to_regclass($1) is not null as exists`,
          [`${alternateSchema}.omitted_items`],
        )
        expect(target.rows).toEqual([{ value: 'explicit' }])
        expect(alternate.rows).toEqual([{ exists: false }])
      },
      { sessionSchema: 'alternate' },
    )
  })
})

describe('PostgreSQL namespace and value integration: round-trips defaults, identity, references, indexes, and mapped values', () => {
  it('round-trips defaults, identity, references, indexes, and mapped values', async () => {
    await withPostgresDatabase([Accounts, Events], async ({ db, schema, admin }) => {
      await db.migrate().execute()
      const accountId = randomUUID()
      await db
        .insert(Accounts)
        .values({ id: accountId, email: 'owner@example.com' })
        .execute()

      await assertDefaultedEvent(admin, db, accountId)

      const explicitDate = new Date('2026-09-10T03:04:05.000Z')
      await assertExplicitEventValues(db, accountId, explicitDate)

      await assertConstraintsAndIndexes(db, admin, schema)
    })
  })
})

/**
 * Checks authored timestamps and mapped values through insertion, joined reads, and
 * filtered reads.
 *
 * @param db - Database client exercised by this test scenario.
 * @param accountId - Account identifier shared by the inserted account and referencing
 *   event.
 * @param explicitDate - Authored timestamp used to check parameter and result round
 *   trips.
 */
async function assertExplicitEventValues(db: Db, accountId: string, explicitDate: Date) {
  const event = await db
    .insert(Events)
    .values({
      accountId,
      createdAt: explicitDate,
      payload: { label: 'mapped object' },
      tags: ['one', 'two'],
    })
    .executeTakeFirstOrThrow()

  expect(event).toEqual({
    id: 2,
    accountId,
    literalSql: 'now(); drop table events',
    enabled: true,
    score: 7,
    createdAt: explicitDate,
    payload: { label: 'mapped object' },
    tags: ['one', 'two'],
  })

  await expect(
    db
      .from(Events)
      .innerJoin(Accounts, eq(Events.accountId, Accounts.id))
      .select([Events.id, Accounts.email])
      .where(Events.id, 'eq', event.id)
      .execute(),
  ).resolves.toEqual([{ id: 2, email: 'owner@example.com' }])

  await expect(
    db.from(Events).where(Events.createdAt, 'eq', explicitDate).execute(),
  ).resolves.toMatchObject([{ id: 2, createdAt: explicitDate }])
}

/**
 * Checks database defaults, identity generation, and mapped values against the server
 * clock.
 *
 * @param admin - Administrative PostgreSQL client that owns isolated namespace setup and
 *   cleanup.
 * @param db - Database client exercised by this test scenario.
 * @param accountId - Account identifier shared by the inserted account and referencing
 *   event.
 */
async function assertDefaultedEvent(admin: Client, db: Db, accountId: string) {
  const beforeDefault = await admin.query<{ now: Date }>(
    'select clock_timestamp() as now',
  )
  const defaulted = await db
    .insert(Events)
    .values({
      accountId,
      payload: { label: 'default timestamp' },
      tags: ['default'],
    })
    .executeTakeFirstOrThrow()
  const afterDefault = await admin.query<{ now: Date }>('select clock_timestamp() as now')

  expect(defaulted).toMatchObject({
    id: 1,
    accountId,
    literalSql: 'now(); drop table events',
    enabled: true,
    score: 7,
    payload: { label: 'default timestamp' },
    tags: ['default'],
  })

  expect(defaulted.createdAt).toBeInstanceOf(Date)

  expect(defaulted.createdAt.getTime()).toBeGreaterThanOrEqual(
    beforeDefault.rows[0]!.now.getTime(),
  )

  expect(defaulted.createdAt.getTime()).toBeLessThanOrEqual(
    afterDefault.rows[0]!.now.getTime(),
  )

  await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
}

/**
 * Checks real foreign-key enforcement, unique keys, and physical index creation.
 *
 * @param db - Database client exercised by this test scenario.
 * @param admin - Administrative PostgreSQL client that owns isolated namespace setup and
 *   cleanup.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 */
async function assertConstraintsAndIndexes(
  db: Db<readonly [typeof Accounts, typeof Events]>,
  admin: Client,
  schema: string,
) {
  const foreignKeyInsert = db
    .insert(Events)
    .values({
      accountId: randomUUID(),
      payload: { label: 'invalid reference' },
      tags: [],
    })
    .execute()

  await expect(foreignKeyInsert).rejects.toBeInstanceOf(QueryError)

  await expect(foreignKeyInsert).rejects.toMatchObject({
    cause: { code: '23503' },
  })

  const uniqueConstraintInsert = db
    .insert(Accounts)
    .values({ id: randomUUID(), email: 'owner@example.com' })
    .execute()

  await expect(uniqueConstraintInsert).rejects.toBeInstanceOf(QueryError)

  await expect(uniqueConstraintInsert).rejects.toMatchObject({
    cause: { code: '23505' },
  })

  await assertPhysicalIndexes(admin, schema)
}

/**
 * Checks the real database's physical index definitions for the managed tables.
 *
 * @param admin - Administrative PostgreSQL client that owns isolated namespace setup and
 *   cleanup.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 */
async function assertPhysicalIndexes(admin: Client, schema: string) {
  const indexes = await admin.query<{ indexname: string }>(
    'select indexname from pg_indexes where schemaname = $1 order by indexname',
    [schema],
  )
  expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
    expect.arrayContaining(['accounts_email_uidx', 'events_created_at_idx']),
  )

  const ordinaryIndex = await admin.query<{
    indexName: string
    isUnique: boolean
  }>(
    `select idx.relname as "indexName", i.indisunique as "isUnique"
         from pg_index i
         join pg_class idx on idx.oid = i.indexrelid
         join pg_class tbl on tbl.oid = i.indrelid
         join pg_namespace n on n.oid = tbl.relnamespace
         where n.nspname = $1 and tbl.relname = 'events'
           and idx.relname = 'events_created_at_idx'`,
    [schema],
  )
  expect(ordinaryIndex.rows).toEqual([
    { indexName: 'events_created_at_idx', isUnique: false },
  ])
}
