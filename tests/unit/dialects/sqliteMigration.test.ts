import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { integer, nullable, number, pipe, string } from 'valibot'
import { expect, it, vi } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationProgram } from '@/ddl/migrationProgram'
import {
  column,
  createDatabase,
  defineTable,
  reference,
  resolveDialect,
  sqliteDialect,
} from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import type { Executor } from '@/query'
import type { TableHandle } from '@/types'

const main = [{ role: 'database' as const, spelling: 'main' }]
const completeMain: MigrationOwnershipDeclaration[] = [
  { kind: 'completeNamespace', namespace: main },
]

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
  const native = await connector.getInstance!()
  native.exec(sql)
  const provider = sqliteDialect.operations.createSessionProvider(connector)
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
      await session.release('discard')
      await provider.close()
    },
  }
}

/** Performs the production desired-schema/catalog/planning/lowering pipeline. */
async function planned(
  executor: Executor,
  schemas: readonly TableHandle[] = [Parent, Owner],
  ownership: readonly MigrationOwnershipDeclaration[] = additive,
) {
  const snapshot = await sqliteDialect.catalog.introspectCatalog(
    executor,
    createCatalogRequest(schemas, ownership),
  )

  const migration = planMigration(schemas, snapshot, sqliteDialect.migration.planning, {
    migrationOwnership: ownership,
  })

  const result = sqliteDialect.migration.lower(migration, migration.profile)

  if (result.issues)
    throw new Error(result.issues.map((issue) => issue.message).join('\n'))

  return { migration, program: result.program }
}

/** Runs the production runtime and verifies convergence before committing. */
async function execute(
  executor: Executor,
  schemas: readonly TableHandle[] = [Parent, Owner],
  ownership: readonly MigrationOwnershipDeclaration[] = additive,
) {
  return sqliteDialect.migration.execute({
    executor,
    databaseIdentity: ':memory:',
    discard: () => undefined,
    cancel: async () => undefined,
    prepare: async () => (await planned(executor, schemas, ownership)).program,
    validate: async () => {
      expect((await planned(executor, schemas, ownership)).migration.plan.steps).toEqual(
        [],
      )
    },
  })
}

it('resolves the production member and creates a desired FK graph through Client', async () => {
  expect(resolveDialect('sqlite')).toBe(sqliteDialect)
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const db = createDatabase({ connector, schemas: [Parent, Owner] })
  try {
    const preview = await db.migrate().dryRun()
    expect(preview.actions).toHaveLength(2)
    expect(preview.actions[0]!.statements[0]!.sql).toContain('"owners"')
    await db.migrate().execute()
    expect(await db.migrate().plan()).toEqual({ steps: [] })
    expect((await db.migrate().dryRun()).actions).toEqual([])
  } finally {
    await db.close()
  }
})

it('rejects an implicit rowid alias conversion even when the semantic plan is empty', async () => {
  const Records = defineTable(
    'records',
    { id: pipe(number(), integer()) },
    { primaryKey: 'id' },
  )

  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance!()
  native.exec(
    'create table records(id INT primary key not null); insert into records values(7)',
  )

  const db = createDatabase({ connector, schemas: [Records] })
  try {
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
  } finally {
    await db.close()
  }
})

it('coalesces touching changes and retains additive data, constraints, indexes and sequence state', async () => {
  const test = await fixture()
  try {
    const before = await planned(test.executor)
    expect(before.program.actions).toHaveLength(1)

    expect(before.program.actions[0]!.sourceStepIndexes).toEqual(
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

it('uses direct legal ADD COLUMN without rebuilding existing rowids', async () => {
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
      program.actions[0]!.statements.every((query) =>
        query.sql.startsWith('alter table'),
      ),
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

it('rolls back catalog, data and FK policy after failure at every rebuild statement', async () => {
  const seed = await fixture()
  const program = (await planned(seed.executor)).program
  await seed.close()
  for (const [index] of program.actions[0]!.statements.entries())
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
      sourceStepIndexes: program.actions[0]!.sourceStepIndexes,
      message: `injected ${index}`,
    })

    expect(originalState(test.native)).toEqual(before)
    expect(test.native.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
    expect(test.native.isTransaction).toBe(false)
  } finally {
    await test.close()
  }
}

it('permits owned drops with complete incoming dependency evidence and converges', async () => {
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

    await execute(test.executor, [Keep], completeMain)

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

it('preserves hidden rowids and storage values for a proven INTEGER to NUMERIC affinity change', async () => {
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

it('checks existing NULL values before any rebuild DDL', async () => {
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

it('rejects unproven conversion without exposing a partial program or changing data', async () => {
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

it.each([undefined, '(NULL)', 'CURRENT_TIMESTAMP'])(
  'rejects required-column backfill with default %s before DDL',
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

it('rejects destructive drops with incomplete incoming dependency coverage', async () => {
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

it('rejects a unique-index drop with unobserved incoming FK dependencies before DDL', async () => {
  const Keep = defineTable(
    'parent',
    { id: pipe(number(), integer()), label: string() },
    { primaryKey: 'id' },
  )

  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance!()
  native.exec(
    "pragma foreign_keys=on; create table parent(id INTEGER primary key,label TEXT not null); create unique index parent_label_unique on parent(label); create table child(id INTEGER primary key,parent_label TEXT references parent(label)); insert into parent values(1,'valid'); insert into child values(2,'valid')",
  )

  const db = createDatabase({ connector, schemas: [Keep] })
  try {
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
  } finally {
    await db.close()
  }
})

it.each([true, false])(
  'permits a safe index drop (unique: %s) with appropriate evidence',
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
      expect(preview.program.actions[0]!.statements).toEqual([
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

it('permits a scoped unique-index drop when its candidate key remains', async () => {
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

it('rejects a unique-index drop with a retained FK under complete evidence', async () => {
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

it('preflights FINAL FK dependencies when dropping a referencing column and its parent together', async () => {
  const Keep = defineTable(
    'child',
    { id: pipe(number(), integer()) },
    { primaryKey: 'id' },
  )

  const test = await fixture(
    'pragma foreign_keys=on; create table parent(id INTEGER primary key); create table child(id INTEGER primary key, parent_id INTEGER references parent(id)); insert into parent values(1); insert into child values(2,1)',
  )

  try {
    await execute(test.executor, [Keep], completeMain)
    expect(test.native.prepare('select * from child').all()).toEqual([{ id: 2 }])

    expect(
      test.native.prepare("select name from sqlite_schema where name='parent'").all(),
    ).toEqual([])
  } finally {
    await test.close()
  }
})

it('fails closed for opaque views, actual temporary objects and attached databases', async () => {
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

it('rolls back a rebuild when final FK validation finds an existing orphan', async () => {
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
      message: 'SQLite foreign_key_check failed',
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

it('reserves deterministic replacement names against existing namespace objects', async () => {
  const test = await fixture()
  try {
    const first = await planned(test.executor)
    const firstSql = first.program.actions[0]!.statements[0]!.sql
    const name = /"main"\."([^"]+)"/.exec(firstSql)?.[1]

    if (!name) throw new Error('Missing replacement name')

    test.native.exec(`create table "${name}"(id INTEGER)`)
    const next = await planned(test.executor)
    expect(next.program.actions[0]!.statements[0]!.sql).not.toBe(firstSql)
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
  'retains the acknowledged outcome and primary error when FK restoration fails (DDL failure: %s)',
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

          if (failDdl && query.sql === program.actions[0]!.statements[0]!.sql)
            throw new Error('DDL injected')

          await test.executor.run(query)
        },
      }

      await expect(
        sqliteDialect.migration.execute({
          executor,
          databaseIdentity: ':memory:',
          discard,
          cancel: async () => undefined,
          prepare: async () => program,
        }),
      ).rejects.toMatchObject({
        stage: failDdl ? 'ddl' : 'sessionCleanup',
        message: failDdl ? 'DDL injected' : 'FK restore injected',
        outcome: failDdl ? 'rolledBack' : 'applied',
        cleanupFailures: [
          { stage: 'sessionCleanup', cause: new Error('FK restore injected') },
        ],
      })

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

      expect(test.native.isTransaction).toBe(false)
    } finally {
      await test.close()
    }
  },
)
