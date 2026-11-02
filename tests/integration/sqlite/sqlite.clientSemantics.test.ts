import {
  bigint,
  boolean,
  date,
  integer,
  nullable,
  number,
  object,
  pipe,
  string,
} from 'valibot'
import { expect, it } from 'vitest'

import { sqliteCatalog } from '@/dialects/sqlite/catalog'
import { column, createDatabase, defineTable, reference } from '@/index'

import { withSqliteConnector, withSqliteDatabase } from './sqliteIntegration'

it.each([
  { label: 'closes during the transaction', closeDuringTransaction: true },
  { label: 'closes after the transaction', closeDuringTransaction: false },
])(
  'should keep a shared connector open when another Client fails and $label',
  async ({ closeDuringTransaction }) => {
    const Records = defineTable(
      'records',
      { id: pipe(number(), integer()), label: string() },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase([Records], async ({ db: first, connector }) => {
      const second = createDatabase({ connector, schemas: [Records] })

      try {
        await first.migrate().execute()
        await first.insert(Records).values({ id: 1, label: 'committed' }).execute()

        await first.transaction(async (transaction) => {
          await transaction
            .insert(Records)
            .values({ id: 2, label: 'transaction' })
            .execute()

          await expect(second.ping()).rejects.toThrow(/already leased/)

          if (closeDuringTransaction) await second.close()

          expect(await transaction.from(Records).execute()).toEqual([
            { id: 1, label: 'committed' },
            { id: 2, label: 'transaction' },
          ])
        })

        expect(await first.from(Records).execute()).toEqual([
          { id: 1, label: 'committed' },
          { id: 2, label: 'transaction' },
        ])

        expect((await first.migrate().dryRun()).actions).toEqual([])
      } finally {
        await second.close()
      }
    })
  },
)

it('should not retain a provider when Client creation rejects an invalid SQLite namespace', async () => {
  await withSqliteConnector(async ({ connector, native }) => {
    expect(() =>
      createDatabase({
        connector,
        schemas: [],
        defaultNamespace: [{ role: 'database', spelling: 'aux' }],
      }),
    ).toThrow(/SQLite query registration default/)

    const db = createDatabase({ connector, schemas: [] })
    try {
      await db.ping()
    } finally {
      await db.close()
    }

    expect(() => native.prepare('select 1')).toThrow(/not open/)
  })
})

it.each([42n, 9007199254740993n, 9223372036854775807n, -9223372036854775808n])(
  'should round-trip BIGINT %s through RETURNING and SELECT without changing storage',
  async (value) => {
    const Records = defineTable(
      'records',
      { id: pipe(number(), integer()), value: bigint() },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase([Records], async ({ db, native }) => {
      await db.migrate().execute()

      expect(await db.insert(Records).values({ id: 1, value }).execute()).toEqual([
        { id: 1, value },
      ])

      expect(await db.from(Records).execute()).toEqual([{ id: 1, value }])
      const stored = native.prepare('select value,typeof(value) as storage from records')
      stored.setReadBigInts(true)
      expect(stored.all()).toEqual([{ value, storage: 'integer' }])
    })
  },
)

it('should return authored names and logical values from case-equivalent native columns', async () => {
  const Records = defineTable(
    'records',
    { id: pipe(number(), integer()), active: boolean() },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Records], async ({ db, native }) => {
    native.exec(
      'create table records(ID INTEGER primary key,ACTIVE BOOLEAN not null); insert into records values(1,1)',
    )

    expect(await db.migrate().plan()).toEqual({ steps: [] })
    expect(await db.from(Records).execute()).toEqual([{ id: 1, active: true }])

    expect(await db.from(Records).select([Records.active]).execute()).toEqual([
      { active: true },
    ])

    expect(
      await db
        .from(Records)
        .select(() => [{ kind: 'column' as const, column: 'active', alias: 'Enabled' }])
        .execute(),
    ).toEqual([{ Enabled: true }])

    expect(await db.insert(Records).values({ id: 2, active: false }).execute()).toEqual([
      { id: 2, active: false },
    ])

    expect(
      await db
        .update(Records)
        .set({ active: true })
        .where({ id: 2 })
        .returning([Records.active])
        .execute(),
    ).toEqual([{ active: true }])

    expect(await db.delete(Records).where({ id: 2 }).execute()).toEqual([
      { id: 2, active: true },
    ])

    expect(native.prepare('select ID,ACTIVE from records').all()).toEqual([
      { ID: 1, ACTIVE: 1 },
    ])
  })
})

it('should use logical boolean, Date and JSON mapping with physical INTEGER and TEXT overrides', async () => {
  const Records = defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      active: pipe(nullable(boolean()), column({ physicalType: { sqlite: 'INTEGER' } })),
      stamp: pipe(nullable(date()), column({ physicalType: { sqlite: 'TEXT' } })),
      data: pipe(
        nullable(object({ label: string() })),
        column({ physicalType: { sqlite: 'TEXT' } }),
      ),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Records], async ({ db, native }) => {
    const row = {
      id: 1,
      active: true,
      stamp: new Date('2026-01-02T03:04:05.000Z'),
      data: { label: 'value' },
    }

    await db.migrate().execute()
    expect(await db.insert(Records).values(row).execute()).toEqual([row])
    expect(await db.from(Records).execute()).toEqual([row])

    expect(native.prepare('select active,stamp,data from records').all()).toEqual([
      { active: 1, stamp: '2026-01-02T03:04:05.000Z', data: '{"label":"value"}' },
    ])

    const empty = { id: 2, active: null, stamp: null, data: null }
    expect(await db.insert(Records).values(empty).execute()).toEqual([empty])
    expect(await db.from(Records).where({ id: 2 }).execute()).toEqual([empty])
  })
})

it('should retain target logical context for reference-only columns with physical overrides', async () => {
  const Parents = defineTable(
    'parents',
    {
      id: pipe(number(), integer()),
      flag: pipe(
        boolean(),
        column({ unique: true, physicalType: { sqlite: 'INTEGER' } }),
      ),
    },
    { primaryKey: 'id' },
  )

  const Children = defineTable(
    'children',
    {
      id: pipe(number(), integer()),
      parentFlag: nullable(reference(Parents, 'flag')),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Parents, Children], async ({ db, native }) => {
    await db.migrate().execute()
    await db.insert(Parents).values({ id: 1, flag: true }).execute()

    expect(
      await db.insert(Children).values({ id: 2, parentFlag: true }).execute(),
    ).toEqual([{ id: 2, parentFlag: true }])

    expect(await db.from(Children).execute()).toEqual([{ id: 2, parentFlag: true }])

    expect(native.prepare('select parentFlag from children').all()).toEqual([
      { parentFlag: 1 },
    ])

    expect(
      await db.insert(Children).values({ id: 3, parentFlag: null }).execute(),
    ).toEqual([{ id: 3, parentFlag: null }])
  })
})

it.each(['a  b', "x;y -- /* select DROP $ :: 'quote'"])(
  'should preserve a literal default %s and converge after native insertion',
  async (value) => {
    const Records = defineTable(
      'records',
      {
        id: pipe(number(), integer()),
        label: pipe(string(), column({ databaseDefault: { kind: 'literal', value } })),
      },
      { primaryKey: 'id' },
    )

    await withSqliteDatabase([Records], async ({ db, native }) => {
      await db.migrate().execute()
      expect((await db.migrate().dryRun()).actions).toEqual([])
      native.exec('insert into records(id) values(1)')
      expect(await db.from(Records).execute()).toEqual([{ id: 1, label: value }])
    })
  },
)

it('should not treat different whitespace inside expression literals as default convergence', async () => {
  const Records = defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      label: pipe(
        string(),
        column({
          databaseDefault: {
            kind: 'dialectExpression',
            dialect: 'sqlite',
            expression: "lower('a b')",
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Records], async ({ db, native }) => {
    native.exec(
      "create table records(id INTEGER primary key,label TEXT not null default (lower('a  b')))",
    )

    const failure = await db
      .migrate()
      .dryRun()
      .catch((cause: unknown) => cause)

    expect((failure as Error).message).toMatch(/Migration planning failed/i)
    expect(JSON.stringify(failure)).toMatch(/unsupported default change/i)
    native.exec('insert into records(id) values(1)')
    expect(native.prepare('select label from records').all()).toEqual([{ label: 'a  b' }])
  })
})

it('should keep column and client mapping precedence and pass physical types to custom mappers', async () => {
  const Records = defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      active: pipe(
        boolean(),
        column({
          physicalType: { sqlite: 'INTEGER' },
          mapParam: () => 1,
          mapResult: () => true,
        }),
      ),
      other: pipe(boolean(), column({ physicalType: { sqlite: 'INTEGER' } })),
    },
    { primaryKey: 'id' },
  )

  const seen: unknown[][] = []
  await withSqliteDatabase(
    [Records],
    async ({ db, native }) => {
      await db.migrate().execute()

      expect(
        await db.insert(Records).values({ id: 1, active: false, other: true }).execute(),
      ).toEqual([{ id: 1, active: true, other: 'custom' }])

      expect(seen).toEqual([
        ['INTEGER', 1],
        ['INTEGER', true],
      ])

      expect(native.prepare('select active,other from records').all()).toEqual([
        { active: 1, other: 0 },
      ])
    },
    {
      map: {
        /**
         * Records the unchanged physical type and raw logical input before dialect
         * mapping.
         */
        mapParamValue: (dataType, value) => {
          seen.push([dataType, value])
          return typeof value === 'boolean' ? 0 : value
        },
        /** Makes the client result override distinguishable from logical boolean mapping. */
        mapResultValue: (_dataType, value) => (value === 0 ? 'custom' : value),
      },
    },
  )
})

it('should fail closed for repeated FK target columns instead of deduplicating candidate keys', async () => {
  await withSqliteDatabase([], async ({ native }) => {
    native.exec(
      'create table parent(a INTEGER,b INTEGER,unique(a,b)); create table child(x INTEGER,y INTEGER,foreign key(x,y) references parent(a,a))',
    )

    const snapshot = await sqliteCatalog.introspectCatalog(
      {
        execute: async (query) => native.prepare(query.sql).all(...(query.params as [])),
      },
      {
        relations: [],
        absentRelations: [],
        completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
      },
    )

    const child = snapshot.namespaces.items[0].relations.items.find(
      (relation) => relation.identity.relation.spelling === 'child',
    )!

    expect(child.management).toBe('unmanaged')

    expect(child.table).toMatchObject({
      state: 'present',
      value: {
        foreignKeys: {
          items: [
            expect.objectContaining({
              referencedColumns: ['a', 'a'],
              validity: { state: 'present', value: 'invalid' },
            }),
          ],
        },
      },
    })
  })
})

it.each(['unique(a,b)', 'primary key(a,b)'])(
  'should adopt a valid FK permutation of %s and preserve source/target pair order',
  async (key) => {
    await withSqliteDatabase([], async ({ native }) => {
      native.exec(
        `pragma foreign_keys=on; create table parent(a INTEGER,b TEXT,${key}); create table child(id INTEGER primary key,x TEXT,y INTEGER,foreign key(x,y) references parent(b,a)); insert into parent values(1,'A'); insert into child values(3,'A',1)`,
      )

      const snapshot = await sqliteCatalog.introspectCatalog(
        {
          execute: async (query) =>
            native.prepare(query.sql).all(...(query.params as [])),
        },
        {
          relations: [],
          absentRelations: [],
          completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
        },
      )

      const child = snapshot.namespaces.items[0].relations.items.find(
        (relation) => relation.identity.relation.spelling === 'child',
      )!

      expect(child.management).toBe('managed')

      expect(child.table).toMatchObject({
        state: 'present',
        value: {
          foreignKeys: {
            coverage: { state: 'complete' },
            items: [
              expect.objectContaining({
                columns: ['x', 'y'],
                referencedColumns: ['b', 'a'],
                semantics: { state: 'present', value: { kind: 'simple' } },
                validity: { state: 'present', value: 'valid' },
              }),
            ],
          },
        },
      })

      expect(native.prepare('pragma foreign_key_check').all()).toEqual([])
    })
  },
)
