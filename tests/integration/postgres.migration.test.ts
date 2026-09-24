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

const NotNullIndexed = defineTable(
  'not_null_records',
  { id: string(), indexedValue: string() },
  {
    primaryKey: 'id',
    indexes: [{ name: 'not_null_records_indexed_idx', columns: ['indexedValue'] }],
  },
)

const NotNullWithoutIndex = defineTable(
  'not_null_records',
  { id: string(), indexedValue: string() },
  { primaryKey: 'id' },
)

describe('PostgreSQL migration runtime integration', () => {
  beforeAll(waitForPostgres)

  it('drops an ordinary index from a PostgreSQL 18 table with NOT NULL constraints', async ({
    skip,
  }) => {
    await withPostgresDatabase(
      [NotNullIndexed],
      async ({ db, schema, admin, createDatabase }) => {
        const version = await admin.query<{ server_version_num: string }>(
          "select current_setting('server_version_num') as server_version_num",
        )

        if (Number(version.rows[0]!.server_version_num) < 180000) {
          skip()
          return
        }

        await db.migrate().execute()
        const nullConstraints = await admin.query<{ count: string }>(
          `select count(*)::text as count from pg_constraint con
           join pg_class tbl on tbl.oid = con.conrelid
           join pg_namespace n on n.oid = tbl.relnamespace
           where n.nspname = $1 and tbl.relname = 'not_null_records' and con.contype = 'n'`,
          [schema],
        )
        expect(Number(nullConstraints.rows[0]!.count)).toBeGreaterThan(0)

        const destructive = createDatabase([NotNullWithoutIndex], {
          migrationOwnership: [
            { kind: 'relation', relation: NotNullWithoutIndex, shape: 'complete' },
          ],
        })
        const plan = await destructive.migrate().plan()
        expect(plan.steps.map((step) => step.kind)).toEqual(['drop_index'])
        await destructive.migrate().allow('dropIndex').execute()
        await expect(destructive.migrate().plan()).resolves.toEqual({ steps: [] })
      },
    )
  })

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

        const plan = await failing.migrate().plan()
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
        await expect(retry.migrate().plan()).resolves.toEqual({ steps: [] })

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

        const plan = await constructive.migrate().plan()
        expect(plan.steps.map((step) => step.kind)).toEqual([
          'add_column',
          'create_index',
        ])

        await constructive.migrate().execute()
        await expect(constructive.migrate().plan()).resolves.toEqual({ steps: [] })

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

        const destructivePlan = await destructive.migrate().plan()
        expect(destructivePlan.steps.map((step) => step.kind)).toEqual(['drop_table'])
        await destructive.migrate().allow('dropTable').execute()
        await expect(destructive.migrate().plan()).resolves.toEqual({ steps: [] })

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
