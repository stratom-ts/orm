import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { bigint, boolean, date, integer, number, object, pipe, string } from 'valibot'
import { build } from 'vite'
import { beforeAll, expect, it } from 'vitest'

type Library = typeof import('@/index')

// A variable specifier keeps typecheck independent of a prior build.
const packageName = 'stratom'
let library: Library

beforeAll(async () => {
  await build({ configFile: 'vite.config.ts', logLevel: 'silent' })
  library = (await import(packageName)) as Library
}, 60_000)

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

it('maps, migrates and converges through the built package on native SQLite', async () => {
  const Records = recordsTable(library)

  const connector = nodeSqliteConnector({ name: ':memory:' })
  const native = await connector.getInstance!()
  native.exec(
    'create table records(ID INTEGER primary key,VALUE BIGINT not null,ACTIVE INTEGER not null,STAMP TEXT not null,DATA TEXT not null)',
  )

  const db = library.createDatabase({ connector, schemas: [Records] })

  try {
    await db.migrate().execute()
    expect((await db.migrate().dryRun()).actions).toEqual([])

    for (const [index, value] of [
      42n,
      9007199254740993n,
      9223372036854775807n,
    ].entries()) {
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
  } finally {
    await db.close()
  }
})
