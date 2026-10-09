import nodeSqliteConnector from 'db0/connectors/node-sqlite'
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

import { normalizeSqliteDefaultExpression } from '@/dialects/sqlite'
import { assertSafeSqliteDefaultExpression } from '@/dialects/sqlite/validate'
import { column, createDatabase, defineTable, reference, sqliteCatalog } from '@/index'
import type { TableHandle } from '@/types'

it('normalizes only unquoted spacing and retains escaped quotes in SQL strings', () => {
  expect(normalizeSqliteDefaultExpression(" ( lower(  'a''  b' ) ) ")).toBe(
    "lower( 'a''  b' )",
  )

  expect(normalizeSqliteDefaultExpression("'a\t\n b'")).toBe("'a\t\n b'")
})

it.each([
  "'x'; drop table records",
  "lower('x') -- comment",
  "'x' /* comment */",
  "'x'::text",
  '$value',
  '(select 1)',
  "lower('unterminated)",
])(
  'rejects executable or malformed SQL default %s outside string literals',
  (expression) => {
    expect(() => assertSafeSqliteDefaultExpression(expression)).toThrow(
      /Unsafe SQLite database expression/,
    )
  },
)

/** Creates a real pinned Client with optional independently authored native state. */
async function fixture(schemas: readonly TableHandle[], sql = '') {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance!()

  if (sql) native.exec(sql)

  return { native, db: createDatabase({ connector, schemas }) }
}

it.each([
  { label: 'closes during the transaction', closeDuringTransaction: true },
  { label: 'closes after the transaction', closeDuringTransaction: false },
])(
  'keeps a shared connector open when another Client fails and $label',
  async ({ closeDuringTransaction }) => {
    const Records = defineTable(
      'records',
      { id: pipe(number(), integer()), label: string() },
      { primaryKey: 'id' },
    )

    const connector = nodeSqliteConnector({ name: ':memory:' })
    const first = createDatabase({ connector, schemas: [Records] })
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
      await Promise.all([first.close(), second.close()])
    }
  },
)

it('does not retain a provider when Client creation rejects an invalid SQLite namespace', async () => {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance!()

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

it.each([42n, 9007199254740993n, 9223372036854775807n, -9223372036854775808n])(
  'round-trips BIGINT %s through RETURNING and SELECT without changing storage',
  async (value) => {
    const Records = defineTable(
      'records',
      { id: pipe(number(), integer()), value: bigint() },
      { primaryKey: 'id' },
    )

    const { native, db } = await fixture([Records])
    try {
      await db.migrate().execute()

      expect(await db.insert(Records).values({ id: 1, value }).execute()).toEqual([
        { id: 1, value },
      ])

      expect(await db.from(Records).execute()).toEqual([{ id: 1, value }])
      const stored = native.prepare('select value,typeof(value) as storage from records')
      stored.setReadBigInts(true)
      expect(stored.all()).toEqual([{ value, storage: 'integer' }])
    } finally {
      await db.close()
    }
  },
)

it('returns authored names and logical values from case-equivalent native columns', async () => {
  const Records = defineTable(
    'records',
    { id: pipe(number(), integer()), active: boolean() },
    { primaryKey: 'id' },
  )

  const { native, db } = await fixture(
    [Records],
    'create table records(ID INTEGER primary key,ACTIVE BOOLEAN not null); insert into records values(1,1)',
  )

  try {
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
  } finally {
    await db.close()
  }
})

it('uses logical boolean, Date and JSON mapping with physical INTEGER and TEXT overrides', async () => {
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

  const { native, db } = await fixture([Records])
  const row = {
    id: 1,
    active: true,
    stamp: new Date('2026-01-02T03:04:05.000Z'),
    data: { label: 'value' },
  }

  try {
    await db.migrate().execute()
    expect(await db.insert(Records).values(row).execute()).toEqual([row])
    expect(await db.from(Records).execute()).toEqual([row])

    expect(native.prepare('select active,stamp,data from records').all()).toEqual([
      { active: 1, stamp: '2026-01-02T03:04:05.000Z', data: '{"label":"value"}' },
    ])

    const empty = { id: 2, active: null, stamp: null, data: null }
    expect(await db.insert(Records).values(empty).execute()).toEqual([empty])
    expect(await db.from(Records).where({ id: 2 }).execute()).toEqual([empty])
  } finally {
    await db.close()
  }
})

it('retains target logical context for reference-only columns with physical overrides', async () => {
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

  const { native, db } = await fixture([Parents, Children])
  try {
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
  } finally {
    await db.close()
  }
})

it.each(['a  b', "x;y -- /* select DROP $ :: 'quote'"])(
  'preserves a literal default %s and converges after native insertion',
  async (value) => {
    const Records = defineTable(
      'records',
      {
        id: pipe(number(), integer()),
        label: pipe(string(), column({ databaseDefault: { kind: 'literal', value } })),
      },
      { primaryKey: 'id' },
    )

    const { native, db } = await fixture([Records])
    try {
      await db.migrate().execute()
      expect((await db.migrate().dryRun()).actions).toEqual([])
      native.exec('insert into records(id) values(1)')
      expect(await db.from(Records).execute()).toEqual([{ id: 1, label: value }])
    } finally {
      await db.close()
    }
  },
)

it('does not treat different whitespace inside expression literals as default convergence', async () => {
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

  const { native, db } = await fixture(
    [Records],
    "create table records(id INTEGER primary key,label TEXT not null default (lower('a  b')))",
  )

  try {
    await expect(db.migrate().dryRun()).rejects.toThrow(/unsupported default change/i)
    native.exec('insert into records(id) values(1)')
    expect(native.prepare('select label from records').all()).toEqual([{ label: 'a  b' }])
  } finally {
    await db.close()
  }
})

it('keeps column and client mapping precedence and passes physical types to custom mappers', async () => {
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

  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance!()
  const seen: unknown[][] = []
  const db = createDatabase({
    connector,
    schemas: [Records],
    map: {
      /** Records the unchanged physical type and raw logical input before dialect mapping. */
      mapParamValue: (dataType, value) => {
        seen.push([dataType, value])
        return typeof value === 'boolean' ? 0 : value
      },
      /** Makes the client result override distinguishable from logical boolean mapping. */
      mapResultValue: (_dataType, value) => (value === 0 ? 'custom' : value),
    },
  })

  try {
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
  } finally {
    await db.close()
  }
})

it('fails closed for repeated FK target columns instead of deduplicating candidate keys', async () => {
  const { native, db } = await fixture(
    [],
    'create table parent(a INTEGER,b INTEGER,unique(a,b)); create table child(x INTEGER,y INTEGER,foreign key(x,y) references parent(a,a))',
  )

  try {
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

    const child = snapshot.namespaces.items[0]!.relations.items.find(
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
  } finally {
    await db.close()
  }
})

it.each(['unique(a,b)', 'primary key(a,b)'])(
  'adopts a valid FK permutation of %s and preserves source/target pair order',
  async (key) => {
    const { native, db } = await fixture(
      [],
      `pragma foreign_keys=on; create table parent(a INTEGER,b TEXT,${key}); create table child(id INTEGER primary key,x TEXT,y INTEGER,foreign key(x,y) references parent(b,a)); insert into parent values(1,'A'); insert into child values(3,'A',1)`,
    )

    try {
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

      const child = snapshot.namespaces.items[0]!.relations.items.find(
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
    } finally {
      await db.close()
    }
  },
)
