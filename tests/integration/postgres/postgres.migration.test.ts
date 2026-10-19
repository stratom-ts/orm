import { randomUUID } from 'node:crypto'
import type { Client, QueryResult } from 'pg'
import { nullable, pipe, string, uuid } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import { column, defineTable, reference } from '@/index'

import { waitForPostgres } from './postgres.setup'
import type { PostgresDatabaseContext, SessionEvent } from './postgresIntegration'
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

beforeAll(waitForPostgres)

/** Confirms fresh inferred columns and their foreign key exist in the native catalog. */
async function assertInferredUuidCatalog(admin: Client, schema: string) {
  const types = await admin.query<{
    table_name: string
    column_name: string
    data_type: string
  }>(
    `select table_name, column_name, data_type from information_schema.columns
     where table_schema = $1 and table_name in ('inferred_uuid_parent', 'inferred_uuid_child')
     order by table_name, ordinal_position`,
    [schema],
  )

  expect(types.rows).toEqual([
    { table_name: 'inferred_uuid_child', column_name: 'id', data_type: 'uuid' },
    { table_name: 'inferred_uuid_child', column_name: 'parentId', data_type: 'uuid' },
    { table_name: 'inferred_uuid_parent', column_name: 'id', data_type: 'uuid' },
    { table_name: 'inferred_uuid_parent', column_name: 'optionalId', data_type: 'uuid' },
  ])

  const foreignKeys = await admin.query<{ count: string }>(
    `select count(*)::text as count from pg_constraint con
     join pg_class tbl on tbl.oid = con.conrelid
     join pg_namespace ns on ns.oid = tbl.relnamespace
     where ns.nspname = $1 and tbl.relname = 'inferred_uuid_child' and con.contype = 'f'`,
    [schema],
  )

  expect(foreignKeys.rows).toEqual([{ count: '1' }])
}

/** Defines the old, inferred, and pinned versions of one legacy payload table. */
function legacyUuidTables(legacyType: string) {
  const Legacy = defineTable(
    'legacy_uuid_payload',
    {
      id: string(),
      payload: pipe(string(), column({ physicalType: { postgresql: legacyType } })),
    },
    { primaryKey: 'id' },
  )

  const Desired = defineTable(
    'legacy_uuid_payload',
    { id: string(), payload: pipe(string(), uuid()) },
    { primaryKey: 'id' },
  )

  const Pinned = defineTable(
    'legacy_uuid_payload',
    {
      id: string(),
      payload: pipe(
        string(),
        uuid(),
        column({ physicalType: { postgresql: legacyType } }),
      ),
    },
    { primaryKey: 'id' },
  )

  return { Legacy, Desired, Pinned }
}

/** Confirms a failed conversion preserved both legacy data and physical storage. */
async function assertLegacyUuidRetained(
  admin: Client,
  schema: string,
  legacyType: string,
  payload: string,
) {
  const retained = await admin.query<{ id: string; payload: string; data_type: string }>(
    `select row.id, row.payload, cols.data_type
     from ${quoteIdentifier(schema)}.${quoteIdentifier('legacy_uuid_payload')} row
     cross join information_schema.columns cols
     where cols.table_schema = $1 and cols.table_name = 'legacy_uuid_payload'
       and cols.column_name = 'payload'`,
    [schema],
  )

  expect(retained.rows).toEqual([
    {
      id: 'existing',
      payload,
      data_type: legacyType === 'text' ? 'text' : 'character varying',
    },
  ])
}

describe('PostgreSQL inferred UUID migration', () => {
  it('migrates inferred UUID keys and references, maps supplied strings, and converges', async () => {
    const Parent = defineTable(
      'inferred_uuid_parent',
      { id: pipe(string(), uuid()), optionalId: nullable(pipe(string(), uuid())) },
      { primaryKey: 'id' },
    )

    const Child = defineTable(
      'inferred_uuid_child',
      { id: pipe(string(), uuid()), parentId: reference(Parent, 'id') },
      { primaryKey: 'id' },
    )

    await withPostgresDatabase([Child, Parent], async ({ db, admin, schema }) => {
      await db.migrate().execute()
      await assertInferredUuidCatalog(admin, schema)

      const uppercase = '550E8400-E29B-41D4-A716-446655440000'
      const canonical = uppercase.toLowerCase()
      const childId = '660e8400-e29b-41d4-a716-446655440000'
      await db.insert(Parent).values({ id: uppercase, optionalId: null }).execute()
      await db.insert(Child).values({ id: childId, parentId: uppercase }).execute()

      expect(await db.from(Parent).execute()).toEqual([
        { id: canonical, optionalId: null },
      ])

      expect(await db.from(Child).execute()).toEqual([
        { id: childId, parentId: canonical },
      ])

      await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
    })
  })
})

describe('PostgreSQL legacy UUID migration limits', () => {
  it.each(['text', 'varchar(36)'])(
    'plans a legacy %s conversion but rolls back a generated ALTER without USING',
    async (legacyType) => {
      const { Legacy, Desired, Pinned } = legacyUuidTables(legacyType)

      await withPostgresDatabase(
        [Legacy],
        async ({ db, admin, schema, createDatabase }) => {
          await db.migrate().execute()
          const payload = '550E8400-E29B-41D4-A716-446655440000'
          await db.insert(Legacy).values({ id: 'existing', payload }).execute()

          const desired = createDatabase([Desired])
          expect(await desired.migrate().plan()).toEqual({
            steps: [
              expect.objectContaining({ kind: 'alter_column_type', dataType: 'uuid' }),
            ],
          })

          const preview = await desired.migrate().dryRun()
          const sql = preview.actions.flatMap((action) =>
            action.statements.map((statement) => statement.sql),
          )

          expect(sql).toEqual([
            expect.stringMatching(/alter table .* alter column "payload" type uuid$/i),
          ])

          expect(sql[0]).not.toMatch(/\busing\b/i)

          await expect(desired.migrate().execute()).rejects.toMatchObject({
            _tag: 'MigrationError',
            stage: 'ddl',
            outcome: 'rolledBack',
          })

          await assertLegacyUuidRetained(admin, schema, legacyType, payload)

          const pinned = createDatabase([Pinned])
          await expect(pinned.migrate().plan()).resolves.toEqual({ steps: [] })
        },
      )
    },
  )
})

describe('PostgreSQL migration runtime integration', () => {
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
})

describe('PostgreSQL migration runtime integration: rolls back a partial DDL attempt and converges on retry without data loss', () => {
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

        const { failing, statements } = createFailingMigrationDatabase(createDatabase)

        const plan = await failing.migrate().plan()
        expect(plan.steps.filter((step) => step.kind === 'add_column')).toHaveLength(2)

        await expect(failing.migrate().execute()).rejects.toMatchObject({
          _tag: 'MigrationError',
          stage: 'ddl',
          outcome: 'rolledBack',
        })

        expect(statements).toHaveLength(2)
        await assertRollbackPreservesCatalogAndRows(admin, schema, indexesBefore, rowId)

        await assertMigrationRetry(createDatabase, admin, schema, rowId)
      },
    )
  })
})

describe('PostgreSQL constructive migration integration', () => {
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

        await assertAbsentRelationMigration(createDatabase, schema)

        await assertConstructiveRowsAndOrphanRemoval(admin, schema)
      },
    )
  })
})

/**
 * Checks preserved row values after constructive migration and confirms the
 * declared-absent relation was removed.
 *
 * @param admin - Administrative PostgreSQL client that owns isolated namespace setup and
 *   cleanup.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 */
async function assertConstructiveRowsAndOrphanRemoval(admin: Client, schema: string) {
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
}

/**
 * Retries the permitted migration and checks data retention and second-plan convergence.
 *
 * @param createDatabase - Factory for an additional database client in the test
 *   namespace.
 * @param admin - Administrative PostgreSQL client that owns isolated namespace setup and
 *   cleanup.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 * @param rowId - Native row identifier supplied by the schema fixture.
 */
async function assertMigrationRetry(
  createDatabase: PostgresDatabaseContext<readonly []>['createDatabase'],
  admin: Client,
  schema: string,
  rowId: string,
) {
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
}

/**
 * Executes an explicitly permitted absent-relation plan and checks second-plan
 * convergence.
 *
 * @param createDatabase - Factory for an additional database client in the test
 *   namespace.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 */
async function assertAbsentRelationMigration(
  createDatabase: PostgresDatabaseContext<readonly []>['createDatabase'],
  schema: string,
) {
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
}

/**
 * Creates a client whose selected DDL statement fails inside the real migration
 * transaction.
 *
 * @param createDatabase - Factory for an additional database client in the test
 *   namespace.
 *
 * @returns A client whose selected DDL statement fails inside the real migration
 *   transaction.
 */
function createFailingMigrationDatabase(
  createDatabase: PostgresDatabaseContext<readonly []>['createDatabase'],
) {
  let ddlCount = 0
  const statements: SessionEvent[] = []
  const failing = createDatabase([RollbackAfter], {
    hooks: {
      /** Observes a physical SQL call before native execution. */
      before(event) {
        if (!/^(?:create|alter|drop)\s/i.test(event.sql)) return

        statements.push(event)
        ddlCount++

        if (ddlCount === 2) throw new Error('injected second DDL failure')
      },
    },
  })

  return { failing, statements }
}

/**
 * Checks original columns, indexes, and row data after migration transaction rollback.
 *
 * @param admin - Administrative PostgreSQL client that owns isolated namespace setup and
 *   cleanup.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 * @param indexesBefore - Observed index definitions captured before the migration.
 * @param rowId - Native row identifier supplied by the schema fixture.
 */
async function assertRollbackPreservesCatalogAndRows(
  admin: Client,
  schema: string,
  indexesBefore: QueryResult<{ indexdef: string; indexname: string }>,
  rowId: string,
) {
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
}
