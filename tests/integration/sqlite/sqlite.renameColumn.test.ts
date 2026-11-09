import { DatabaseSync } from 'node:sqlite'
import { nullable, number, pipe, string } from 'valibot'
import { expect, it, vi } from 'vitest'

import { column, defineTable, reference, sqliteDialect } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

const User = defineTable(
  'rename_users',
  { id: string(), fullName: nullable(string()) },
  { primaryKey: 'id', indexes: [{ columns: ['fullName', 'id'] }] },
)

const seed = `create table rename_users(id TEXT primary key not null, displayName TEXT); insert into rename_users values ('1','ordinary'), ('2','\u4f60\u597d\ud83d\ude80'), ('3',null); create index historical_name on rename_users(displayName,id)`

it('should produce equal plans for equivalent SQLite intent spellings in either order', async () => {
  await withSqliteDatabase([User], async ({ db, native }) => {
    native.exec(seed)
    const lower = { table: User, from: 'displayName', to: 'fullName' }
    const upper = { table: User, from: 'DISPLAYNAME', to: 'FULLNAME' }
    const first = db.migrate().renameColumn(lower).renameColumn(upper)
    const second = db.migrate().renameColumn(upper).renameColumn(lower)
    expect(await first.plan()).toEqual(await second.plan())
    await first.execute()

    expect(
      native
        .prepare('select fullName as value from rename_users order by id')
        .all()
        .map((row) => row.value),
    ).toEqual(['ordinary', '\u4f60\u597d\ud83d\ude80', null])
  })
})

it('should report missing table SQL as a lowering capability issue with rename provenance', async () => {
  await withSqliteDatabase([User], async ({ db, native }) => {
    native.exec(seed)
    const original = sqliteDialect.migration.lower

    const spy = vi
      .spyOn(sqliteDialect.migration, 'lower')
      .mockImplementation((planned, expected, policy) => {
        const catalogSnapshot = {
          ...planned.catalogSnapshot,
          namespaces: {
            ...planned.catalogSnapshot.namespaces,
            items: planned.catalogSnapshot.namespaces.items.map((namespace) => ({
              ...namespace,
              relations: {
                ...namespace.relations,
                items: namespace.relations.items.map((relation) => ({
                  ...relation,
                  nativeDefinition: { state: 'unknown' as const, reason: 'missing SQL' },
                })),
              },
            })),
          },
        }

        return original({ ...planned, catalogSnapshot }, expected, policy)
      })

    try {
      const migration = db
        .migrate()
        .renameColumn({ table: User, from: 'displayName', to: 'fullName' })

      for (const invoke of [() => migration.dryRun(), () => migration.execute()]) {
        const error = await invoke().catch((cause: unknown) => cause)
        expect(error).toMatchObject({
          stage: 'lowering',
          sourceStepIndexes: [0],
          capabilityIssues: [expect.objectContaining({ sourceStepIndexes: [0] })],
        })

        expect(error).not.toHaveProperty('defect', true)
      }

      expect(native.prepare('select displayName from rename_users').all()).toHaveLength(3)
    } finally {
      spy.mockRestore()
    }
  })
})

it('should preserve native values and historical composite indexes, preview read-only, and converge with and without intent', async () => {
  await withSqliteDatabase([User], async ({ db, native }) => {
    native.exec(seed)

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
      native
        .prepare('select displayName from rename_users order by id')
        .all()
        .map((row) => row.displayName),
    ).toEqual(['ordinary', '\u4f60\u597d\ud83d\ude80', null])

    await migration.execute()

    expect(
      native
        .prepare('select fullName from rename_users order by id')
        .all()
        .map((row) => row.fullName),
    ).toEqual(['ordinary', '\u4f60\u597d\ud83d\ude80', null])

    expect(await migration.plan()).toEqual({ steps: [] })
    expect(await db.migrate().plan()).toEqual({ steps: [] })
    expect((await migration.dryRun()).actions).toEqual([])
    await migration.execute()

    expect(
      native
        .prepare(
          "select name from sqlite_schema where type='index' and name='historical_name'",
        )
        .all(),
    ).toHaveLength(1)
  })
})

it('should create fresh desired storage without replaying obsolete intent', async () => {
  await withSqliteDatabase([User], async ({ db }) => {
    const migration = db
      .migrate()
      .renameColumn({ table: User, from: 'displayName', to: 'fullName' })

    expect(
      (await migration.plan()).steps.some((step) => step.kind === 'rename_column'),
    ).toBe(false)

    await migration.execute()
    expect(await migration.plan()).toEqual({ steps: [] })
  })
})

it.each(['both', 'neither'] as const)(
  'should reject %s names before DDL and retain values',
  async (kind) => {
    await withSqliteDatabase([User], async ({ db, native }) => {
      native.exec(
        `create table rename_users(id TEXT primary key not null, ${kind === 'both' ? 'displayName TEXT, fullName TEXT' : 'other TEXT'}); insert into rename_users(id) values ('kept')`,
      )

      const before = native.prepare('select * from rename_users').all()

      await expect(
        db
          .migrate()
          .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
          .execute(),
      ).rejects.toMatchObject({ stage: 'planning', outcome: 'unchanged' })

      expect(native.prepare('select * from rename_users').all()).toEqual(before)
    })
  },
)

it('should check NOT NULL at the original address and copy renamed values through a rebuild', async () => {
  const Required = defineTable(
    'rename_users',
    { id: string(), fullName: string() },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Required], async ({ db, native }) => {
    native.exec(
      "create table rename_users(id TEXT primary key not null, displayName TEXT); insert into rename_users values ('1','\u00e9\u03bb')",
    )

    const migration = db
      .migrate()
      .renameColumn({ table: Required, from: 'displayName', to: 'fullName' })

    expect((await migration.dryRun()).preconditions).toContainEqual(
      expect.objectContaining({
        kind: 'column_has_no_nulls',
        column: 'displayName',
        sourceStepIndexes: [1],
      }),
    )

    await migration.execute()

    expect(native.prepare('select fullName from rename_users').get()).toMatchObject({
      fullName: '\u00e9\u03bb',
    })

    expect(await migration.plan()).toEqual({ steps: [] })
  })

  await withSqliteDatabase([Required], async ({ db, native }) => {
    native.exec(
      "create table rename_users(id TEXT primary key not null, displayName TEXT); insert into rename_users values ('1',null)",
    )

    await expect(
      db
        .migrate()
        .renameColumn({ table: Required, from: 'displayName', to: 'fullName' })
        .execute(),
    ).rejects.toMatchObject({ stage: 'precondition' })

    expect(native.prepare('select displayName from rename_users').get()).toMatchObject({
      displayName: null,
    })
  })
})

it('should roll back a native rename when later DDL fails', async () => {
  const Required = defineTable(
    'rename_users',
    { id: string(), fullName: string() },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Required], async ({ db, native }) => {
    native.exec(
      "create table rename_users(id TEXT primary key not null, displayName TEXT); insert into rename_users values ('1','kept')",
    )

    const prepare = native.prepare.bind(native)
    vi.spyOn(native, 'prepare').mockImplementation((sql, options) => {
      if (/^create table .*__stratom_rebuild_/i.test(sql))
        throw new Error('forced later failure')

      return prepare(sql, options)
    })

    await expect(
      db
        .migrate()
        .renameColumn({ table: Required, from: 'displayName', to: 'fullName' })
        .execute(),
    ).rejects.toMatchObject({ stage: 'ddl', outcome: 'rolledBack' })

    expect(native.prepare('select displayName from rename_users').get()).toMatchObject({
      displayName: 'kept',
    })
  })
})

it('should preserve renamed primary keys and inbound/self foreign keys outside ownership', async () => {
  const Parent = defineTable('parent', { fullName: string() }, { primaryKey: 'fullName' })
  await withSqliteDatabase(
    [Parent],
    async ({ db, native }) => {
      native.exec(
        `pragma foreign_keys=on; create table parent(displayName TEXT primary key not null, parent TEXT references parent(displayName)); create table child(value TEXT references parent(displayName)); insert into parent values('kept','kept'); insert into child values('kept')`,
      )

      const migration = db
        .migrate()
        .renameColumn({ table: Parent, from: 'displayName', to: 'fullName' })

      await migration.execute()

      expect(native.prepare('select fullName,parent from parent').all()).toEqual([
        { fullName: 'kept', parent: 'kept' },
      ])

      expect(native.prepare('pragma foreign_key_check').all()).toEqual([])

      expect(native.prepare('pragma foreign_key_list(child)').all()).toContainEqual(
        expect.objectContaining({ to: 'fullName' }),
      )

      expect(native.prepare('pragma foreign_key_list(parent)').all()).toContainEqual(
        expect.objectContaining({ to: 'fullName' }),
      )

      expect(await migration.plan()).toEqual({ steps: [] })
      expect(await db.migrate().plan()).toEqual({ steps: [] })
    },
    { migrationOwnership: [{ kind: 'relation', relation: Parent, shape: 'additive' }] },
  )
})

it('should reject opaque dependencies and unsupported residual work before renaming', async () => {
  await withSqliteDatabase([User], async ({ db, native }) => {
    native.exec(
      seed + '; create trigger opaque after update on rename_users begin select 1; end',
    )

    await expect(
      db
        .migrate()
        .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
        .execute(),
    ).rejects.toThrow(/./)

    expect(
      native.prepare('select displayName from rename_users order by id').all(),
    ).toHaveLength(3)
  })
})

it('should snapshot each public invocation and copy caller intent', async () => {
  await withSqliteDatabase([User], async ({ db, native }) => {
    native.exec(seed)
    const intent = { table: User, from: 'displayName', to: 'fullName' }
    const migration = db.migrate().renameColumn(intent)
    intent.from = 'changedAfterDeclaration'
    const first = migration.plan()
    migration.renameColumn({ table: User, from: 'conflict', to: 'fullName' })

    expect((await first).steps).toMatchObject([
      { kind: 'rename_column', from: { spelling: 'displayName' } },
    ])

    await expect(migration.plan()).rejects.toThrow('overlapping')
    expect(native.prepare('select displayName from rename_users').all()).toHaveLength(3)
  })
})

it('should keep residual destructive data guards after rename planning', async () => {
  await withSqliteDatabase(
    [User],
    async ({ db, native }) => {
      native.exec(
        seed +
          "; alter table rename_users add column legacy TEXT; update rename_users set legacy='protected'",
      )

      const migration = db
        .migrate()
        .renameColumn({ table: User, from: 'displayName', to: 'fullName' })

      await expect(migration.execute()).rejects.toMatchObject({ stage: 'precondition' })

      expect(
        native.prepare('select displayName,legacy from rename_users').all(),
      ).toHaveLength(3)

      await migration.allow('dangerouslyDropColumn').execute()
      expect(native.prepare('select fullName from rename_users').all()).toHaveLength(3)
    },
    { migrationOwnership: [{ kind: 'completeNamespace' }] },
  )
})

it('should reject SQLite case-only identifiers before native rename', async () => {
  await withSqliteDatabase([User], async ({ db, native }) => {
    native.exec(seed)

    await expect(
      db
        .migrate()
        .renameColumn({ table: User, from: 'FULLNAME', to: 'fullName' })
        .execute(),
    ).rejects.toThrow('comparison keys')

    expect(native.prepare('select displayName from rename_users').all()).toHaveLength(3)
  })
})

it('should reject unsupported later alterations before native rename', async () => {
  const Numeric = defineTable(
    'rename_users',
    { id: string(), fullName: nullable(number()) },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Numeric], async ({ db, native }) => {
    native.exec(
      "create table rename_users(id TEXT primary key not null, displayName TEXT); insert into rename_users values ('1','kept')",
    )

    await expect(
      db
        .migrate()
        .renameColumn({ table: Numeric, from: 'displayName', to: 'fullName' })
        .execute(),
    ).rejects.toMatchObject({ stage: 'lowering' })

    expect(native.prepare('select displayName from rename_users').get()).toMatchObject({
      displayName: 'kept',
    })
  })
})

it('should cancel without replay and preserve values through a fresh session', async () => {
  await withSqliteDatabase(
    [User],
    async ({ db, native, filePath }) => {
      native.exec(seed)

      await expect(
        db
          .migrate()
          .renameColumn({ table: User, from: 'displayName', to: 'fullName' })
          .execute({ signal: AbortSignal.abort() }),
      ).rejects.toThrow(/./)

      const fresh = new DatabaseSync(filePath!)
      try {
        expect(
          fresh
            .prepare('select displayName from rename_users order by id')
            .all()
            .map((row) => row.displayName),
        ).toEqual(['ordinary', '\u4f60\u597d\ud83d\ude80', null])
      } finally {
        fresh.close()
      }
    },
    { file: true },
  )
})

it('should preserve unique keys, local foreign keys, and authored index names without retained intent', async () => {
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

  await withSqliteDatabase([Member, Owner], async ({ db, native }) => {
    native.exec(
      `pragma foreign_keys=on; create table owners(id TEXT primary key not null); insert into owners values('kept'); create table members(id TEXT primary key not null, displayName TEXT unique references owners(id)); create index authored_members on members(displayName,id); insert into members values('1','kept')`,
    )

    const migration = db
      .migrate()
      .renameColumn({ table: Member, from: 'displayName', to: 'fullName' })

    expect((await migration.plan()).steps.map((step) => step.kind)).toEqual([
      'rename_column',
    ])

    await migration.execute()

    expect(native.prepare('select fullName from members').all()).toEqual([
      { fullName: 'kept' },
    ])

    expect(native.prepare('pragma foreign_key_check').all()).toEqual([])

    expect(
      native
        .prepare(
          "select name from sqlite_schema where type='index' and name='authored_members'",
        )
        .all(),
    ).toHaveLength(1)

    expect(await migration.plan()).toEqual({ steps: [] })
    expect(await db.migrate().plan()).toEqual({ steps: [] })
  })
})
