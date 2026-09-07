import { boolean, number, pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, defineTable, eq, reference } from '@/index'

import { createAdminClient, withPostgresDatabase } from '../helpers/postgresIntegration'

const Users = defineTable(
  'users',
  {
    id: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'byDefault' },
      }),
    ),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    active: pipe(
      boolean(),
      column({
        physicalType: { postgresql: 'boolean' },
        databaseDefault: { kind: 'literal', value: true },
      }),
    ),
  },
  { primaryKey: 'id', indexes: [{ columns: ['email'], unique: true }] },
)

const Posts = defineTable(
  'posts',
  {
    id: pipe(
      number(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'byDefault' },
      }),
    ),
    title: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    userId: pipe(number(), reference(Users, 'id', { onDelete: 'cascade' })),
  },
  { primaryKey: 'id' },
)

const registeredSchemas = [Users, Posts] as const

describe.runIf(Boolean(process.env.POSTGRESQL_URL))('PostgreSQL integration', () => {
  it('connects, migrates an isolated namespace, and observes an empty second plan', async () => {
    await withPostgresDatabase(registeredSchemas, async ({ db, schema, admin }) => {
      await expect(db.ping()).resolves.toBeUndefined()
      const before = await admin.query<{ current_schema: string }>(
        'select current_schema()',
      )
      expect(before.rows[0]?.current_schema).not.toBe(schema)

      const initial = await db.migrate().dryRun()
      expect(initial.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'ensure_namespace' }),
          expect.objectContaining({ kind: 'create_table' }),
        ]),
      )
      expect(initial.steps.map((step) => step.kind)).toEqual([
        'ensure_namespace',
        'create_table',
        'create_table',
        'create_index',
      ])
      expect(initial.steps[0]).toMatchObject({
        kind: 'ensure_namespace',
        target: {
          kind: 'namespace',
          namespace: [
            { role: 'database', identifier: { spelling: 'db0' } },
            { role: 'schema', identifier: { spelling: schema } },
          ],
        },
      })
      expect(
        initial.steps
          .filter((step) => step.kind === 'create_table')
          .map((step) => step.target.relation.relation.spelling),
      ).toEqual(['posts', 'users'])
      expect(initial.steps.every((step) => !('sql' in step))).toBe(true)

      await db.migrate().execute()
      await expect(db.migrate().dryRun()).resolves.toEqual({ steps: [] })
    })
  })

  it('uses the explicit registration namespace for CRUD, joins, and transactions', async () => {
    await withPostgresDatabase(registeredSchemas, async ({ db, schema }) => {
      await db.migrate().execute()

      const alice = await db
        .insert(Users)
        .values({ email: 'alice@example.com' })
        .executeTakeFirstOrThrow()
      const post = await db
        .insert(Posts)
        .values({ title: 'Hello PostgreSQL', userId: alice.id })
        .executeTakeFirstOrThrow()

      await expect(
        db
          .from(Posts)
          .innerJoin(Users, eq(Posts.userId, Users.id))
          .select([Posts.title, Users.email])
          .where(Users.active, 'eq', true)
          .execute(),
      ).resolves.toEqual([{ title: 'Hello PostgreSQL', email: 'alice@example.com' }])

      await expect(
        db.update(Users).set({ active: false }).where(Users.id, 'eq', alice.id).execute(),
      ).resolves.toHaveLength(1)
      await expect(
        db.delete(Posts).where(Posts.id, 'eq', post.id).execute(),
      ).resolves.toHaveLength(1)

      await db.transaction(async (trx) => {
        await trx.insert(Posts).values({ title: 'Committed', userId: alice.id }).execute()
      })
      await expect(db.from(Posts).selectAll().execute()).resolves.toHaveLength(1)

      await expect(
        db.transaction(async (trx) => {
          await trx
            .insert(Posts)
            .values({ title: 'Rolled back', userId: alice.id })
            .execute()
          throw new Error('rollback')
        }),
      ).rejects.toThrow('rollback')
      await expect(db.from(Posts).selectAll().execute()).resolves.toHaveLength(1)

      expect(schema).toMatch(/^stratom_it_/)
    })
  })

  it('closes idempotently and cleanup removes the isolated schema', async () => {
    const schema = await withPostgresDatabase([Users], async ({ db, schema }) => {
      await db.migrate().execute()
      await db.close()
      await expect(db.close()).resolves.toBeUndefined()
      return schema
    })
    const admin = await createAdminClient()

    try {
      const exists = await admin.query<{ exists: boolean }>(
        'select exists (select 1 from pg_namespace where nspname = $1) as exists',
        [schema],
      )
      expect(exists.rows[0]?.exists).toBe(false)
    } finally {
      await admin.end()
    }
  })
})
