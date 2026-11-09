import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import type { MigrateBuilder, MigrationIndexTarget, TableHandle } from '@/index'
import { column, defineTable, reference } from '@/index'
import { isErrorTag } from '@/utils/error'

import { deferred } from '../../helpers/deferredPromise'

import { waitForPostgres } from './postgres.setup'
import type { PostgresDatabaseContext } from './postgresIntegration'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

const Base = defineTable(
  'concurrent_records',
  { id: string(), payload: string() },
  { primaryKey: 'id' },
)

const Indexed = defineTable(
  'concurrent_records',
  { id: string(), payload: string() },
  {
    primaryKey: 'id',
    indexes: [{ name: 'concurrent_payload_idx', columns: ['payload'] }],
  },
)

const Unique = defineTable(
  'concurrent_records',
  { id: string(), payload: string() },
  {
    primaryKey: 'id',
    indexes: [{ name: 'concurrent_payload_idx', columns: ['payload'], unique: true }],
  },
)

const New = defineTable(
  'a_new_records',
  { id: string() },
  { primaryKey: 'id', indexes: [{ name: 'new_id_idx', columns: ['id'] }] },
)

const Constrained = defineTable(
  'concurrent_records',
  { id: string(), payload: pipe(string(), column({ unique: true })) },
  { primaryKey: 'id' },
)

/**
 * Isolates coordination from unrelated native suites while sharing one scope within each
 * test.
 */
function withConcurrentDatabase<const TSchemas extends readonly TableHandle[], TResult>(
  schemas: TSchemas,
  operation: (context: PostgresDatabaseContext<TSchemas>) => Promise<TResult>,
): Promise<TResult> {
  const applicationId = `concurrent-index-integration-${randomUUID()}`
  return withPostgresDatabase(
    schemas,
    (context) =>
      operation({
        ...context,
        createDatabase(additionalSchemas, options = {}) {
          return context.createDatabase(additionalSchemas, { ...options, applicationId })
        },
      }),
    { applicationId },
  )
}

beforeAll(waitForPostgres)

/** Waits for native progress, not just a hook that precedes the database command. */
async function waitForBuild(admin: Client, schema: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    await admin.query('select pg_stat_clear_snapshot()')
    const result = await admin.query(
      'select 1 from pg_stat_progress_create_index p join pg_class c on c.oid = p.relid join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1',
      [schema],
    )

    if (result.rowCount) return
  }

  throw new Error('Concurrent build never entered native progress')
}

function registerCreationCases() {
  it('should create and drop concurrently and reuse a valid matching index', async () => {
    await withConcurrentDatabase([Base], async ({ db, createDatabase }) => {
      await db.migrate().execute()
      const sql: string[] = []
      const indexed = createDatabase([Indexed], {
        hooks: {
          before(event) {
            sql.push(event.sql)
          },
        },
      })

      const migration = indexed.migrate().concurrentIndexes()
      const semantic = await migration.plan()
      const preview = await migration.dryRun()
      expect(preview).toMatchObject({
        atomicity: 'non-atomic',
        phases: [{ transaction: 'forbidden', actionIndexes: [0] }],
      })

      expect(preview.actions[0].statements[0].sql).toContain('index concurrently')

      await expect(migration.execute()).rejects.toMatchObject({
        stage: 'permission',
        outcome: 'unchanged',
      })

      await migration.allowPartialApplication().execute({ statementTimeoutMs: 3_600_000 })
      expect(semantic.steps.map((step) => step.kind)).toEqual(['create_index'])
      await expect(migration.plan()).resolves.toEqual({ steps: [] })
      await migration.execute()

      expect(
        sql.filter((statement) => statement.startsWith('create index concurrently')),
      ).toHaveLength(1)

      await db
        .migrate()
        .concurrentIndexes()
        .allowPartialApplication()
        .allow('dropIndex')
        .execute()

      await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
    })
  })
}

function registerRepairCases() {
  it('should preserve earlier commits, expose real invalid residue, and require exact recovery permission', async () => {
    await withConcurrentDatabase(
      [Base],
      async ({ db, admin, schema, createDatabase }) => {
        await db.migrate().execute()

        await admin.query(
          `insert into ${quoteIdentifier(schema)}.concurrent_records values ('a', 'same'), ('b', 'same')`,
        )

        const desired = createDatabase([New, Unique])
        const migration = desired.migrate().concurrentIndexes().allowPartialApplication()
        const failure: unknown = await migration
          .execute()
          .catch((cause: unknown) => cause)

        expect(failure).toMatchObject({
          outcome: 'partial',
          recovery: { observedValidity: 'invalid', requires: 'inspectAndReplan' },
        })

        const relation = await admin.query<{ name: string | null }>(
          'select to_regclass($1) as name',
          [`${schema}.a_new_records`],
        )

        expect(relation.rows[0].name).not.toBeNull()
        const plan = await migration.plan()
        const step = plan.steps.find((candidate) => candidate.kind === 'create_index')

        if (!step) throw new Error('Expected invalid-index creation intent')

        const preview = await migration.dryRun()
        expect(preview.actions.map((action) => action.repair)).toEqual(['drop', 'create'])

        await assertRepairPermissions(migration, step.target)
        await expect(migration.plan()).resolves.toEqual(plan)

        await admin.query(
          `delete from ${quoteIdentifier(schema)}.concurrent_records where id = 'b'`,
        )

        await migration.allowFor(step.target, 'repairInvalidIndex').execute()
        await expect(migration.plan()).resolves.toEqual({ steps: [] })

        if (!isErrorTag(failure, 'MigrationError'))
          throw new Error('Expected migration diagnostics')

        expect(failure.completedActions?.map((action) => action.actionIndex)).toEqual([
          0, 1,
        ])

        const serialized: unknown = JSON.parse(JSON.stringify(failure))
        expect(serialized).toMatchObject({ recovery: { observedValidity: 'invalid' } })
      },
    )
  })
}

function registerWriteCases() {
  it('should allow application writes while PostgreSQL is executing a real concurrent build', async () => {
    await withConcurrentDatabase(
      [Base],
      async ({ db, admin, schema, createDatabase }) => {
        await db.migrate().execute()
        const writer = new Client({ connectionString: process.env.POSTGRESQL_URL })
        await writer.connect()
        await admin.query('begin')

        await admin.query(
          `insert into ${quoteIdentifier(schema)}.concurrent_records values ('held', 'old writer')`,
        )

        const migration = createDatabase([New, Indexed])
          .migrate()
          .concurrentIndexes()
          .allowPartialApplication()
          .execute()

        const settled = migration.then(
          () => undefined,
          (cause: unknown) => cause,
        )

        try {
          await waitForBuild(writer, schema)

          await writer.query(
            `insert into ${quoteIdentifier(schema)}.concurrent_records values ('application', 'during build')`,
          )
        } finally {
          await admin.query('commit')
          await writer.end()
          await settled
        }

        await migration

        await expect(createDatabase([Indexed]).migrate().plan()).resolves.toEqual({
          steps: [],
        })
      },
    )
  })
}

async function assertRepairPermissions(
  migration: MigrateBuilder,
  target: MigrationIndexTarget,
): Promise<void> {
  await expect(migration.execute()).rejects.toMatchObject({
    stage: 'permission',
    outcome: 'unchanged',
  })

  await expect(migration.allow('dropIndex').execute()).rejects.toMatchObject({
    stage: 'permission',
  })

  await expect(migration.policy('sync').execute()).rejects.toMatchObject({
    stage: 'permission',
  })

  await expect(migration.allowFor(target, 'dropIndex').execute()).rejects.toMatchObject({
    stage: 'permission',
  })

  await expect(
    migration
      .allowFor(
        { ...target, index: { spelling: 'wrong', comparisonKey: 'wrong' } },
        'repairInvalidIndex',
      )
      .execute(),
  ).rejects.toMatchObject({ stage: 'permission' })

  // @ts-expect-error Repair is never a global permission.
  expect(() => migration.allow('repairInvalidIndex')).toThrow('requires allowFor')
}

/** Keeps a writer transaction open so concurrent index commands must wait in PostgreSQL. */
async function withBlockedBuild(
  operation: (context: PostgresDatabaseContext<readonly [typeof Base]>) => Promise<void>,
): Promise<void> {
  await withConcurrentDatabase([Base], async (context) => {
    await context.db.migrate().execute()
    await context.admin.query('begin')

    await context.admin.query(
      `insert into ${quoteIdentifier(context.schema)}.concurrent_records values ('held', 'payload')`,
    )

    try {
      await operation(context)
    } finally {
      await context.admin.query('rollback')
    }
  })
}

function registerInterruptionCases() {
  it('should report possible residue on a native concurrent statement timeout', async () => {
    await withBlockedBuild(async ({ createDatabase }) => {
      const migration = createDatabase([Indexed])
        .migrate()
        .concurrentIndexes()
        .allowPartialApplication()

      await expect(migration.execute({ statementTimeoutMs: 1 })).rejects.toMatchObject({
        outcome: 'partial',
        recovery: { operation: 'create', requires: 'inspectAndReplan' },
      })
    })
  })

  it('should cancel the whole concurrent run and safely replan on the next invocation', async () => {
    await withBlockedBuild(async ({ admin, createDatabase, schema }) => {
      const controller = new AbortController()

      const migration = createDatabase([Indexed])
        .migrate()
        .concurrentIndexes()
        .allowPartialApplication()

      const running = migration.execute({ signal: controller.signal })
      const settled = running.catch((cause: unknown) => cause)
      try {
        await waitForBuild(admin, schema)
      } finally {
        controller.abort()
        await settled
      }

      const failure: unknown = await settled
      expect(failure).toMatchObject({
        outcome: 'unknown',
        recovery: { status: 'unknown' },
      })

      await admin.query('rollback')
      const plan = await migration.plan()
      const target = plan.steps.find((step) => step.kind === 'create_index')?.target

      if (target) migration.allowFor(target, 'repairInvalidIndex')

      await migration.execute()
      await expect(migration.plan()).resolves.toEqual({ steps: [] })
    })
  })
}

function registerAcknowledgmentCases() {
  it('should reobserve a valid index after losing its command acknowledgment', async () => {
    await withConcurrentDatabase([Base], async ({ db, createDatabase }) => {
      await db.migrate().execute()
      let creates = 0
      const desired = createDatabase([New, Indexed], {
        hooks: {
          after(event) {
            if (event.sql.startsWith('create index concurrently') && ++creates === 1)
              throw new Error('lost acknowledgment after native success')
          },
        },
      })

      const migration = desired.migrate().concurrentIndexes().allowPartialApplication()
      const failure: unknown = await migration.execute().catch((cause: unknown) => cause)
      expect(failure).toMatchObject({
        outcome: 'unknown',
        recovery: { status: 'unknown' },
      })

      if (!isErrorTag(failure, 'MigrationError'))
        throw new Error('Expected migration error')

      expect(failure.completedActions?.map((action) => action.actionIndex)).toEqual([
        0, 1,
      ])

      await expect(migration.plan()).resolves.toEqual({ steps: [] })
      await migration.execute()
      expect(creates).toBe(1)
    })
  })
}

function registerValidationCases() {
  it('should report committed work when final validation observes a mismatched definition', async () => {
    await withConcurrentDatabase(
      [Base],
      async ({ db, admin, schema, createDatabase }) => {
        await db.migrate().execute()
        const desired = createDatabase([Indexed], {
          hooks: {
            async after(event) {
              if (!event.sql.startsWith('create index concurrently')) return

              await admin.query(
                `drop index ${quoteIdentifier(schema)}.concurrent_payload_idx`,
              )

              await admin.query(
                `create index concurrent_payload_idx on ${quoteIdentifier(schema)}.concurrent_records (id)`,
              )
            },
          },
        })

        await expect(
          desired.migrate().concurrentIndexes().allowPartialApplication().execute(),
        ).rejects.toMatchObject({ stage: 'validation', outcome: 'partial' })

        await expect(desired.migrate().plan()).rejects.toThrow(
          'Unsupported index definition change',
        )
      },
    )
  })
}

function registerCoordinationCases() {
  it('should retain advisory ownership on one session across a committed phase', async () => {
    await withConcurrentDatabase([Base], async ({ db, createDatabase }) => {
      await db.migrate().execute()
      const reached = deferred()
      const release = deferred()
      const sessions = new Set<string>()
      let transactionOpen = false
      const desired = createDatabase([New, Indexed], {
        hooks: {
          async before(event) {
            sessions.add(event.physicalSession)

            if (event.sql.startsWith('begin')) transactionOpen = true
            if (event.sql === 'commit') transactionOpen = false
            if (!event.sql.startsWith('create index concurrently')) return

            expect(transactionOpen).toBe(false)
            reached.resolve()
            await release.promise
          },
        },
      })

      const first = desired
        .migrate()
        .concurrentIndexes()
        .allowPartialApplication()
        .execute()

      const settled = first.catch((cause: unknown) => cause)
      try {
        await reached.promise

        const second = createDatabase([New, Indexed])
          .migrate()
          .concurrentIndexes()
          .allowPartialApplication()

        await expect(second.execute({ lockTimeoutMs: 0 })).rejects.toMatchObject({
          stage: 'lock',
          outcome: 'unchanged',
        })
      } finally {
        release.resolve()
        await settled
      }

      await first
      expect(sessions.size).toBe(1)
    })
  })
}

function registerUnsupportedCases() {
  it('should reject partitioned targets before writes', async () => {
    await withConcurrentDatabase([New, Indexed], async ({ db, admin, schema }) => {
      await admin.query(
        `create table ${quoteIdentifier(schema)}.concurrent_records (id text not null, payload text not null, primary key (id)) partition by hash (id)`,
      )

      const migration = db.migrate().concurrentIndexes().allowPartialApplication()
      await expect(migration.dryRun()).rejects.toThrow(/partition|ordinary|unsupported/i)
      await expect(migration.execute()).rejects.toMatchObject({ outcome: 'unchanged' })
      const indexes = await admin.query<{ count: string }>(
        'select count(*)::text as count from pg_indexes where schemaname = $1 and indexname = $2',
        [schema, 'concurrent_payload_idx'],
      )

      expect(indexes.rows).toEqual([{ count: '0' }])
      const fresh = await admin.query<{ name: string | null }>(
        'select to_regclass($1) as name',
        [`${schema}.a_new_records`],
      )

      expect(fresh.rows[0].name).toBeNull()
    })
  })
}

function registerTransactionalExceptions() {
  it('should keep new-table indexes in their creation transaction without partial consent', async () => {
    await withConcurrentDatabase([New], async ({ db, createDatabase }) => {
      let open = false
      const statements: string[] = []
      const indexTransactions: boolean[] = []
      const client = createDatabase([New], {
        hooks: {
          before(event) {
            statements.push(event.sql)

            if (event.sql.startsWith('begin')) open = true
            if (event.sql === 'commit') open = false
            if (event.sql.startsWith('create index')) indexTransactions.push(open)
          },
        },
      })

      const migration = client.migrate().concurrentIndexes()
      await expect(migration.dryRun()).resolves.toMatchObject({
        atomicity: 'plan-atomic',
      })

      await migration.execute()
      expect(statements.filter((sql) => sql.startsWith('create index'))).toHaveLength(1)
      expect(indexTransactions).toEqual([true])
      expect(statements.some((sql) => sql.includes('concurrently'))).toBe(false)
      await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
    })
  })

  it('should keep unique constraints transactional under concurrent mode', async () => {
    await withConcurrentDatabase([Base], async ({ db, createDatabase }) => {
      await db.migrate().execute()
      const client = createDatabase([Constrained])
      const migration = client.migrate().concurrentIndexes()
      const preview = await migration.dryRun()
      expect(preview.atomicity).toBe('plan-atomic')
      expect(preview.actions[0]).toMatchObject({ transaction: 'required' })
      expect(preview.actions[0].statements[0].sql).toContain('unique')
      await migration.execute()
      await expect(migration.plan()).resolves.toEqual({ steps: [] })
    })
  })
}

function registerGuardedTailCases() {
  it('should run a guarded column drop in a transaction after its concurrent index drop', async () => {
    const After = defineTable(
      'concurrent_records',
      { id: string() },
      { primaryKey: 'id' },
    )

    await withConcurrentDatabase([Indexed], async ({ db, createDatabase }) => {
      await db.migrate().execute()
      const statements: string[] = []
      const desired = createDatabase([After], {
        hooks: {
          before(event) {
            statements.push(event.sql)
          },
        },
      })

      const migration = desired
        .migrate()
        .concurrentIndexes()
        .allowPartialApplication()
        .allow('dropIndex')

      const preview = await migration.dryRun()
      expect(preview.phases?.map((phase) => phase.transaction)).toEqual([
        'forbidden',
        'required',
      ])

      await migration.execute()
      const concurrent = statements.findIndex((sql) =>
        sql.startsWith('drop index concurrently'),
      )

      const begin = statements.findIndex((sql) => sql.startsWith('begin'))
      const guard = statements.findIndex((sql) => sql.startsWith('lock table'))
      expect(concurrent).toBeGreaterThanOrEqual(0)
      expect(begin).toBeGreaterThan(concurrent)
      expect(guard).toBeGreaterThan(begin)
      await expect(migration.plan()).resolves.toEqual({ steps: [] })
    })
  })
}

function registerGuardedTailFailureCases() {
  it('should preserve a committed concurrent drop when a later data guard fails', async () => {
    const After = defineTable(
      'concurrent_records',
      { id: string() },
      { primaryKey: 'id' },
    )

    await withConcurrentDatabase(
      [Indexed],
      async ({ db, createDatabase, schema, admin }) => {
        await db.migrate().execute()

        await admin.query(
          `insert into ${quoteIdentifier(schema)}.concurrent_records values ('retained', 'non-null data')`,
        )

        const migration = createDatabase([After])
          .migrate()
          .concurrentIndexes()
          .allowPartialApplication()
          .allow('dropIndex')

        const failure: unknown = await migration
          .execute()
          .catch((cause: unknown) => cause)

        expect(failure).toMatchObject({
          outcome: 'partial',
          stage: 'precondition',
          completedActions: [{ actionIndex: 0 }],
        })

        const index = await admin.query<{ name: string | null }>(
          'select to_regclass($1) as name',
          [`${schema}.concurrent_payload_idx`],
        )

        expect(index.rows[0].name).toBeNull()
        const rows = await admin.query<{ payload: string }>(
          `select payload from ${quoteIdentifier(schema)}.concurrent_records`,
        )

        expect(rows.rows).toEqual([{ payload: 'non-null data' }])

        await expect(migration.execute()).rejects.toMatchObject({
          outcome: 'unchanged',
          stage: 'precondition',
        })
      },
    )
  })
}

function registerDependencyCases() {
  it('should create a referenced concurrent unique index before attaching a foreign key', async () => {
    const Child = defineTable(
      'concurrent_children',
      { id: string(), payload: reference(Unique, 'payload') },
      { primaryKey: 'id' },
    )

    await withConcurrentDatabase([Base], async ({ db, createDatabase }) => {
      await db.migrate().execute()
      const desired = createDatabase([Unique, Child])
      const migration = desired.migrate().concurrentIndexes().allowPartialApplication()
      const preview = await migration.dryRun()
      expect(preview.phases?.map((phase) => phase.transaction)).toEqual([
        'required',
        'forbidden',
        'required',
      ])

      await migration.execute()
      await expect(migration.plan()).resolves.toEqual({ steps: [] })
    })
  })
}

describe('PostgreSQL concurrent index integration', () => {
  registerCreationCases()
  registerRepairCases()
  registerWriteCases()
  registerInterruptionCases()
  registerAcknowledgmentCases()
  registerValidationCases()
  registerCoordinationCases()
  registerUnsupportedCases()
  registerTransactionalExceptions()
  registerGuardedTailCases()
  registerGuardedTailFailureCases()
  registerDependencyCases()
})
