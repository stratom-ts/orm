import { randomUUID } from 'node:crypto'
import { pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import { column, defineTable } from '@/index'

import { waitForPostgres } from './postgres.setup'
import type { SessionEvent } from './postgresIntegration'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

const RollbackBefore = defineTable(
  'rollback_records',
  { id: string(), payload: string() },
  { primaryKey: 'id', indexes: [{ name: 'rollback_payload_idx', columns: ['payload'] }] },
)

const RollbackAfter = defineTable(
  'rollback_records',
  {
    id: string(),
    payload: string(),
    addedOne: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'one' } }),
    ),
    addedTwo: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'two' } }),
    ),
  },
  { primaryKey: 'id', indexes: [{ name: 'rollback_payload_idx', columns: ['payload'] }] },
)

const ManagedBaseline = defineTable(
  'managed_records',
  { id: string(), payload: string(), legacy: string() },
  {
    primaryKey: 'id',
    indexes: [{ name: 'managed_legacy_idx', columns: ['legacy'] }],
  },
)

const ManagedConstructive = defineTable(
  'managed_records',
  {
    id: string(),
    payload: string(),
    legacy: string(),
    added: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'added' } }),
    ),
  },
  {
    primaryKey: 'id',
    indexes: [
      { name: 'managed_legacy_idx', columns: ['legacy'] },
      { name: 'managed_added_idx', columns: ['added'] },
    ],
  },
)

describe('PostgreSQL migration runtime integration', () => {
  beforeAll(waitForPostgres)

  it('rolls back a partial DDL attempt and converges on retry without data loss', async () => {
    await withPostgresDatabase(
      [RollbackBefore],
      async ({ db, schema, admin, createDatabase }) => {
        const rowId = randomUUID()
        await db.migrate().execute()
        await db
          .insert(RollbackBefore)
          .values({ id: rowId, payload: 'retained' })
          .execute()
        const indexesBefore = await admin.query<{
          indexdef: string
          indexname: string
        }>(
          `select indexname, indexdef from pg_indexes
           where schemaname = $1 and tablename = 'rollback_records'
           order by indexname`,
          [schema],
        )

        let ddlCount = 0
        const statements: SessionEvent[] = []
        const failing = createDatabase([RollbackAfter], {
          hooks: {
            before(event) {
              if (!/^(?:create|alter|drop)\s/i.test(event.sql)) return

              statements.push(event)
              ddlCount++
              if (ddlCount === 2) throw new Error('injected second DDL failure')
            },
          },
        })

        const plan = await failing.migrate().dryRun()
        expect(plan.steps.filter((step) => step.kind === 'add_column')).toHaveLength(2)
        await expect(failing.migrate().execute()).rejects.toMatchObject({
          _tag: 'MigrationError',
          stage: 'ddl',
          outcome: 'rolledBack',
        })

        expect(statements).toHaveLength(2)
        const columnsAfterFailure = await admin.query<{ column_name: string }>(
          `select column_name from information_schema.columns
         where table_schema = $1 and table_name = 'rollback_records'
         order by ordinal_position`,
          [schema],
        )
        expect(columnsAfterFailure.rows.map(({ column_name }) => column_name)).toEqual([
          'id',
          'payload',
        ])
        const indexesAfterFailure = await admin.query<{
          indexdef: string
          indexname: string
        }>(
          `select indexname, indexdef from pg_indexes
           where schemaname = $1 and tablename = 'rollback_records'
           order by indexname`,
          [schema],
        )
        expect(indexesAfterFailure.rows).toEqual(indexesBefore.rows)
        expect(indexesAfterFailure.rows.map(({ indexname }) => indexname)).toContain(
          'rollback_payload_idx',
        )
        const original = await admin.query<{ id: string; payload: string }>(
          `select id, payload from ${quoteIdentifier(schema)}.${quoteIdentifier('rollback_records')}`,
        )
        expect(original.rows).toEqual([{ id: rowId, payload: 'retained' }])

        const retry = createDatabase([RollbackAfter])
        await retry.migrate().execute()
        await expect(retry.migrate().dryRun()).resolves.toEqual({ steps: [] })

        const afterRetry = await admin.query<{
          id: string
          payload: string
          addedOne: string
          addedTwo: string
        }>(
          `select id, payload, "addedOne", "addedTwo"
         from ${quoteIdentifier(schema)}.${quoteIdentifier('rollback_records')}`,
        )
        expect(afterRetry.rows).toEqual([
          { id: rowId, payload: 'retained', addedOne: 'one', addedTwo: 'two' },
        ])
      },
    )
  })

  it('executes constructive and an explicitly permitted absent-relation plan', async () => {
    await withPostgresDatabase(
      [ManagedBaseline],
      async ({ db, schema, admin, createDatabase }) => {
        await db.migrate().execute()
        await admin.query(
          `create table ${quoteIdentifier(schema)}.${quoteIdentifier('managed_orphan')} (value text)`,
        )
        await db
          .insert(ManagedBaseline)
          .values({ id: 'kept', payload: 'payload', legacy: 'legacy' })
          .execute()

        const constructive = createDatabase([ManagedConstructive], {
          migrationOwnership: [
            { kind: 'relation', relation: ManagedConstructive, shape: 'additive' },
          ],
        })

        const plan = await constructive.migrate().dryRun()
        expect(plan.steps.map((step) => step.kind)).toEqual([
          'add_column',
          'create_index',
        ])
        await constructive.migrate().execute()
        await expect(constructive.migrate().dryRun()).resolves.toEqual({ steps: [] })

        const destructive = createDatabase([] as const, {
          migrationOwnership: [
            {
              kind: 'absentRelation',
              relation: {
                namespace: [{ role: 'schema', spelling: schema }],
                relation: 'managed_orphan',
              },
            },
          ],
        })

        const destructivePlan = await destructive.migrate().dryRun()
        expect(destructivePlan.steps.map((step) => step.kind)).toEqual(['drop_table'])
        await destructive.migrate().allow('dropTable').execute()
        await expect(destructive.migrate().dryRun()).resolves.toEqual({ steps: [] })

        const preserved = await admin.query<{
          id: string
          payload: string
          legacy: string
          added: string
        }>(
          `select id, payload, legacy, added
           from ${quoteIdentifier(schema)}.${quoteIdentifier('managed_records')}`,
        )
        expect(preserved.rows).toEqual([
          { id: 'kept', payload: 'payload', legacy: 'legacy', added: 'added' },
        ])

        const removed = await admin.query<{ relation: string | null }>(
          'select to_regclass($1)::text as relation',
          [`${schema}.managed_orphan`],
        )
        expect(removed.rows).toEqual([{ relation: null }])
      },
    )
  })
})
