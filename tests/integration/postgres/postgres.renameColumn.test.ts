import { nullable, pipe, string } from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import { column, defineTable, reference } from '@/index'

import { waitForPostgres } from './postgres.setup'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)
const User = defineTable(
  'rename_users',
  { id: string(), fullName: nullable(string()) },
  { primaryKey: 'id', indexes: [{ columns: ['fullName', 'id'] }] },
)

it('should preserve native values and historical indexes and converge without retained intent', async () => {
  await withPostgresDatabase([User], async ({ db, admin, schema }) => {
    const table = `${quoteIdentifier(schema)}."rename_users"`
    await admin.query(
      `create table ${table}(id TEXT primary key not null, "displayName" TEXT); insert into ${table} values ('1','ordinary'), ('2','\u4f60\u597d\ud83d\ude80'), ('3',null); create index historical_name on ${table}("displayName",id)`,
    )

    const migration = db
      .migrate()
      .renameColumn({ table: User, from: 'displayName', to: 'fullName' })

    expect((await migration.plan()).steps.map((step) => step.kind)).toEqual([
      'rename_column',
    ])

    const preview = await migration.dryRun()
    expect(preview).toMatchObject({
      atomicity: 'plan-atomic',
      preconditions: [
        { kind: 'column_rename', from: 'displayName', sourceStepIndexes: [0] },
      ],
    })

    expect(preview.actions[0].statements[0].sql).toContain(
      'rename column "displayName" to "fullName"',
    )

    expect(
      (await admin.query(`select "displayName" from ${table} order by id`)).rows.map(
        (row: { displayName: string | null }) => row.displayName,
      ),
    ).toEqual(['ordinary', '\u4f60\u597d\ud83d\ude80', null])

    await migration.execute()

    expect(
      (await admin.query(`select "fullName" from ${table} order by id`)).rows.map(
        (row: { fullName: string | null }) => row.fullName,
      ),
    ).toEqual(['ordinary', '\u4f60\u597d\ud83d\ude80', null])

    expect(await migration.plan()).toEqual({ steps: [] })
    expect(await db.migrate().plan()).toEqual({ steps: [] })
    expect((await migration.dryRun()).actions).toEqual([])
    await migration.execute()
  })
})

it('should check residual NOT NULL against the original physical address', async () => {
  const Required = defineTable(
    'rename_users',
    { id: string(), fullName: string() },
    { primaryKey: 'id' },
  )

  await withPostgresDatabase([Required], async ({ db, admin, schema }) => {
    const table = `${quoteIdentifier(schema)}."rename_users"`
    await admin.query(
      `create table ${table}(id TEXT primary key not null, "displayName" TEXT); insert into ${table} values ('1','kept')`,
    )

    const migration = db
      .migrate()
      .renameColumn({ table: Required, from: 'displayName', to: 'fullName' })

    expect((await migration.dryRun()).preconditions).toContainEqual(
      expect.objectContaining({ kind: 'column_has_no_nulls', column: 'displayName' }),
    )

    await migration.execute()

    expect((await admin.query(`select "fullName" from ${table}`)).rows).toEqual([
      { fullName: 'kept' },
    ])
  })
})

it('should roll back the native rename when final validation fails', async () => {
  let renamed = false
  await withPostgresDatabase(
    [User],
    async ({ db, admin, schema }) => {
      const table = `${quoteIdentifier(schema)}."rename_users"`
      await admin.query(
        `create table ${table}(id TEXT primary key not null, "displayName" TEXT); insert into ${table} values ('1','kept'); create index historical_name on ${table}("displayName",id)`,
      )

      await expect(
        db
          .migrate()
          .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
          .execute(),
      ).rejects.toMatchObject({ stage: 'validation', outcome: 'rolledBack' })

      expect((await admin.query(`select "displayName" from ${table}`)).rows).toEqual([
        { displayName: 'kept' },
      ])
    },
    {
      hooks: {
        after(event) {
          if (event.sql.includes('rename column')) renamed = true
        },
        before(event) {
          if (renamed && event.sql.includes('current_database'))
            throw new Error('forced final validation failure')
        },
      },
    },
  )
})

it('should preserve renamed primary keys, inbound foreign keys, and self references outside desired registration', async () => {
  const Parent = defineTable('parent', { fullName: string() }, { primaryKey: 'fullName' })
  await withPostgresDatabase(
    [Parent],
    async ({ db, admin, schema, alternateSchema }) => {
      const parent = `${quoteIdentifier(schema)}.parent`
      const child = `${quoteIdentifier(alternateSchema)}.child`
      await admin.query(
        `create table ${parent}("displayName" TEXT primary key not null, parent TEXT references ${parent}("displayName")); create table ${child}(value TEXT references ${parent}("displayName")); insert into ${parent} values('kept','kept'); insert into ${child} values('kept')`,
      )

      const migration = db
        .migrate()
        .renameColumn({ table: Parent, from: 'displayName', to: 'fullName' })

      await migration.execute()

      expect((await admin.query(`select "fullName",parent from ${parent}`)).rows).toEqual(
        [{ fullName: 'kept', parent: 'kept' }],
      )

      await admin.query(`insert into ${child} values('kept')`)

      await expect(admin.query(`insert into ${child} values('missing')`)).rejects.toThrow(
        /./,
      )

      expect(await migration.plan()).toEqual({ steps: [] })
      expect(await db.migrate().plan()).toEqual({ steps: [] })
    },
    { migrationOwnership: [{ kind: 'relation', relation: Parent, shape: 'additive' }] },
  )
})

it('should lock rename targets before authoritative observation and respect lock deadlines', async () => {
  const calls: string[] = []
  await withPostgresDatabase(
    [User],
    async ({ db, admin, schema }) => {
      const table = `${quoteIdentifier(schema)}."rename_users"`
      await admin.query(
        `create table ${table}(id TEXT primary key not null, "displayName" TEXT); insert into ${table} values ('1','kept'); create index historical_name on ${table}("displayName",id)`,
      )

      await admin.query('begin')

      try {
        await admin.query(`lock table ${table} in share mode`)

        await expect(
          db
            .migrate()
            .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
            .execute({ lockTimeoutMs: 80 }),
        ).rejects.toMatchObject({ stage: 'lock' })
      } finally {
        await admin.query('rollback')
      }

      expect((await admin.query(`select "displayName" from ${table}`)).rows).toEqual([
        { displayName: 'kept' },
      ])

      calls.length = 0

      await db
        .migrate()
        .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
        .execute()

      const lock = calls.findIndex((sql) => /^lock table/.test(sql))
      const rename = calls.findIndex((sql) => sql.includes('rename column'))
      expect(lock).toBeGreaterThan(-1)
      expect(rename).toBeGreaterThan(lock)

      expect(
        calls.slice(lock + 1, rename).some((sql) => sql.includes('current_database')),
      ).toBe(true)

      expect(calls.filter((sql) => /^commit$/.test(sql))).toHaveLength(1)
    },
    {
      hooks: {
        before(event) {
          calls.push(event.sql)
        },
      },
    },
  )
})

it('should reject opaque views and inheritance dependencies before writes', async () => {
  await withPostgresDatabase([User], async ({ db, admin, schema }) => {
    const table = `${quoteIdentifier(schema)}."rename_users"`
    await admin.query(
      `create table ${table}(id TEXT primary key not null, "displayName" TEXT); insert into ${table} values ('1','kept'); create view ${quoteIdentifier(schema)}.opaque as select "displayName" from ${table}`,
    )

    await expect(
      db
        .migrate()
        .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
        .execute(),
    ).rejects.toMatchObject({ stage: 'planning', outcome: 'unchanged' })

    expect((await admin.query(`select "displayName" from ${table}`)).rows).toEqual([
      { displayName: 'kept' },
    ])

    await admin.query(
      `drop view ${quoteIdentifier(schema)}.opaque; create table ${quoteIdentifier(schema)}.inherited() inherits (${table})`,
    )

    await expect(
      db
        .migrate()
        .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
        .execute(),
    ).rejects.toMatchObject({ stage: 'planning', outcome: 'unchanged' })
  })
})

it.each(['commit', 'unlock'] as const)(
  'should preserve native outcomes when %s acknowledgment fails after a rename',
  async (failure) => {
    const cause = new Error(`forced ${failure} acknowledgment failure`)
    let renames = 0
    await withPostgresDatabase(
      [User],
      async ({ db, admin, schema }) => {
        const table = `${quoteIdentifier(schema)}."rename_users"`
        await admin.query(
          `create table ${table}(id TEXT primary key not null, "displayName" TEXT); insert into ${table} values ('1','kept'); create index historical_name on ${table}("displayName",id)`,
        )

        const error = await db
          .migrate()
          .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
          .execute()
          .catch((error: unknown) => error)

        expect(error).toMatchObject({
          stage: failure,
          outcome: failure === 'commit' ? 'unknown' : 'applied',
          retryable: false,
        })

        expect((await admin.query(`select "fullName" from ${table}`)).rows).toEqual([
          { fullName: 'kept' },
        ])

        expect(renames).toBe(1)
      },
      {
        hooks: {
          before(event) {
            if (failure === 'unlock' && event.sql.includes('pg_advisory_unlock('))
              throw cause
          },
          after(event) {
            if (event.sql.includes('rename column')) renames++
            if (failure === 'commit' && event.sql === 'commit') throw cause
          },
        },
      },
    )
  },
)

it('should allow unrelated views while rejecting inherited inbound sources', async () => {
  const Parent = defineTable('parent', { fullName: string() }, { primaryKey: 'fullName' })
  await withPostgresDatabase([Parent], async ({ db, admin, schema }) => {
    const parent = `${quoteIdentifier(schema)}.parent`
    const child = `${quoteIdentifier(schema)}.child`
    await admin.query(
      `create table ${parent}("displayName" TEXT primary key not null); insert into ${parent} values('kept'); create view ${quoteIdentifier(schema)}.unrelated as select 1 as value; create table ${child}(value TEXT references ${parent}("displayName")); create table ${quoteIdentifier(schema)}.inherited() inherits (${child})`,
    )

    const migration = db
      .migrate()
      .renameColumn({ table: Parent, from: 'displayName', to: 'fullName' })

    await expect(migration.execute()).rejects.toMatchObject({
      stage: 'planning',
      outcome: 'unchanged',
    })

    expect((await admin.query(`select "displayName" from ${parent}`)).rows).toEqual([
      { displayName: 'kept' },
    ])

    await admin.query(`drop table ${quoteIdentifier(schema)}.inherited`)
    await migration.execute()

    expect((await admin.query(`select "fullName" from ${parent}`)).rows).toEqual([
      { fullName: 'kept' },
    ])
  })
})

it('should preserve unique keys, local foreign-key names, and authored indexes across repeat runs', async () => {
  const Owner = defineTable('owners', { id: string() }, { primaryKey: 'id' })
  const Member = defineTable(
    'members',
    {
      id: string(),
      fullName: pipe(nullable(reference(Owner, 'id')), column({ unique: true })),
    },
    {
      primaryKey: 'id',
      indexes: [{ name: 'authored_members', columns: ['fullName', 'id'] }],
    },
  )

  await withPostgresDatabase([Member, Owner], async ({ db, admin, schema }) => {
    const members = `${quoteIdentifier(schema)}.members`
    const owners = `${quoteIdentifier(schema)}.owners`
    await admin.query(
      `create table ${owners}(id TEXT primary key not null); insert into ${owners} values('kept'); create table ${members}(id TEXT primary key not null, "displayName" TEXT, constraint old_unique unique("displayName"), constraint old_foreign foreign key("displayName") references ${owners}(id)); create index authored_members on ${members}("displayName",id); insert into ${members} values('1','kept')`,
    )

    const migration = db
      .migrate()
      .renameColumn({ table: Member, from: 'displayName', to: 'fullName' })

    expect((await migration.plan()).steps.map((step) => step.kind)).toEqual([
      'rename_column',
    ])

    await migration.execute()

    expect((await admin.query(`select "fullName" from ${members}`)).rows).toEqual([
      { fullName: 'kept' },
    ])

    expect(await migration.plan()).toEqual({ steps: [] })
    expect(await db.migrate().plan()).toEqual({ steps: [] })

    expect(
      (
        await admin.query(
          "select conname from pg_constraint where conrelid=$1::regclass and contype in ('p','u','f') order by conname",
          [members],
        )
      ).rows,
    ).toEqual([
      { conname: 'members_pkey' },
      { conname: 'old_foreign' },
      { conname: 'old_unique' },
    ])
  })
})

it('should retain the DDL failure and rollback cleanup evidence after native rename', async () => {
  const Required = defineTable(
    'rename_users',
    { id: string(), fullName: string() },
    { primaryKey: 'id' },
  )

  const primary = new Error('forced later DDL failure')
  const cleanup = new Error('forced rollback acknowledgment failure')
  await withPostgresDatabase(
    [Required],
    async ({ db, admin, schema }) => {
      const table = `${quoteIdentifier(schema)}.rename_users`
      await admin.query(
        `create table ${table}(id TEXT primary key not null, "displayName" TEXT); insert into ${table} values('1','kept')`,
      )

      const error = await db
        .migrate()
        .renameColumn({ table: Required, from: 'displayName', to: 'fullName' })
        .execute()
        .catch((error: unknown) => error)

      expect(error).toMatchObject({
        stage: 'ddl',
        outcome: 'unknown',
        actionIndex: 1,
        sourceStepIndexes: [1],
        defect: true,
        cause: primary,
        cleanupFailures: [{ stage: 'rollback', cause: cleanup }],
      })

      expect((await admin.query(`select "displayName" from ${table}`)).rows).toEqual([
        { displayName: 'kept' },
      ])
    },
    {
      hooks: {
        before(event) {
          if (event.sql.includes('set not null')) throw primary
        },
        after(event) {
          if (event.sql === 'rollback') throw cleanup
        },
      },
    },
  )
})
