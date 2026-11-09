import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import type { DatabaseSync } from 'node:sqlite'
import { integer, nullable, number, pipe, string } from 'valibot'
import { expect, it, vi } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationProgram } from '@/ddl/migrationProgram'
import { column, defineTable, reference, resolveDialect, sqliteDialect } from '@/index'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import type { Executor } from '@/query'
import type { TableHandle } from '@/types'

import { inTransaction } from '../../helpers/nativeTransaction'

import { withSqliteDatabase } from './sqliteIntegration'
import { closeSqliteProviders } from './sqliteNativeLifetime'

const main = [{ role: 'database' as const, spelling: 'main' }]
const completeMain: MigrationOwnershipDeclaration[] = [
  { kind: 'completeNamespace', namespace: main },
]

/** Records DDL and data mutation attempts while forwarding native database calls. */
function trackNativeMutations(native: DatabaseSync): string[] {
  const attempts: string[] = []
  const nativeExec = native.exec.bind(native)
  const nativePrepare = native.prepare.bind(native)
  const isMutation = /^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|REPLACE)\b/i

  vi.spyOn(native, 'exec').mockImplementation((sql) => {
    if (isMutation.test(sql)) attempts.push(sql)

    return nativeExec(sql)
  })

  vi.spyOn(native, 'prepare').mockImplementation((sql, options) => {
    if (isMutation.test(sql)) attempts.push(sql)

    return nativePrepare(sql, options)
  })

  return attempts
}

/** Asserts planning rejects before migration execution can begin. */
async function expectPlanningFailure(run: () => Promise<unknown>, message?: string) {
  const failure = await run().catch((cause: unknown) => cause)

  expect(failure).toMatchObject({
    stage: 'planning',
    outcome: 'unchanged',
  })

  expect((failure as Error).message).toMatch(/migration planning failed/i)
  expect((failure as Error).message).toContain(message ?? '')
}

/** Asserts SQLite lowering rejects a Migration Program before execution can begin. */
async function expectLoweringFailure(run: () => Promise<unknown>, message?: string) {
  const failure = await run().catch((cause: unknown) => cause)

  expect(failure).toMatchObject({
    stage: 'lowering',
    outcome: 'unchanged',
  })

  expect((failure as Error).message).toContain(message ?? '')
}

/** Checks the retained runtime stage, outcome, and primary diagnostic. */
async function expectRuntimeFailure(
  run: () => Promise<unknown>,
  stage: string,
  outcome: string,
  causeMessage: string,
  cleanupMessage: string,
): Promise<void> {
  const failure = await run().catch((cause: unknown) => cause)
  expect(failure).toMatchObject({
    stage,
    outcome,
    message: expect.stringContaining(`SQLite migration ${stage} failed`) as string,
    cause: { message: causeMessage },
    cleanupFailures: [{ stage: 'sessionCleanup', cause: { message: cleanupMessage } }],
  })
}

const additive: MigrationOwnershipDeclaration[] = [
  { kind: 'relation', relation: { relation: 'parent' }, shape: 'additive' },
  { kind: 'relation', relation: { relation: 'owners' }, shape: 'additive' },
]

const Owner = defineTable(
  'owners',
  { id: pipe(number(), integer()) },
  { primaryKey: 'id' },
)

const Parent = defineTable(
  'parent',
  {
    id: pipe(
      number(),
      integer(),
      column({ generation: { kind: 'identity', mode: 'byDefault' } }),
    ),
    label: string(),
    nick: pipe(nullable(string()), column({ unique: true })),
    owner_id: nullable(reference(Owner, 'id')),
  },
  { primaryKey: 'id', indexes: [{ name: 'parent_label', columns: ['label'] }] },
)

const initial = `pragma foreign_keys=on;
create table owners (id INTEGER primary key not null);
insert into owners values (1);
create table parent (id INTEGER primary key autoincrement, label TEXT, retained TEXT not null default 'retained', retained_owner_id INTEGER references owners(id) on delete restrict on update cascade, unique(retained), unique(id, label));
create index retained_label on parent(label);
create table child (id INTEGER primary key, parent_id INTEGER references parent(id) on delete cascade);
insert into parent(id,label,retained,retained_owner_id) values (20,'record','value',1), (100,'deleted','deleted',1);
delete from parent where id=100;
insert into child values (1,20);`

/** Opens the exact production connector and pinned session for a real migration. */
async function fixture(sql = initial) {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance()
  native.exec(sql)
  const provider = sqliteDialect.operations.createSessionProvider(
    connector,
    sqliteDialect.id,
  )

  const session = await provider.open()
  const executor: Executor = {
    execute: (query) => session.query(query),
    run: (query) => session.run(query),
  }

  return {
    connector,
    native,
    executor,
    /** Releases all native resources after the scenario. */
    close: async () => {
      await closeSqliteProviders([session], [provider])
    },
  }
}

/** Performs the production desired-schema/catalog/planning/lowering pipeline. */
async function planned(
  executor: Executor,
  schemas: readonly TableHandle[] = [Parent, Owner],
  ownership: readonly MigrationOwnershipDeclaration[] = additive,
  columnDrop: 'guarded' | 'dangerous' = 'guarded',
) {
  const snapshot = await sqliteDialect.catalog.introspectCatalog(
    executor,
    createCatalogRequest(schemas, ownership),
  )

  const migration = planMigration(schemas, snapshot, sqliteDialect.migration.planning, {
    migrationOwnership: ownership,
  })

  const result = sqliteDialect.migration.lower(migration, migration.profile, {
    columnDrop,
  })

  if (result.issues)
    throw new Error(result.issues.map((issue) => issue.message).join('\n'))

  return { migration, program: result.program }
}

/** Runs the production runtime and verifies convergence before committing. */
async function execute(
  executor: Executor,
  schemas: readonly TableHandle[] = [Parent, Owner],
  ownership: readonly MigrationOwnershipDeclaration[] = additive,
  columnDrop: 'guarded' | 'dangerous' = 'guarded',
) {
  return sqliteDialect.migration.execute({
    executor,
    databaseIdentity: ':memory:',
    discard: () => undefined,
    cancel: async () => undefined,
    prepare: async () =>
      (await planned(executor, schemas, ownership, columnDrop)).program,
    validate: async () => {
      expect((await planned(executor, schemas, ownership)).migration.plan.steps).toEqual(
        [],
      )
    },
  })
}

const RetainedFkOwner = defineTable(
  'fk_owner',
  { id: pipe(number(), integer()) },
  { primaryKey: 'id' },
)

const RetainedFkChild = defineTable(
  'fk_child',
  {
    id: pipe(number(), integer()),
    owner_id: nullable(pipe(number(), integer())),
    label: string(),
    tag: pipe(nullable(string()), column({ unique: true })),
  },
  { primaryKey: 'id' },
)

const retainedFkSchemas = [RetainedFkOwner, RetainedFkChild]
const retainedFkOwnership: MigrationOwnershipDeclaration[] = [
  { kind: 'relation', relation: RetainedFkOwner, shape: 'additive' },
  { kind: 'relation', relation: RetainedFkChild, shape: 'additive' },
]

/**
 * Checks seeded rows and the retained live foreign key after a rejected or completed
 * rebuild.
 */
function expectRetainedForeignKey(
  native: DatabaseSync,
  data: unknown[],
  foreignKeys: unknown[],
) {
  expect(native.prepare('select * from fk_child').all()).toEqual(data)
  expect(native.prepare('pragma foreign_key_list(fk_child)').all()).toEqual(foreignKeys)
}

/** Runs the retained-FK scenario through the normal planning pipeline. */
function planRetainedFk(executor: Executor) {
  return planned(executor, retainedFkSchemas, retainedFkOwnership)
}

/** Repeats a consistent FK omission on every catalog query. */
function omitRetainedForeignKey(executor: Executor): Executor {
  return {
    ...executor,
    execute: (query) =>
      query.sql.includes('pragma_foreign_key_list') && query.params[0] === 'fk_child'
        ? Promise.resolve([])
        : executor.execute(query),
  }
}

it('should reject an additive rebuild when the live foreign key is missing from repeated catalog reads', async () => {
  const opened = await fixture(`
    pragma foreign_keys=on;
    create table fk_owner(id INTEGER PRIMARY KEY);
    create table fk_child(id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES fk_owner(id), label TEXT NOT NULL, tag TEXT);
    insert into fk_owner values(7);
    insert into fk_child values(1,7,'seed','one');
  `)

  try {
    const beforeSchema = opened.native
      .prepare('select name,sql from sqlite_schema order by name')
      .all()

    const beforeData = opened.native.prepare('select * from fk_child').all()

    const beforeForeignKeys = opened.native
      .prepare('pragma foreign_key_list(fk_child)')
      .all()

    const mutations = trackNativeMutations(opened.native)
    const omitted = omitRetainedForeignKey(opened.executor)

    await expect(planRetainedFk(omitted)).rejects.toThrow(/catalog|unknown|incomplete/i)

    await expect(
      execute(omitted, retainedFkSchemas, retainedFkOwnership),
    ).rejects.toMatchObject({
      outcome: 'unchanged',
    })

    expect(mutations).toEqual([])

    expect(
      opened.native.prepare('select name,sql from sqlite_schema order by name').all(),
    ).toEqual(beforeSchema)

    expectRetainedForeignKey(opened.native, beforeData, beforeForeignKeys)

    const complete = await planRetainedFk(opened.executor)
    expect(
      complete.program.actions.some((action) =>
        action.statements.some((statement) => /^create table/i.test(statement.sql)),
      ),
    ).toBe(true)

    await execute(opened.executor, retainedFkSchemas, retainedFkOwnership)
    expectRetainedForeignKey(opened.native, beforeData, beforeForeignKeys)

    expect((await planRetainedFk(opened.executor)).migration.plan.steps).toEqual([])
  } finally {
    await opened.close()
  }
})

it('should reject contradictory native column evidence before exposing a program or DDL', async () => {
  const Records = defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      retained: nullable(string()),
      added: nullable(string()),
    },
    { primaryKey: 'id' },
  )

  const ownership: MigrationOwnershipDeclaration[] = [
    { kind: 'relation', relation: Records, shape: 'additive' },
  ]

  const opened = await fixture(
    "create table records(id INTEGER primary key, retained TEXT default 'kept'); insert into records values(1,'value')",
  )

  try {
    const mutations = trackNativeMutations(opened.native)
    const damaged: Executor = {
      ...opened.executor,
      execute: async (query) => {
        const rows = await opened.executor.execute(query)

        return query.sql.includes('pragma_table_xinfo') && query.params[0] === 'records'
          ? rows.map((row) =>
              (row as { name?: string }).name === 'retained'
                ? { ...(row as Record<string, unknown>), type: 'INTEGER' }
                : row,
            )
          : rows
      },
    }

    let exposed: Awaited<ReturnType<typeof planned>> | undefined

    await expect(
      planned(damaged, [Records], ownership).then((result) => {
        exposed = result
      }),
    ).rejects.toThrow(/catalog|unknown|incomplete/i)

    expect(exposed).toBeUndefined()

    await expect(execute(damaged, [Records], ownership)).rejects.toMatchObject({
      outcome: 'unchanged',
    })

    expect(mutations).toEqual([])

    expect(opened.native.prepare('select * from records').all()).toEqual([
      { id: 1, retained: 'value' },
    ])
  } finally {
    await opened.close()
  }
})

it('should resolve the production member and create a desired FK graph through Client', async () => {
  expect(resolveDialect('sqlite')).toBe(sqliteDialect)

  await withSqliteDatabase([Parent, Owner], async ({ db }) => {
    const preview = await db.migrate().dryRun()
    expect(preview.actions).toHaveLength(2)
    expect(preview.actions[0].statements[0].sql).toContain('"owners"')
    await db.migrate().execute()
    expect(await db.migrate().plan()).toEqual({ steps: [] })
    expect((await db.migrate().dryRun()).actions).toEqual([])
  })
})

it.each(['sqlite_reserved', 'SQLITE_reserved', 'sQlItE_reserved'])(
  'should reject reserved SQLite table name %s before exposing DDL',
  async (name) => {
    const Valid = defineTable(
      'aaa_valid',
      { id: pipe(number(), integer()) },
      { primaryKey: 'id' },
    )

    const Reserved = defineTable(
      name,
      { id: pipe(number(), integer()) },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase([Valid, Reserved], async ({ db, native }) => {
      native.exec('create table seed(id INTEGER primary key); insert into seed values(7)')
      const ddlAttempts = trackNativeMutations(native)

      const before = native
        .prepare('select name,sql from sqlite_schema order by name')
        .all()

      const message = `SQLite table name ${JSON.stringify(name)} uses reserved prefix "sqlite_"`

      await expectLoweringFailure(() => db.migrate().dryRun(), message)
      await expectLoweringFailure(() => db.migrate().execute())

      expect(ddlAttempts).toEqual([])

      expect(
        native.prepare('select name,sql from sqlite_schema order by name').all(),
      ).toEqual(before)

      expect(native.prepare('select * from seed').all()).toEqual([{ id: 7 }])
    })
  },
)

it.each([
  ['sqlite_reserved_index', false],
  ['SQLITE_reserved_index', true],
])(
  'should reject reserved index %s on a %s table before exposing any DDL',
  async (indexName, existing) => {
    const relationName = existing ? 'existing_records' : 'new_records'
    const Good = defineTable(
      'aaa_valid',
      { id: pipe(number(), integer()), value: string() },
      {
        primaryKey: 'id',
        indexes: [{ name: 'valid_records_value', columns: ['value'] }],
      },
    )

    const Bad = defineTable(
      relationName,
      { id: pipe(number(), integer()), value: string() },
      {
        primaryKey: 'id',
        indexes: [{ name: indexName, columns: ['value'] }],
      },
    )

    await withSqliteDatabase([Good, Bad], async ({ db, native }) => {
      native.exec(
        "create table existing_records (id INTEGER primary key not null, value TEXT not null); insert into existing_records values (7, 'kept')",
      )

      const ddlAttempts = trackNativeMutations(native)

      const before = native
        .prepare('select type,name,tbl_name,sql from sqlite_schema order by type,name')
        .all()

      const message = `SQLite index name ${JSON.stringify(indexName)} uses reserved prefix "sqlite_"`

      await expectLoweringFailure(() => db.migrate().dryRun(), message)
      await expectLoweringFailure(() => db.migrate().execute())

      expect(ddlAttempts).toEqual([])

      expect(
        native
          .prepare('select type,name,tbl_name,sql from sqlite_schema order by type,name')
          .all(),
      ).toEqual(before)

      expect(native.prepare('select * from existing_records').all()).toEqual([
        { id: 7, value: 'kept' },
      ])
    })
  },
)

/** Checks quoted objects, generated SQLite catalog objects and inserted row state. */
function expectQuotedMigrationState(
  native: DatabaseSync,
  tableName: string,
  indexName: string,
): void {
  const quotedTableName = `"${tableName.replaceAll('"', '""')}"`

  expect(native.prepare(`select * from ${quotedTableName}`).all()).toEqual([
    { id: 1, sqlite_value: 'kept', sqlite_unique_value: 'unique' },
  ])

  expect(
    native.prepare('select name from sqlite_schema where type = ?').all('index'),
  ).toContainEqual({ name: indexName })

  expect(
    native
      .prepare("select name from sqlite_schema where name like 'sqlite_autoindex_%'")
      .all(),
  ).toContainEqual({ name: `sqlite_autoindex_${tableName}_1` })

  expect(
    native.prepare('select seq from sqlite_sequence where name = ?').get(tableName),
  ).toEqual({ seq: 1 })
}

it('should allow quoted object names, sqlite_ columns and non-ASCII prefix lookalikes', async () => {
  const tableName = 'sqlİte_records.with"quote_雪'
  const indexName = 'quoted.index"name_雪'
  const quotedTableName = `"${tableName.replaceAll('"', '""')}"`
  const Quoted = defineTable(
    tableName,
    {
      id: pipe(
        number(),
        integer(),
        column({ generation: { kind: 'identity', mode: 'byDefault' } }),
      ),
      sqlite_value: string(),
      sqlite_unique_value: pipe(string(), column({ unique: true })),
    },
    {
      primaryKey: 'id',
      indexes: [{ name: indexName, columns: ['sqlite_value'] }],
    },
  )

  await withSqliteDatabase([Quoted], async ({ db, native }) => {
    const preview = await db.migrate().dryRun()
    expect(preview.actions).toHaveLength(1)

    expect(preview.actions[0].statements.map(({ sql }) => sql)).toEqual([
      expect.stringMatching(/^create table/),
      expect.stringMatching(/^create index/),
    ])

    await db.migrate().execute()

    native
      .prepare(
        `insert into ${quotedTableName} ("sqlite_value", "sqlite_unique_value") values (?, ?)`,
      )
      .run('kept', 'unique')

    expect(await db.migrate().plan()).toEqual({ steps: [] })
    expect((await db.migrate().dryRun()).actions).toEqual([])
    expectQuotedMigrationState(native, tableName, indexName)
  })
})

const SeedWithData = defineTable(
  'seed',
  { id: pipe(number(), integer()) },
  { primaryKey: 'id' },
)

const ValidBeforeBad = defineTable(
  'aaa_valid',
  { id: pipe(number(), integer()) },
  { primaryKey: 'id' },
)

const retainedDefaults = `disabled BLOB DEFAULT false, enabled BLOB DEFAULT TRUE,
scientific BLOB DEFAULT 1e20, binary BLOB DEFAULT X'ff', fraction BLOB DEFAULT -.5,
trailing BLOB DEFAULT +1., empty BLOB DEFAULT NULL, text BLOB DEFAULT 'a'';--b',
parenthesized BLOB DEFAULT (false)`

const retainedValues = `select id, disabled, typeof(disabled) as disabledType,
enabled, typeof(enabled) as enabledType, scientific, typeof(scientific) as scientificType,
hex(binary) as binary, typeof(binary) as binaryType, fraction, typeof(fraction) as fractionType,
trailing, typeof(trailing) as trailingType, empty, typeof(empty) as emptyType,
text, typeof(text) as textType, parenthesized, typeof(parenthesized) as parenthesizedType
from records order by id`

const insertedLiteralDefaults = {
  id: 2,
  disabled: 0,
  disabledType: 'integer',
  enabled: 1,
  enabledType: 'integer',
  scientific: 1e20,
  scientificType: 'real',
  binary: 'FF',
  binaryType: 'blob',
  fraction: -0.5,
  fractionType: 'real',
  trailing: 1,
  trailingType: 'real',
  empty: null,
  emptyType: 'null',
  text: "a';--b",
  textType: 'text',
  parenthesized: 0,
  parenthesizedType: 'integer',
}

it.each([false, true])(
  'should preserve native literal defaults and storage through migration (rebuild: %s)',
  async (rebuild) => {
    const Records = defineTable(
      'records',
      {
        id: pipe(number(), integer()),
        note: pipe(nullable(string()), column({ unique: rebuild })),
      },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase(
      [Records],
      async ({ db, native }) => {
        native.exec(`create table records(id INTEGER PRIMARY KEY NOT NULL, ${retainedDefaults});
      insert into records(id,text) values(1,'existing')`)

        const before = native.prepare(retainedValues).all()

        const defaults = native.prepare('pragma table_info(records)').all()

        expect((await db.migrate().plan()).steps.map((step) => step.kind)).toEqual([
          'add_column',
        ])

        const preview = await db.migrate().dryRun()
        expect(preview.actions).toHaveLength(1)

        expect(preview.actions[0].statements[0].sql).toMatch(
          rebuild ? /^create table/ : /^alter table/,
        )

        await db.migrate().execute()
        expect(native.prepare(retainedValues).all()).toEqual(before)

        expect(native.prepare('pragma table_info(records)').all().slice(0, -1)).toEqual(
          defaults,
        )

        native.prepare('insert into records(id) values(2)').run()
        expect(native.prepare(retainedValues).all()[1]).toEqual(insertedLiteralDefaults)
        expect(await db.migrate().plan()).toEqual({ steps: [] })
        expect((await db.migrate().dryRun()).actions).toEqual([])
      },
      {
        migrationOwnership: [
          ...completeMain,
          { kind: 'relation', relation: Records, shape: 'additive' },
        ],
      },
    )
  },
)

it.each([
  'abs()',
  'abs(1,)',
  'coalesce(1)',
  'min(1)',
  "lower('x'); DROP TABLE seed",
  'cast(1as integer)',
  'abs(\u00a01)',
  '\u00a01',
  '1\u00a0',
  'abs(\v1)',
  "abs(cast('-9223372036854775808' as integer))",
  'abs(-2147483648 * 4294967296)',
])(
  'should reject invalid default %s before exposing a program or executing DDL',
  async (expression) => {
    const Bad = defineTable(
      'zzz_invalid',
      {
        id: pipe(number(), integer()),
        value: pipe(
          nullable(string()),
          column({
            databaseDefault: {
              kind: 'dialectExpression',
              dialect: 'sqlite',
              expression,
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase(
      [ValidBeforeBad, Bad, SeedWithData],
      async ({ db, native }) => {
        native.exec(
          'create table seed(id INTEGER primary key not null); insert into seed values(7)',
        )

        const before = native
          .prepare('select name,sql from sqlite_schema order by name')
          .all()

        const diagnostic = `Unsafe SQLite database expression ${JSON.stringify(expression)}`
        const planError = {
          stage: 'planning',
          outcome: 'unchanged',
          message: `Migration planning failed: ${diagnostic}`,
        }

        await expect(db.migrate().plan()).rejects.toMatchObject(planError)
        await expect(db.migrate().dryRun()).rejects.toMatchObject(planError)

        await expect(db.migrate().execute()).rejects.toMatchObject({
          stage: 'planning',
          outcome: 'unchanged',
          message: expect.stringContaining(diagnostic) as string,
        })

        expect(
          native.prepare('select name,sql from sqlite_schema order by name').all(),
        ).toEqual(before)

        expect(native.prepare('select * from seed').all()).toEqual([{ id: 7 }])
      },
    )
  },
)

it.each([
  ['abs(-12)', '12', 'integer'],
  ["lower(trim(' A '))", 'a', 'text'],
  ["hex(X'ff')", 'FF', 'text'],
  ['min(1,2)', '1', 'integer'],
  ['sign(-1)', '-1', 'integer'],
  ["cast('12' as INTEGER) + 3 * 2", '18', 'integer'],
  ["strftime('%s','2026-01-01')", '1767225600', 'text'],
  ['abs(-922337203685477580+8)', '922337203685477572', 'integer'],
  ["abs(length('value'))", '5', 'integer'],
  ["abs(cast('-12' as REAL))", '12.0', 'real'],
  ['abs(\t\r\n\f 1)', '1', 'integer'],
  ['false', '0', 'integer'],
  ['(false)', '0', 'integer'],
  ['TRUE', '1', 'integer'],
  ['((true))', '1', 'integer'],
  ["X'FF'", 'FF', 'blob'],
  ["(x'ff')", 'FF', 'blob'],
  ['NULL', null, 'null'],
  ['(null)', null, 'null'],
])(
  'should migrate, converge and evaluate expression default %s on a native insert',
  async (expression, value, storage) => {
    const Records = defineTable(
      'records',
      {
        id: pipe(number(), integer()),
        value: pipe(
          nullable(string()),
          column({
            physicalType: { sqlite: 'BLOB' },
            databaseDefault: { kind: 'dialectExpression', dialect: 'sqlite', expression },
          }),
        ),
      },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase([Records], async ({ db, native }) => {
      await db.migrate().execute()
      native.prepare('insert into records(id) values(1)').run()

      expect(
        native
          .prepare(
            "select case when typeof(value)='blob' then hex(value) else cast(value as text) end as value,typeof(value) as storage from records",
          )
          .all(),
      ).toEqual([{ value, storage }])

      expect(await db.migrate().plan()).toEqual({ steps: [] })
      expect((await db.migrate().dryRun()).actions).toEqual([])
    })
  },
)

it.each([
  ['tExT  nOt nUlL', 'SQLite column data type contains constraint syntax'],
  ['TEXT PRIMARY KEY', 'SQLite column data type contains constraint syntax'],
  ['TEXT PRIMARY', 'SQLite column data type contains constraint syntax'],
  ['tExT  pRiMaRy', 'SQLite column data type contains constraint syntax'],
  ['TEXT NOT', 'SQLite column data type contains constraint syntax'],
  ['TEXT FOREIGN', 'SQLite column data type contains constraint syntax'],
  ['TEXT FOREIGN KEY', 'SQLite column data type contains constraint syntax'],
  ['TEXT ON', 'SQLite column data type contains constraint syntax'],
  ['TEXT DEFERRABLE', 'SQLite column data type contains constraint syntax'],
  ['tExT  dEfErRaBlE', 'SQLite column data type contains constraint syntax'],
  [
    'TEXT DEFAULT CURRENT_TIMESTAMP',
    'SQLite column data type contains constraint syntax',
  ],
  ['TEXT COLLATE NOCASE', 'SQLite column data type contains constraint syntax'],
  ['TEXT UNIQUE', 'SQLite column data type contains constraint syntax'],
  ['TEXT REFERENCES seed', 'SQLite column data type contains constraint syntax'],
  ['TEXT NULL', 'SQLite column data type contains constraint syntax'],
  ['TEXT CHECK (1)', 'SQLite column data type contains constraint syntax'],
  ['TEXT CONSTRAINT named UNIQUE', 'SQLite column data type contains constraint syntax'],
  ['TEXT GENERATED ALWAYS', 'SQLite column data type contains constraint syntax'],
  ['TEXT GENERATED ALWAYS AS (1)', 'SQLite column data type contains constraint syntax'],
  ['TEXT SOMETHING ALWAYS', 'unsupported SQLite column data type'],
  ['TEXT ABCD ALWAYS', 'unsupported SQLite column data type'],
  ['TEXT LONGTYPEALWAYS', 'unsupported SQLite column data type'],
  ['TEXT FOO_GENERATED ALWAYS', 'unsupported SQLite column data type'],
  ['TEXT AS (1)', 'SQLite column data type contains constraint syntax'],
  ['TEXT SELECT', 'unsupported SQLite column data type'],
  ['TEXT INDEXED', 'unsupported SQLite column data type'],
  ['TEXT JOIN', 'unsupported SQLite column data type'],
  ['TEXT ORDER', 'unsupported SQLite column data type'],
  ['TEXT 123', 'unsupported SQLite column data type'],
  ['TEXT 123abc', 'unsupported SQLite column data type'],
  ['TEXT\u000bINTEGER', 'unsupported SQLite column data type'],
  ['TEXT\u00a0INTEGER', 'unsupported SQLite column data type'],
  ['DECIMAL(\u000b10, 2)', 'unsupported SQLite column data type'],
])(
  'should reject unsupported SQLite physical type grammar before DDL: %s',
  async (dataType, reason) => {
    const Bad = defineTable(
      'zzz_invalid',
      {
        id: pipe(number(), integer()),
        value: pipe(
          nullable(
            dataType.includes('CONSTRAINT') ||
              dataType.includes('\u000b') ||
              dataType.includes('\u00a0')
              ? number()
              : string(),
          ),
          column({ physicalType: { sqlite: dataType } }),
        ),
      },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase(
      [ValidBeforeBad, Bad, SeedWithData],
      async ({ db, native }) => {
        native.exec(
          'create table seed(id INTEGER primary key not null); insert into seed values(7)',
        )

        const message = `${reason}: ${JSON.stringify(dataType)}`
        const ddlAttempts = trackNativeMutations(native)

        const before = native
          .prepare('select name,sql from sqlite_schema order by name')
          .all()

        await expectPlanningFailure(() => db.migrate().plan(), message)
        await expectPlanningFailure(() => db.migrate().dryRun(), message)
        await expectPlanningFailure(() => db.migrate().execute())

        expect(ddlAttempts).toEqual([])

        expect(
          native.prepare('select name,sql from sqlite_schema order by name').all(),
        ).toEqual(before)

        expect(native.prepare('select * from seed').all()).toEqual([{ id: 7 }])
      },
    )
  },
)

const LegalPhysicalTypes = defineTable(
  'types',
  {
    id: pipe(number(), integer()),
    realValue: pipe(number(), column({ physicalType: { sqlite: 'dOuBlE   pReCiSiOn' } })),
    textValue: pipe(
      string(),
      column({ physicalType: { sqlite: 'CHARACTER VARYING(32)' } }),
    ),
    numericValue: pipe(number(), column({ physicalType: { sqlite: 'DECIMAL(10, 2)' } })),
    integerValue: pipe(
      number(),
      column({ physicalType: { sqlite: 'UNSIGNED BIG INT' } }),
    ),
    customValue: pipe(number(), column({ physicalType: { sqlite: 'CONSTRAINT_NAME' } })),
    generatedValue: pipe(
      string(),
      column({ physicalType: { sqlite: 'TEXT GENERATED ALWAYS foo' } }),
    ),
    generatedType: pipe(string(), column({ physicalType: { sqlite: 'TEXT GENERATED' } })),
    shortAlways: pipe(string(), column({ physicalType: { sqlite: 'TEXT abc ALWAYS' } })),
    parameterizedAlways: pipe(
      string(),
      column({ physicalType: { sqlite: 'TEXT SOMETHING ALWAYS(10)' } }),
    ),
    parameterizedGeneratedAlways: pipe(
      string(),
      column({ physicalType: { sqlite: 'TEXT GENERATED ALWAYS(10,2)' } }),
    ),
    keywordValue: pipe(
      string(),
      column({ physicalType: { sqlite: 'TEXT KEY WINDOW FILTER OVER' } }),
    ),
  },
  { primaryKey: 'id' },
)

it('should keep dangerous column grants scoped to one SQLite relation', async () => {
  const First = defineTable(
    'first',
    { id: pipe(number(), integer()) },
    { primaryKey: 'id' },
  )

  const Second = defineTable(
    'second',
    { id: pipe(number(), integer()) },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase(
    [First, Second],
    async ({ db, native }) => {
      await db.migrate().execute()
      native.exec('alter table first add column retired text')
      native.exec('alter table second add column retired text')
      native.exec("insert into first (id, retired) values (1, 'kept')")
      native.exec("insert into second (id, retired) values (1, 'guarded')")

      const migration = db.migrate()
      const plan = await migration.plan()
      const firstDrop = plan.steps.find(
        (step) =>
          step.kind === 'drop_column' &&
          step.target.relation.relation.spelling === 'first',
      )

      expect(firstDrop?.kind).toBe('drop_column')

      if (firstDrop?.kind !== 'drop_column')
        throw new Error('expected the first column drop')

      const preview = await migration
        .allowFor(firstDrop.target, 'dangerouslyDropColumn')
        .dryRun()

      expect(preview.preconditions).toHaveLength(1)

      expect(preview.preconditions[0]).toMatchObject({
        kind: 'column_has_only_nulls',
        target: { relation: { relation: { spelling: 'second' } } },
      })

      await expect(
        migration.allowFor(firstDrop.target, 'dangerouslyDropColumn').execute(),
      ).rejects.toMatchObject({ stage: 'precondition', outcome: 'unchanged' })

      expectRetiredColumns(native, true)

      native.exec('update second set retired = null')
      await migration.allowFor(firstDrop.target, 'dangerouslyDropColumn').execute()

      expectRetiredColumns(native, false)
    },
    { migrationOwnership: completeMain },
  )
})

/** Checks whether both relations still contain the guarded migration column. */
function expectRetiredColumns(native: DatabaseSync, present: boolean): void {
  for (const relation of ['first', 'second']) {
    const names = native
      .prepare(`pragma table_info(${relation})`)
      .all()
      .map((row) => row.name)

    expect(names.includes('retired')).toBe(present)
  }
}

it('should preserve legal multiword and parameterized SQLite types through execution', async () => {
  await withSqliteDatabase([LegalPhysicalTypes], async ({ db, native }) => {
    await db.migrate().execute()

    expect(
      native
        .prepare('pragma table_info(types)')
        .all()
        .map((row) => [row.name, row.type]),
    ).toEqual([
      ['id', 'INTEGER'],
      ['realValue', 'dOuBlE   pReCiSiOn'],
      ['textValue', 'CHARACTER VARYING(32)'],
      ['numericValue', 'DECIMAL(10, 2)'],
      ['integerValue', 'UNSIGNED BIG INT'],
      ['customValue', 'CONSTRAINT_NAME'],
      ['generatedValue', 'TEXT GENERATED ALWAYS foo'],
      ['generatedType', 'TEXT GENERATED'],
      ['shortAlways', 'TEXT abc ALWAYS'],
      ['parameterizedAlways', 'TEXT SOMETHING ALWAYS(10)'],
      ['parameterizedGeneratedAlways', 'TEXT GENERATED ALWAYS(10,2)'],
      ['keywordValue', 'TEXT KEY WINDOW FILTER OVER'],
    ])

    expect(sqliteDialect.schema.normalizeDataType('dOuBlE   pReCiSiOn')).toBe('real')
    expect(sqliteDialect.schema.normalizeDataType('CHARACTER VARYING(32)')).toBe('text')
    expect(sqliteDialect.schema.normalizeDataType('DECIMAL(10, 2)')).toBe('numeric')
    expect(sqliteDialect.schema.normalizeDataType('UNSIGNED BIG INT')).toBe('integer')
    expect(sqliteDialect.schema.normalizeDataType('CONSTRAINT_NAME')).toBe('integer')

    expect(sqliteDialect.schema.normalizeDataType('TEXT KEY WINDOW FILTER OVER')).toBe(
      'text',
    )

    expect((await db.migrate().dryRun()).actions).toEqual([])
  })
})

it('should reject an implicit rowid alias conversion even when the semantic plan is empty', async () => {
  const Records = defineTable(
    'records',
    { id: pipe(number(), integer()) },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Records], async ({ db, native }) => {
    native.exec(
      'create table records(id INT primary key not null); insert into records values(7)',
    )

    const before = native
      .prepare('select name,sql from sqlite_schema order by name')
      .all()

    expect(await db.migrate().plan()).toEqual({ steps: [] })

    await expect(db.migrate().dryRun()).rejects.toMatchObject({
      stage: 'lowering',
      capabilityIssues: [
        {
          code: 'compile_failure',
          message: 'Unsupported SQLite rowid alias conversion',
          sourceStepIndexes: [],
        },
      ],
    })

    expect(
      native.prepare('select name,sql from sqlite_schema order by name').all(),
    ).toEqual(before)

    expect(native.prepare('select rowid,id from records').all()).toEqual([
      { rowid: 1, id: 7 },
    ])
  })
})

it('should coalesce touching changes and retain additive data, constraints, indexes and sequence state', async () => {
  const test = await fixture()
  try {
    const before = await planned(test.executor)
    expect(before.program.actions).toHaveLength(1)

    expect(before.program.actions[0].sourceStepIndexes).toEqual(
      before.migration.plan.steps.map((_, index) => index),
    )

    expect(await execute(test.executor)).toEqual({ outcome: 'applied' })

    expect(test.native.prepare('select * from parent').all()).toEqual([
      {
        id: 20,
        label: 'record',
        retained: 'value',
        retained_owner_id: 1,
        nick: null,
        owner_id: null,
      },
    ])

    expect(test.native.prepare('select * from child').all()).toEqual([
      { id: 1, parent_id: 20 },
    ])

    expect(test.native.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })

    expect(
      test.native.prepare("select seq from sqlite_sequence where name='parent'").get(),
    ).toEqual({ seq: 100 })

    test.native.exec("insert into parent(label,retained) values ('next','next')")

    expect(test.native.prepare('select max(id) as id from parent').get()).toEqual({
      id: 101,
    })

    expect(
      test.native
        .prepare('pragma index_list(parent)')
        .all()
        .map((index) => index.name),
    ).toEqual(expect.arrayContaining(['retained_label', 'parent_label']))

    expectRetainedDefinitions(test.native)
    expect((await planned(test.executor)).program.actions).toEqual([])
  } finally {
    await test.close()
  }
})

/** Independently checks retained native constraints that additive convergence omits. */
function expectRetainedDefinitions(
  native: Awaited<ReturnType<typeof fixture>>['native'],
) {
  const uniqueKeys = native
    .prepare('pragma index_list(parent)')
    .all()
    .filter((index) => index.unique === 1)
    .map((index) =>
      native
        .prepare('select name from pragma_index_info(?) order by seqno')
        .all(index.name)
        .map((column) => column.name),
    )

  expect(uniqueKeys).toEqual(
    expect.arrayContaining([['retained'], ['id', 'label'], ['nick']]),
  )

  expect(native.prepare('pragma table_info(parent)').all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'retained', notnull: 1, dflt_value: "'retained'" }),
    ]),
  )

  expectRetainedForeignKeys(native)
}

/** Checks both retained and added FK definitions plus the untouched cascading child. */
function expectRetainedForeignKeys(
  native: Awaited<ReturnType<typeof fixture>>['native'],
) {
  expect(native.prepare('pragma foreign_key_list(parent)').all()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        from: 'retained_owner_id',
        table: 'owners',
        to: 'id',
        on_delete: 'RESTRICT',
        on_update: 'CASCADE',
      }),
      expect.objectContaining({
        from: 'owner_id',
        table: 'owners',
        to: 'id',
        on_delete: 'NO ACTION',
        on_update: 'NO ACTION',
      }),
    ]),
  )

  expect(native.prepare('pragma foreign_key_list(child)').all()).toEqual([
    {
      id: 0,
      seq: 0,
      table: 'parent',
      from: 'parent_id',
      to: 'id',
      on_delete: 'CASCADE',
      on_update: 'NO ACTION',
      match: 'NONE',
    },
  ])
}

it('should use direct legal ADD COLUMN without rebuilding existing rowids', async () => {
  const Add = defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      note: nullable(string()),
      active: pipe(
        number(),
        integer(),
        column({ databaseDefault: { kind: 'literal', value: 1 } }),
      ),
    },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    'create table records(id INTEGER primary key); insert into records values(40)',
  )

  try {
    const { program } = await planned(test.executor, [Add], [])
    expect(
      program.actions[0].statements.every((query) => query.sql.startsWith('alter table')),
    ).toBe(true)

    await execute(test.executor, [Add], [])

    expect(test.native.prepare('select * from records').all()).toEqual([
      { id: 40, note: null, active: 1 },
    ])

    expect(await execute(test.executor, [Add], [])).toEqual({ outcome: 'unchanged' })
  } finally {
    await test.close()
  }
})

/** Captures the original native schema, rows and sequence for exact rollback checks. */
function originalState(native: Awaited<ReturnType<typeof fixture>>['native']) {
  return {
    schema: native
      .prepare('select type,name,tbl_name,sql from sqlite_schema order by name')
      .all(),
    parent: native.prepare('select * from parent').all(),
    child: native.prepare('select * from child').all(),
    sequence: native.prepare('select * from sqlite_sequence').all(),
  }
}

/**
 * Injects one failure through the physical statement boundary while retaining native
 * transactions.
 */
function failingExecutor(
  executor: Executor,
  program: MigrationProgram,
  failureIndex: number,
): Executor {
  const statements = program.actions.flatMap((action) => action.statements)
  let current = 0
  return {
    execute: (query) => executor.execute(query),
    /** Rejects the selected rebuild statement and delegates every other native command. */
    run: async (query) => {
      if (
        statements.some((statement) => statement.sql === query.sql) &&
        current++ === failureIndex
      )
        throw new Error(`injected ${failureIndex}`)

      await executor.run(query)
    },
  }
}

it('should roll back catalog, data and FK policy after failure at every rebuild statement', async () => {
  const seed = await fixture()
  const program = (await planned(seed.executor)).program
  await seed.close()
  for (const [index] of program.actions[0].statements.entries())
    await assertRebuildRollback(program, index)
})

/** Proves one physical rebuild failure restores all original native evidence. */
async function assertRebuildRollback(program: MigrationProgram, index: number) {
  const test = await fixture()
  const before = originalState(test.native)
  try {
    await expect(
      sqliteDialect.migration.execute({
        executor: failingExecutor(test.executor, program, index),
        databaseIdentity: ':memory:',
        discard: () => undefined,
        cancel: async () => undefined,
        prepare: async () => program,
      }),
    ).rejects.toMatchObject({
      stage: 'ddl',
      outcome: 'rolledBack',
      actionIndex: 0,
      sourceStepIndexes: program.actions[0].sourceStepIndexes,
      cause: expect.objectContaining({ message: `injected ${index}` }) as object,
    })

    expect(originalState(test.native)).toEqual(before)
    expect(test.native.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(inTransaction(test.native)).toBe(false)
  } finally {
    await test.close()
  }
}

it('should permit owned drops with complete incoming dependency evidence and converge', async () => {
  const Keep = defineTable(
    'keep',
    { id: pipe(number(), integer()), label: string() },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    "create table keep(id INTEGER primary key, label TEXT not null, removed TEXT unique); create table obsolete(id INTEGER primary key); insert into keep values(1,'kept','removed')",
  )

  try {
    const { migration } = await planned(test.executor, [Keep], completeMain)
    expect(migration.plan.steps.map((step) => step.kind)).toEqual([
      'drop_column',
      'drop_table',
    ])

    await execute(test.executor, [Keep], completeMain, 'dangerous')

    expect(test.native.prepare('select * from keep').all()).toEqual([
      { id: 1, label: 'kept' },
    ])

    expect(
      test.native.prepare("select name from sqlite_schema where name='obsolete'").all(),
    ).toEqual([])
  } finally {
    await test.close()
  }
})

it.each([
  ['direct', 'removed TEXT', ''],
  ['rebuild', 'removed TEXT unique', ''],
])(
  'should guard %s column drops and preserve retained data',
  async (_mode, column, extra) => {
    const Keep = defineTable(
      'guarded_keep',
      { id: pipe(number(), integer()), label: string() },
      { primaryKey: 'id' },
    )

    const test = await fixture(
      `create table guarded_keep(id INTEGER primary key, label TEXT not null, ${column}); insert into guarded_keep values(1,'kept',NULL)${extra}`,
    )

    try {
      await execute(test.executor, [Keep], completeMain)

      expect(test.native.prepare('select * from guarded_keep').all()).toEqual([
        { id: 1, label: 'kept' },
      ])
    } finally {
      await test.close()
    }
  },
)

it.each([
  ['value', 'TEXT'],
  ['', 'TEXT'],
  [0, 'INTEGER'],
] as const)(
  'should block a populated SQLite column value %j before DDL',
  async (value, type) => {
    const Keep = defineTable(
      'guarded_keep',
      { id: pipe(number(), integer()), label: string() },
      { primaryKey: 'id' },
    )

    const test = await fixture(
      `create table guarded_keep(id INTEGER primary key, label TEXT not null, removed ${type}); insert into guarded_keep values(1,'kept',NULL)`,
    )

    try {
      test.native.prepare('update guarded_keep set removed = ?').run(value)
      const error = await execute(test.executor, [Keep], completeMain).catch(
        (cause: unknown) => cause,
      )

      expect(error).toMatchObject({
        stage: 'precondition',
        preconditionFailure: { reason: 'contains_non_null_values' },
      })

      expect(test.native.prepare('select removed from guarded_keep').get()).toEqual({
        removed: value,
      })
    } finally {
      await test.close()
    }
  },
)

it('should preserve hidden rowids and storage values for a proven INTEGER to NUMERIC affinity change', async () => {
  const Records = defineTable(
    'records',
    {
      id: string(),
      value: pipe(nullable(number()), column({ physicalType: { sqlite: 'NUMERIC' } })),
    },
    { primaryKey: 'id' },
  )

  const ownership: MigrationOwnershipDeclaration[] = [
    { kind: 'relation', relation: Records, shape: 'additive' },
  ]

  const test = await fixture(
    "create table records(id TEXT primary key not null, value INTEGER, rowid TEXT); insert into records(_rowid_,id,value,rowid) values(91,'id',9223372036854775807,'shadowed')",
  )

  try {
    const native = test.native
      .prepare(
        'select _rowid_,id,typeof(value) as storage,cast(value as text) as value,rowid from records',
      )
      .all()

    await execute(test.executor, [Records], ownership)

    expect(
      test.native
        .prepare(
          'select _rowid_,id,typeof(value) as storage,cast(value as text) as value,rowid from records',
        )
        .all(),
    ).toEqual(native)
  } finally {
    await test.close()
  }
})

it('should check existing NULL values before any rebuild DDL', async () => {
  const Required = defineTable(
    'records',
    { id: pipe(number(), integer()), label: string() },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    'pragma foreign_keys=on; create table records(id INTEGER primary key, label TEXT); insert into records values(1,null)',
  )

  try {
    const before = test.native.prepare('select sql from sqlite_schema').all()

    await expect(execute(test.executor, [Required], [])).rejects.toMatchObject({
      stage: 'precondition',
      outcome: 'unchanged',
      sourceStepIndexes: [0],
    })

    expect(test.native.prepare('select sql from sqlite_schema').all()).toEqual(before)

    expect(test.native.prepare('select * from records').all()).toEqual([
      { id: 1, label: null },
    ])

    expect(test.native.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
  } finally {
    await test.close()
  }
})

/** Returns capability issues without attempting any physical statements. */
async function lowerOnly(
  executor: Executor,
  schemas: readonly TableHandle[],
  ownership: readonly MigrationOwnershipDeclaration[] = [],
) {
  const snapshot = await sqliteDialect.catalog.introspectCatalog(
    executor,
    createCatalogRequest(schemas, ownership),
  )

  const migration = planMigration(schemas, snapshot, sqliteDialect.migration.planning, {
    migrationOwnership: ownership,
  })

  return sqliteDialect.migration.lower(migration, migration.profile)
}

it('should reject unproven conversion without exposing a partial program or changing data', async () => {
  const Unsafe = defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      value: pipe(nullable(number()), column({ physicalType: { sqlite: 'INTEGER' } })),
      note: nullable(string()),
    },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    "create table records(id INTEGER primary key, value TEXT); insert into records values(1,'001')",
  )

  try {
    const result = await lowerOnly(test.executor, [Unsafe])
    expect(result).toEqual({
      issues: [
        expect.objectContaining({
          code: 'compile_failure',
          message: expect.stringContaining('Unproven lossless') as unknown,
          sourceStepIndexes: [0, 1],
        }),
      ],
    })

    expect(test.native.prepare('select * from records').all()).toEqual([
      { id: 1, value: '001' },
    ])
  } finally {
    await test.close()
  }
})

it('should suppress the whole SQLite program when a later declared type fails lowering', async () => {
  const Valid = defineTable(
    'aaa_valid',
    { id: pipe(number(), integer()) },
    { primaryKey: 'id' },
  )

  const Invalid = defineTable(
    'zzz_invalid',
    {
      id: pipe(number(), integer()),
      value: pipe(nullable(string()), column({ physicalType: { sqlite: 'TEXT' } })),
    },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    'create table zzz_invalid(id INTEGER primary key); insert into zzz_invalid values(7)',
  )

  try {
    const snapshot = await sqliteDialect.catalog.introspectCatalog(
      test.executor,
      createCatalogRequest([Valid, Invalid], []),
    )

    const migration = planMigration(
      [Valid, Invalid],
      snapshot,
      sqliteDialect.migration.planning,
    )

    const steps = migration.plan.steps.map((step) =>
      step.kind === 'add_column' ? { ...step, dataType: 'TEXT DEFERRABLE' } : step,
    )

    expect(steps.map((step) => step.kind)).toEqual(['create_table', 'add_column'])

    const result = sqliteDialect.migration.lower(
      { ...migration, plan: { ...migration.plan, steps } },
      migration.profile,
    )

    expect(result).toEqual({
      issues: [
        expect.objectContaining({
          code: 'invalid_target',
          message:
            'SQLite column data type contains constraint syntax: "TEXT DEFERRABLE"',
          sourceStepIndexes: [1],
        }),
      ],
    })

    expect(test.native.prepare('select * from zzz_invalid').all()).toEqual([{ id: 7 }])
  } finally {
    await test.close()
  }
})

it.each([undefined, '(NULL)', 'CURRENT_TIMESTAMP'])(
  'should reject required-column backfill with default %s before DDL',
  async (defaultSql) => {
    const Required = defineTable(
      'records',
      {
        id: pipe(number(), integer()),
        value: pipe(
          string(),
          column(
            defaultSql === undefined
              ? {}
              : {
                  databaseDefault: {
                    kind: 'dialectExpression',
                    dialect: 'sqlite',
                    expression: defaultSql,
                  },
                },
          ),
        ),
      },
      { primaryKey: 'id' },
    )

    const test = await fixture(
      'create table records(id INTEGER primary key); insert into records values(1)',
    )

    try {
      const result = await lowerOnly(test.executor, [Required])
      expect(result).toEqual({
        issues: [
          expect.objectContaining({
            message: 'SQLite required-column backfill is unsupported',
            sourceStepIndexes: [0],
          }),
        ],
      })

      expect(test.native.prepare('select * from records').all()).toEqual([{ id: 1 }])
    } finally {
      await test.close()
    }
  },
)

it('should reject destructive drops with incomplete incoming dependency coverage', async () => {
  const Keep = defineTable(
    'records',
    { id: pipe(number(), integer()) },
    { primaryKey: 'id' },
  )

  const test = await fixture('create table records(id INTEGER primary key, removed TEXT)')
  try {
    const result = await lowerOnly(test.executor, [Keep])
    expect(result).toEqual({
      issues: [
        expect.objectContaining({
          message: expect.stringContaining(
            'complete main namespace dependency evidence',
          ) as unknown,
        }),
      ],
    })
  } finally {
    await test.close()
  }
})

it('should reject a unique-index drop with unobserved incoming FK dependencies before DDL', async () => {
  const Keep = defineTable(
    'parent',
    { id: pipe(number(), integer()), label: string() },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Keep], async ({ db, native }) => {
    native.exec(
      "pragma foreign_keys=on; create table parent(id INTEGER primary key,label TEXT not null); create unique index parent_label_unique on parent(label); create table child(id INTEGER primary key,parent_label TEXT references parent(label)); insert into parent values(1,'valid'); insert into child values(2,'valid')",
    )

    const before = native
      .prepare('select name,sql from sqlite_schema order by name')
      .all()

    expect((await db.migrate().plan()).steps.map((step) => step.kind)).toEqual([
      'drop_index',
    ])

    await expect(db.migrate().allow('dropIndex').execute()).rejects.toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
      sourceStepIndexes: [0],
      capabilityIssues: [
        {
          code: 'compile_failure',
          sourceStepIndexes: [0],
          message:
            'SQLite destructive drops require complete main namespace dependency evidence',
        },
      ],
    })

    expect(
      native.prepare('select name,sql from sqlite_schema order by name').all(),
    ).toEqual(before)

    expect(native.prepare('select * from parent').all()).toEqual([
      { id: 1, label: 'valid' },
    ])

    expect(native.prepare('select * from child').all()).toEqual([
      { id: 2, parent_label: 'valid' },
    ])

    expect(native.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
  })
})

it.each([true, false])(
  'should permit a safe index drop (unique: %s) with appropriate evidence',
  async (unique) => {
    const Keep = defineTable(
      'parent',
      { id: pipe(number(), integer()), label: string() },
      { primaryKey: 'id' },
    )

    const test = await fixture(
      `create table parent(id INTEGER primary key,label TEXT not null); create ${unique ? 'unique ' : ''}index parent_label on parent(label); insert into parent values(1,'value')`,
    )

    try {
      const ownership = unique ? completeMain : []
      const preview = await planned(test.executor, [Keep], ownership)
      expect(preview.program.actions[0].statements).toEqual([
        { sql: 'drop index "main"."parent_label"', params: [] },
      ])

      await execute(test.executor, [Keep], ownership)
      expect(test.native.prepare('pragma index_list(parent)').all()).toEqual([])

      expect(test.native.prepare('select * from parent').all()).toEqual([
        { id: 1, label: 'value' },
      ])
    } finally {
      await test.close()
    }
  },
)

it('should permit a scoped unique-index drop when its candidate key remains', async () => {
  const Keep = defineTable(
    'parent',
    { id: pipe(number(), integer()), label: pipe(string(), column({ unique: true })) },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    "pragma foreign_keys=on; create table parent(id INTEGER primary key,label TEXT not null unique); create unique index redundant_label on parent(label); create table child(id INTEGER primary key,parent_label TEXT references parent(label)); insert into parent values(1,'valid'); insert into child values(2,'valid')",
  )

  try {
    await execute(test.executor, [Keep], [])
    expect(test.native.prepare('pragma index_list(parent)').all()).toHaveLength(1)

    expect(test.native.prepare('select * from child').all()).toEqual([
      { id: 2, parent_label: 'valid' },
    ])
  } finally {
    await test.close()
  }
})

it('should reject a unique-index drop with a retained FK under complete evidence', async () => {
  const Keep = defineTable(
    'parent',
    { id: pipe(number(), integer()), label: string() },
    { primaryKey: 'id' },
  )

  const Child = defineTable(
    'child',
    { id: pipe(number(), integer()), parent_label: nullable(string()) },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    "pragma foreign_keys=on; create table parent(id INTEGER primary key,label TEXT not null); create unique index parent_label_unique on parent(label); create table child(id INTEGER primary key,parent_label TEXT references parent(label)); insert into parent values(1,'valid'); insert into child values(2,'valid')",
  )

  try {
    const before = test.native
      .prepare('select name,sql from sqlite_schema order by name')
      .all()

    const ownership: MigrationOwnershipDeclaration[] = [
      ...completeMain,
      { kind: 'relation', relation: { relation: 'child' }, shape: 'additive' },
    ]

    expect(await lowerOnly(test.executor, [Keep, Child], ownership)).toEqual({
      issues: [
        {
          code: 'compile_failure',
          sourceStepIndexes: [0],
          message:
            'SQLite unique-index drop has a retained incoming foreign-key dependency',
        },
      ],
    })

    expect(
      test.native.prepare('select name,sql from sqlite_schema order by name').all(),
    ).toEqual(before)

    expect(test.native.prepare('select * from child').all()).toEqual([
      { id: 2, parent_label: 'valid' },
    ])
  } finally {
    await test.close()
  }
})

it('should preflight FINAL FK dependencies when dropping a referencing column and its parent together', async () => {
  const Keep = defineTable(
    'child',
    { id: pipe(number(), integer()) },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    'pragma foreign_keys=on; create table parent(id INTEGER primary key); create table child(id INTEGER primary key, parent_id INTEGER references parent(id)); insert into parent values(1); insert into child values(2,1)',
  )

  try {
    await execute(test.executor, [Keep], completeMain, 'dangerous')
    expect(test.native.prepare('select * from child').all()).toEqual([{ id: 2 }])

    expect(
      test.native.prepare("select name from sqlite_schema where name='parent'").all(),
    ).toEqual([])
  } finally {
    await test.close()
  }
})

it('should fail closed for opaque views, actual temporary objects and attached databases', async () => {
  for (const unsupported of [
    'create view opaque as select * from owners',
    'create temp table temporary_object(id INTEGER)',
    "attach database ':memory:' as attached",
  ])
    await assertUnsupportedCatalog(unsupported)
})

/** Confirms unsupported native dependency evidence prevents planning before any DDL. */
async function assertUnsupportedCatalog(unsupported: string) {
  const test = await fixture()
  try {
    test.native.exec(unsupported)
    const before = originalState(test.native)
    await expect(planned(test.executor)).rejects.toThrow(/unmanaged catalog relation/)
    expect(originalState(test.native)).toEqual(before)
  } finally {
    await test.close()
  }
}

it('should roll back a rebuild when final FK validation finds an existing orphan', async () => {
  const Child = defineTable(
    'child',
    { id: pipe(number(), integer()), owner_id: nullable(reference(Owner, 'id')) },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    'pragma foreign_keys=on; create table owners(id INTEGER primary key); insert into owners values(1); create table child(id INTEGER primary key,owner_id INTEGER); insert into child values(2,999)',
  )

  try {
    const before = test.native
      .prepare('select name,sql from sqlite_schema order by name')
      .all()

    await expect(execute(test.executor, [Child, Owner], [])).rejects.toMatchObject({
      stage: 'validation',
      outcome: 'rolledBack',
      sourceStepIndexes: [0],
      message: expect.stringContaining('SQLite foreign_key_check failed') as string,
    })

    expect(
      test.native.prepare('select name,sql from sqlite_schema order by name').all(),
    ).toEqual(before)

    expect(test.native.prepare('select * from child').all()).toEqual([
      { id: 2, owner_id: 999 },
    ])

    expect(test.native.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
  } finally {
    await test.close()
  }
})

it('should reserve deterministic replacement names against existing namespace objects', async () => {
  const test = await fixture()
  try {
    const first = await planned(test.executor)
    const firstSql = first.program.actions[0].statements[0].sql
    const name = /"main"\."([^"]+)"/.exec(firstSql)?.[1]

    if (!name) throw new Error('Missing replacement name')

    test.native.exec(`create table "${name}"(id INTEGER)`)
    const next = await planned(test.executor)
    expect(next.program.actions[0].statements[0].sql).not.toBe(firstSql)
    expect((await planned(test.executor)).program).toEqual(next.program)
    await execute(test.executor)

    expect(
      test.native.prepare('select name from sqlite_schema where name=?').all(name),
    ).toHaveLength(1)
  } finally {
    await test.close()
  }
})

it.each([false, true])(
  'should retain the acknowledged outcome and primary error when FK restoration fails (DDL failure: %s)',
  async (failDdl) => {
    const test = await fixture()
    const discard = vi.fn<() => void>()
    try {
      const { program } = await planned(test.executor)
      const before = originalState(test.native)
      const executor: Executor = {
        execute: (query) => test.executor.execute(query),
        /** Injects only the selected DDL and post-transaction cleanup failures. */
        run: async (query) => {
          if (query.sql === 'pragma foreign_keys=1')
            throw new Error('FK restore injected')

          if (failDdl && query.sql === program.actions[0].statements[0].sql)
            throw new Error('DDL injected')

          await test.executor.run(query)
        },
      }

      await expectRuntimeFailure(
        () =>
          sqliteDialect.migration.execute({
            executor,
            databaseIdentity: ':memory:',
            discard,
            cancel: async () => undefined,
            prepare: async () => program,
          }),
        failDdl ? 'ddl' : 'sessionCleanup',
        failDdl ? 'rolledBack' : 'applied',
        failDdl ? 'DDL injected' : 'FK restore injected',
        'FK restore injected',
      )

      expect(discard).toHaveBeenCalled()

      expect(test.native.prepare('select * from child').all()).toEqual(before.child)

      expect(
        test.native
          .prepare('pragma table_info(parent)')
          .all()
          .map((row) => row.name),
      ).toEqual(
        failDdl
          ? ['id', 'label', 'retained', 'retained_owner_id']
          : ['id', 'label', 'retained', 'retained_owner_id', 'nick', 'owner_id'],
      )

      expect(inTransaction(test.native)).toBe(false)
    } finally {
      await test.close()
    }
  },
)

it('should reject concurrent mode on SQLite even for an empty program while semantic planning is unchanged', async () => {
  await withSqliteDatabase([], async ({ db, native }) => {
    const attempts = trackNativeMutations(native)
    const migration = db.migrate().concurrentIndexes().allowPartialApplication()
    await expect(migration.plan()).resolves.toEqual({ steps: [] })

    await expect(migration.dryRun()).rejects.toThrow(
      'SQLite does not support concurrent index execution',
    )

    await expect(migration.execute()).rejects.toMatchObject({
      stage: 'lowering',
      outcome: 'unchanged',
    })

    expect(attempts).toEqual([])
  })
})
