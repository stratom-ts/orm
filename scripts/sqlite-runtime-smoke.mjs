import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { bigint, boolean, date, integer, number, object, pipe, string } from 'valibot'

const require = createRequire(import.meta.url)

/** @typedef {typeof import('../src/index')} Library */
const esmPath = '../dist/stratom.js'
const esm = /** @type {Library} */ (await import(esmPath))
const cjsPath = '../dist/stratom.umd.cjs'
const cjs = /** @type {Library} */ (require(cjsPath))

/**
 * Builds the schema used to prove storage overrides and portable defaults.
 *
 * @param {Library} library - Published module under test.
 */
function recordsTable(library) {
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

/**
 * Checks published Client mapping, migration and convergence on the native runtime.
 *
 * @param {Library} library - Published module under test.
 */
async function clientRoundTrip(library) {
  const Records = recordsTable(library)
  const connector = nodeSqliteConnector({ name: ':memory:' })
  assert.ok(connector.getInstance)
  const native = await connector.getInstance()
  native.exec(
    'create table records(ID INTEGER primary key,VALUE BIGINT not null,ACTIVE INTEGER not null,STAMP TEXT not null,DATA TEXT not null)',
  )

  const db = library.createDatabase({ connector, schemas: [Records] })
  try {
    await db.migrate().execute()
    assert.deepEqual((await db.migrate().dryRun()).actions, [])
    const stamp = new Date('2026-01-02T03:04:05.000Z')
    for (const [index, value] of [
      42n,
      9007199254740993n,
      9223372036854775807n,
    ].entries()) {
      const row = {
        id: index + 1,
        value,
        active: true,
        stamp,
        data: { label: 'value' },
        note: 'a  b',
      }

      assert.deepEqual(await db.insert(Records).values(row).execute(), [row])
      assert.deepEqual(await db.from(Records).where({ id: row.id }).execute(), [row])
      const stored = native.prepare('select VALUE from records where ID=?')
      stored.setReadBigInts(true)
      const observed = stored.get(row.id)
      assert.ok(observed)
      assert.equal(observed.VALUE, value)
    }

    assert.deepEqual(await db.from(Records).select([Records.active]).execute(), [
      { active: true },
      { active: true },
      { active: true },
    ])
  } finally {
    await db.close()
  }
}

/**
 * Proves external native transactions are rolled back before reuse.
 *
 * @param {Library} library - Published module under test.
 */
async function nativeReuse(library) {
  const connector = nodeSqliteConnector({ name: ':memory:' })
  const provider = library.createDb0NodeSqliteOperationSessionProvider(connector)
  const session = await provider.open()

  /** @type {import('../src/operations/operationSession').OperationSession | undefined} */
  let active = session

  /** @type {unknown} */
  let primary
  try {
    await session.run({ sql: 'create table records(id INTEGER)', params: [] })
    assert.ok(connector.getInstance)
    const native = await connector.getInstance()
    native.exec('begin; insert into records values(1)')

    await session.release('reuse').finally(() => {
      active = undefined
    })

    const next = await provider.open()
    active = next
    assert.deepEqual(next.identity, session.identity)
    assert.deepEqual(await next.query({ sql: 'select id from records', params: [] }), [])

    await next.release('reuse').finally(() => {
      active = undefined
    })

    native.prepare('begin').run()
    native.prepare('rollback').run()
  } catch (cause) {
    primary = cause
  } finally {
    await closeSession(provider, active, primary)
  }
}

/**
 * Discards active work before closing and retains the first assertion or cleanup error.
 *
 * @param {import('../src/operations/operationSession').OperationSessionProvider} provider -
 *   Native provider.
 * @param {import('../src/operations/operationSession').OperationSession | undefined} active -
 *   Unreleased lease.
 * @param {unknown} primary - Earlier assertion error, when present.
 */
async function closeSession(provider, active, primary) {
  /** @param {unknown} cause - Cleanup failure retained only when no primary error exists. */
  const retain = (cause) => {
    primary ??= cause
  }

  if (active) await active.release('discard').catch(retain)

  await provider.close().catch(retain)

  if (primary !== undefined) throw primary
}

const modules = /** @type {[string, Library][]} */ ([
  ['ESM', esm],
  ['CJS', cjs],
])

for (const [format, library] of modules) {
  await clientRoundTrip(library)
  await nativeReuse(library)

  console.log(
    `${process.version} ${format}: SQLite Client and native session smoke passed`,
  )
}
