import {
  array,
  bigint,
  boolean,
  date,
  integer,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
} from 'valibot'
import { expect, it, vi } from 'vitest'

import { column, defineTable } from '@/index'
import type { DatabaseDefault } from '@/schemas'
import type { AnySchema } from '@/types/schema'

import { withSqliteDatabase } from './sqliteIntegration'

it.each<[string, AnySchema, DatabaseDefault, string]>([
  ['create', date(), { kind: 'portableExpression', expression: 'currentTime' }, ''],
  [
    'add',
    boolean(),
    { kind: 'literal', value: 'false' },
    'create table records(id INTEGER primary key not null); insert into records values(7)',
  ],
  [
    'rebuild',
    number(),
    { kind: 'literal', value: 'wrong' },
    'create table records(id INTEGER primary key not null,value REAL not null default 1); insert into records values(7,1)',
  ],
  [
    'no-op',
    object({ label: string() }),
    { kind: 'literal', value: 'wrong' },
    'create table records(id INTEGER primary key not null,value JSON not null default \'wrong\'); insert into records values(7,\'{"label":"seed"}\')',
  ],
])(
  'rejects incompatible defaults before %s DDL and preserves catalog/data',
  async (_path, schema, databaseDefault, setup) => {
    const Records = defineTable(
      'records',
      {
        id: pipe(number(), integer()),
        value: pipe(schema, column({ databaseDefault })),
      },
      { primaryKey: 'id' },
    )

    const Earlier = defineTable('aaa_earlier', { id: number() }, { primaryKey: 'id' })
    await withSqliteDatabase([Earlier, Records], async ({ db, native }) => {
      native.exec(
        'create table seed(id INTEGER primary key not null); insert into seed values(9)',
      )

      if (setup) native.exec(setup)

      const catalog = native
        .prepare('select name,sql from sqlite_schema order by name')
        .all()

      const readRecords = () =>
        setup ? native.prepare('select * from records').all() : undefined

      const records = readRecords()
      const error = {
        stage: 'planning',
        outcome: 'unchanged',
        message: expect.stringContaining('is incompatible with the registered') as string,
      }

      await expect(db.migrate().plan()).rejects.toMatchObject(error)
      await expect(db.migrate().dryRun()).rejects.toMatchObject(error)
      await expect(db.migrate().execute()).rejects.toMatchObject(error)

      expect(
        native.prepare('select name,sql from sqlite_schema order by name').all(),
      ).toEqual(catalog)

      expect(native.prepare('select * from seed').all()).toEqual([{ id: 9 }])
      expect(readRecords()).toEqual(records)
    })
  },
)

it.each<[string | number, bigint]>([
  ['9007199254740993.0', 9007199254740992n],
  [9007199254740992, 9007199254740992n],
])('preserves native integer storage for bigint default %s', async (value, expected) => {
  const Records = defineTable(
    'records',
    {
      id: number(),
      value: pipe(bigint(), column({ databaseDefault: { kind: 'literal', value } })),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Records], async ({ db }) => {
    await db.migrate().execute()

    expect(await db.insert(Records).values({ id: 1 }).execute()).toEqual([
      { id: 1, value: expected },
    ])

    expect(await db.from(Records).execute()).toEqual([{ id: 1, value: expected }])
    expect((await db.migrate().dryRun()).actions).toEqual([])
  })
})

const ValidDefaults = defineTable(
  'records',
  {
    id: pipe(number(), integer()),
    inactive: pipe(
      boolean(),
      column({ databaseDefault: { kind: 'literal', value: false } }),
    ),
    active: pipe(
      boolean(),
      column({
        physicalType: { sqlite: 'REAL' },
        databaseDefault: { kind: 'literal', value: true },
      }),
    ),
    amount: pipe(number(), column({ databaseDefault: { kind: 'literal', value: 1.5 } })),
    numericText: pipe(
      number(),
      column({
        physicalType: { sqlite: 'NUMERIC' },
        databaseDefault: { kind: 'literal', value: '  +1e2  ' },
      }),
    ),
    blobNumber: pipe(
      number(),
      column({
        physicalType: { sqlite: 'BLOB' },
        databaseDefault: { kind: 'literal', value: 2.5 },
      }),
    ),
    large: pipe(
      bigint(),
      column({ databaseDefault: { kind: 'literal', value: '9007199254740993' } }),
    ),
    data: pipe(
      object({ label: string() }),
      column({
        physicalType: { sqlite: 'NUMERIC' },
        databaseDefault: { kind: 'literal', value: '{"label":"seed"}' },
      }),
    ),
    list: pipe(
      array(string()),
      column({ databaseDefault: { kind: 'literal', value: '["seed"]' } }),
    ),
    stamp: pipe(
      date(),
      column({
        databaseDefault: { kind: 'portableExpression', expression: 'currentTimestamp' },
      }),
    ),
    day: pipe(
      date(),
      column({
        databaseDefault: { kind: 'portableExpression', expression: 'currentDate' },
      }),
    ),
    time: pipe(
      string(),
      column({
        databaseDefault: { kind: 'portableExpression', expression: 'currentTime' },
      }),
    ),
    empty: pipe(
      optional(nullable(boolean())),
      column({ databaseDefault: { kind: 'literal', value: null } }),
    ),
  },
  { primaryKey: 'id' },
)

it('preserves built-in logical types for omitted defaults in RETURNING and SELECT and converges', async () => {
  await withSqliteDatabase([ValidDefaults], async ({ db }) => {
    await db.migrate().execute()
    const rows = await db.insert(ValidDefaults).values({ id: 1 }).execute()
    expect(rows).toMatchObject([
      {
        id: 1,
        inactive: false,
        active: true,
        amount: 1.5,
        numericText: 100,
        blobNumber: 2.5,
        large: 9007199254740993n,
        data: { label: 'seed' },
        list: ['seed'],
        empty: null,
      },
    ])

    expect(rows[0]!.stamp).toBeInstanceOf(Date)
    expect(rows[0]!.day).toBeInstanceOf(Date)
    expect(rows[0]!.time).toMatch(/^\d{2}:\d{2}:\d{2}$/)
    expect(rows[0]!.stamp.getTime()).not.toBeNaN()
    expect(rows[0]!.day.getTime()).not.toBeNaN()
    expect(await db.from(ValidDefaults).execute()).toEqual(rows)
    expect((await db.migrate().dryRun()).actions).toEqual([])
    expect(await db.migrate().plan()).toEqual({ steps: [] })
  })
})

/** Builds a time-only default with the selected explicit mapping contract. */
function timeDefaultTable(
  scope: string,
  encode: (value: unknown) => string,
  decode: (value: unknown) => Date,
) {
  return defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      value: pipe(
        date(),
        column({
          databaseDefault: { kind: 'portableExpression', expression: 'currentTime' },
          ...(scope !== 'client' ? { mapParam: encode } : {}),
          ...(scope === 'column' ? { mapResult: decode } : {}),
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

it.each(['column', 'client', 'mixed'])(
  'uses explicit %s hooks to supply time-only Date policy without running hooks during planning',
  async (scope) => {
    const encode = vi.fn<(value: unknown) => string>((value) =>
      (value as Date).toISOString(),
    )

    const decode = vi.fn<(value: unknown) => Date>(
      (value: unknown) =>
        new Date(
          /^\d{2}:\d{2}:\d{2}$/.test(String(value))
            ? `2001-02-03T${String(value)}Z`
            : String(value),
        ),
    )

    const Records = timeDefaultTable(scope, encode, decode)
    await withSqliteDatabase(
      [Records],
      async ({ db, native }) => {
        await db.migrate().dryRun()
        await db.migrate().execute()
        expect(encode).not.toHaveBeenCalled()
        expect(decode).not.toHaveBeenCalled()
        const rows = await db.insert(Records).values({ id: 1 }).execute()
        const stored = native.prepare('select value from records').get()!.value
        expect(rows).toEqual([
          { id: 1, value: new Date(`2001-02-03T${String(stored)}Z`) },
        ])

        expect(await db.from(Records).execute()).toEqual(rows)
        expect((await db.migrate().dryRun()).actions).toEqual([])
      },
      {
        map:
          scope === 'column'
            ? undefined
            : {
                ...(scope === 'client'
                  ? {
                      mapParamValue: (type, value) =>
                        type === 'DATETIME' ? encode(value) : value,
                    }
                  : {}),
                mapResultValue: (type, value) =>
                  type === 'DATETIME' ? decode(value) : value,
              },
      },
    )
  },
)

it('keeps client result contracts local to each client using the same handle', async () => {
  const Records = defineTable(
    'records',
    {
      id: number(),
      value: pipe(
        boolean(),
        column({ databaseDefault: { kind: 'literal', value: 'false' } }),
      ),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase(
    [Records],
    async ({ db: accepted }) => {
      await withSqliteDatabase([Records], async ({ db: rejected }) => {
        await accepted.migrate().execute()

        expect(await accepted.insert(Records).values({ id: 1 }).execute()).toEqual([
          { id: 1, value: false },
        ])

        expect(await accepted.from(Records).execute()).toEqual([{ id: 1, value: false }])

        await expect(rejected.migrate().dryRun()).rejects.toMatchObject({
          stage: 'planning',
          outcome: 'unchanged',
        })

        expect((await accepted.migrate().dryRun()).actions).toEqual([])
      })
    },
    {
      map: {
        mapResultValue: (type, value) => (type === 'BOOLEAN' ? value === 'true' : value),
      },
    },
  )
})
