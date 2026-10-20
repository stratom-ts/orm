import { access } from 'node:fs/promises'
import { bigint, boolean, date, integer, number, object, pipe, string } from 'valibot'
import { beforeAll, expect, it } from 'vitest'

import type { SqliteDatabaseContext } from './sqliteIntegration'
import { withSqliteDatabase } from './sqliteIntegration'

type Library = typeof import('@/index')

// A variable specifier keeps typecheck independent of a prior build.
const packageName = 'stratom'
let library: Library

beforeAll(async () => {
  library = (await import(packageName)) as Library
})

/** Builds the schema used to prove storage overrides and portable defaults. */
function recordsTable(library: Library) {
  return library.defineTable(
    'records',
    {
      id: pipe(number(), integer()),
      value: bigint(),
      active: pipe(boolean(), library.column({ physicalType: { sqlite: 'INTEGER' } })),
      stamp: pipe(date(), library.column({ physicalType: { sqlite: 'TEXT' } })),
      data: pipe(
        object({ label: string() }),
        library.column({ physicalType: { sqlite: 'TEXT' } }),
      ),
      note: pipe(
        string(),
        library.column({ databaseDefault: { kind: 'literal', value: 'a  b' } }),
      ),
    },
    { primaryKey: 'id' },
  )
}

type Records = ReturnType<typeof recordsTable>
type Context = SqliteDatabaseContext<readonly [Records]>

/** Checks built-package value mapping against native SQLite integer storage. */
async function expectBigintRoundTrips(
  { db, native }: Pick<Context, 'db' | 'native'>,
  Records: Records,
) {
  for (const [index, value] of [42n, 9007199254740993n, 9223372036854775807n].entries()) {
    const row = {
      id: index + 1,
      value,
      active: true,
      stamp: new Date('2026-01-02T03:04:05.000Z'),
      data: { label: 'value' },
      note: 'a  b',
    }

    expect(await db.insert(Records).values(row).execute()).toEqual([row])
    expect(await db.from(Records).where({ id: row.id }).execute()).toEqual([row])

    const stored = native.prepare('select VALUE from records where ID=?')
    stored.setReadBigInts(true)
    expect(stored.get(row.id)).toEqual({ VALUE: value })
  }
}

/** Checks transaction routing, rollback, commit, and the literal database default. */
async function expectSqliteTransactions(
  { db, native }: Pick<Context, 'db' | 'native'>,
  Records: Records,
) {
  const value = {
    id: 4,
    value: 42n,
    active: false,
    stamp: new Date('2026-02-03T04:05:06.000Z'),
    data: { label: 'rollback' },
  }

  await expect(
    db.transaction(async (transaction) => {
      await expect(db.from(Records).execute()).rejects.toThrow(/scoped client/)
      await transaction.insert(Records).values(value).execute()
      throw new Error('rollback package transaction')
    }),
  ).rejects.toThrow('rollback package transaction')

  expect(await db.from(Records).where({ id: 4 }).execute()).toEqual([])

  await db.transaction(async (transaction) => {
    await transaction.insert(Records).values(value).execute()
  })

  expect(await db.from(Records).where({ id: 4 }).execute()).toEqual([
    { ...value, note: 'a  b' },
  ])

  expect(
    native
      .prepare(
        'select typeof(ACTIVE) as active, typeof(STAMP) as stamp, typeof(DATA) as data, note from records where ID=4',
      )
      .get(),
  ).toEqual({ active: 'integer', stamp: 'text', data: 'text', note: 'a  b' })
}

/** Exercises a pre-existing uppercase table and a converged Migration Plan. */
async function exerciseSqlite({ db, native, filePath }: Context, Records: Records) {
  native.exec(
    'create table records(ID INTEGER primary key,VALUE BIGINT not null,ACTIVE INTEGER not null,STAMP TEXT not null,DATA TEXT not null)',
  )

  expect((await db.migrate().plan()).steps.length).toBeGreaterThan(0)
  await db.migrate().execute()
  expect(await db.migrate().plan()).toEqual({ steps: [] })
  expect((await db.migrate().dryRun()).actions).toEqual([])

  expect(
    native
      .prepare('pragma table_info(records)')
      .all()
      .map((column) => [column.name, column.type]),
  ).toEqual([
    ['ID', 'INTEGER'],
    ['VALUE', 'BIGINT'],
    ['ACTIVE', 'INTEGER'],
    ['STAMP', 'TEXT'],
    ['DATA', 'TEXT'],
    ['note', 'TEXT'],
  ])

  await expectBigintRoundTrips({ db, native }, Records)
  await expectSqliteTransactions({ db, native }, Records)
  return { native, filePath: filePath! }
}

it('maps, migrates and converges through the built package on native SQLite', async () => {
  const Records = recordsTable(library)
  const state = await withSqliteDatabase(
    [Records],
    (context) => exerciseSqlite(context, Records),
    { library, file: true },
  )

  expect(() => state.native.prepare('select 1')).toThrow(/not open/)
  await expect(access(state.filePath)).rejects.toMatchObject({ code: 'ENOENT' })
})
