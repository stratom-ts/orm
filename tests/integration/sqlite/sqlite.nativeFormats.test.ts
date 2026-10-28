import type { DatabaseSync } from 'node:sqlite'
import {
  date,
  decimal,
  exactOptional,
  ip,
  ipv4,
  ipv6,
  isoDateTime,
  isoTime,
  mac,
  mac48,
  mac64,
  nonNullable,
  nullable,
  optional,
  pipe,
  string,
  uuid,
} from 'valibot'
import { expect, it } from 'vitest'

import type { Db } from '@/index'
import { column, defineTable, reference } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

const Parent = defineTable(
  'native_formats',
  {
    id: pipe(string(), uuid()),
    address: optional(pipe(string(), ip()), '192.0.2.1'),
    ipv4Only: pipe(string(), ipv4()),
    ipv6Only: nullable(pipe(string(), ipv6())),
    shortMac: nonNullable(nullable(pipe(string(), mac48()))),
    anyMac: pipe(string(), mac()),
    longMac: pipe(string(), mac64()),
    amount: exactOptional(pipe(string(), decimal()), '0.00'),
    nullableAmount: nullable(pipe(string(), decimal())),
    pinned: pipe(
      string(),
      decimal(),
      column({
        physicalType: { sqlite: 'BLOB', postgresql: 'numeric' },
        unique: true,
      }),
    ),
    unrelatedOverride: pipe(
      string(),
      decimal(),
      column({ physicalType: { postgresql: 'numeric' } }),
    ),
  },
  { primaryKey: 'id' },
)

const Child = defineTable(
  'native_format_refs',
  {
    id: string(),
    parentId: reference(Parent, 'id'),
    nullableParent: nullable(reference(Parent, 'id')),
    pinned: reference(Parent, 'pinned'),
  },
  { primaryKey: 'id', indexes: [{ columns: ['parentId'], unique: true }] },
)

const Grandchild = defineTable(
  'native_format_chain',
  {
    id: string(),
    parentId: reference(Child, 'parentId'),
  },
  { primaryKey: 'id' },
)

const schemas = [Grandchild, Child, Parent] as const

const row = {
  id: '550E8400-E29B-41D4-A716-446655440000',
  address: '2001:0DB8:0000:0000:0000:0000:0000:0001',
  ipv4Only: '192.0.2.1',
  ipv6Only: '2001:0DB8:0000:0000:0000:0000:0000:0002',
  shortMac: 'AB:CD:EF:12:34:56',
  anyMac: 'AB:CD:EF:12:34:56',
  longMac: 'AB:CD:EF:12:34:56:78:90',
  amount: '00012345678901234567890.1200',
  nullableAmount: null,
  pinned: '00042.0100',
  unrelatedOverride: '00000.00010',
}

/** Checks TEXT declarations before applying the Migration Plan. */
async function migrateFormatStrings(db: Db<typeof schemas>) {
  const sql = (await db.migrate().dryRun()).actions
    .flatMap((action) => action.statements.map((statement) => statement.sql))
    .join('\n')

  expect(sql).toContain('"amount" TEXT')
  expect(sql).toContain('"parentId" TEXT')
  await db.migrate().execute()
}

/** Checks selected SQLite storage and inherited reference types. */
function assertFormatCatalog(native: DatabaseSync) {
  const types = native.prepare('pragma table_info("native_formats")').all()
  expect(types).toHaveLength(11)
  expect(types.find((row) => row.name === 'pinned')?.type).toBe('BLOB')

  expect(
    types.filter((row) => row.name !== 'pinned').every((row) => row.type === 'TEXT'),
  ).toBe(true)

  expect(native.prepare('pragma table_info("native_format_refs")').all()).toContainEqual(
    expect.objectContaining({ name: 'pinned', type: 'BLOB' }),
  )
}

it('should preserve exact SQLite strings through CRUD, wrappers, references, and selected overrides', async () => {
  await withSqliteDatabase(schemas, async ({ db, native }) => {
    await migrateFormatStrings(db)
    assertFormatCatalog(native)
    expect(await db.insert(Parent).values(row).execute()).toEqual([row])
    for (const predicate of [
      { address: row.address },
      { shortMac: row.shortMac },
      { amount: row.amount },
    ])
      expect(await db.from(Parent).where(predicate).execute()).toEqual([row])
    const child = {
      id: 'child',
      parentId: row.id,
      nullableParent: null,
      pinned: row.pinned,
    }

    const grandchild = { id: 'grandchild', parentId: row.id }
    await db.insert(Child).values(child).execute()
    await db.insert(Grandchild).values(grandchild).execute()
    expect(await db.from(Parent).execute()).toEqual([row])
    expect(await db.from(Child).execute()).toEqual([child])
    expect(await db.from(Grandchild).execute()).toEqual([grandchild])
    const amount = '00000000000000000001.230000'
    expect(
      await db
        .update(Parent)
        .set({ amount, ipv6Only: null })
        .where({ id: row.id })
        .execute(),
    ).toEqual([{ ...row, amount, ipv6Only: null }])

    expect(await db.from(Parent).execute()).toEqual([{ ...row, amount, ipv6Only: null }])

    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
    await db.delete(Grandchild).where({ id: grandchild.id }).execute()
    await db.delete(Child).where({ id: child.id }).execute()
    await db.delete(Parent).where({ id: row.id }).execute()
    expect(await db.from(Parent).execute()).toEqual([])
  })
})

it('should migrate PostgreSQL format conflicts as SQLite TEXT and converge', async () => {
  const Conflict = defineTable(
    'format_conflict',
    {
      id: pipe(string(), uuid(), ip(), decimal()),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Conflict], async ({ db, native }) => {
    await db.migrate().execute()

    expect(native.prepare('pragma table_info("format_conflict")').all()).toMatchObject([
      { name: 'id', type: 'TEXT' },
    ])

    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
  })
})

it('should preserve matching SQLite temporal reference strings and Date output with stable declarations', async () => {
  const Parent = defineTable(
    'temporal_parent',
    {
      time: pipe(string(), isoTime()),
      local: pipe(string(), isoDateTime(), column({ unique: true })),
      instant: pipe(date(), column({ unique: true })),
    },
    { primaryKey: 'time' },
  )

  const Child = defineTable(
    'temporal_child',
    {
      time: reference(Parent, 'time'),
      local: reference(Parent, 'local'),
      instant: reference(Parent, 'instant'),
    },
    { primaryKey: 'time' },
  )

  await withSqliteDatabase([Child, Parent], async ({ db, native }) => {
    await db.migrate().execute()
    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })

    for (const table of ['temporal_parent', 'temporal_child']) {
      const columns = native.prepare(`pragma table_info("${table}")`).all()
      expect(
        Object.fromEntries(columns.map((column) => [column.name, column.type])),
      ).toEqual({ time: 'TEXT', local: 'TEXT', instant: 'DATETIME' })
    }

    const row = {
      time: '03:04',
      local: '2026-01-02T03:04',
      instant: new Date('2026-01-02T03:04:05Z'),
    }

    expect(await db.insert(Parent).values(row).execute()).toEqual([row])

    expect(
      await db
        .insert(Child)
        .values(row)
        .returning([Child.time, Child.local, Child.instant])
        .execute(),
    ).toEqual([row])

    expect(await db.from(Child).execute()).toEqual([row])
    expect(native.prepare('pragma foreign_key_check').all()).toEqual([])

    expect(
      native.prepare('select "time", "local", "instant" from "temporal_child"').all(),
    ).toEqual([{ time: row.time, local: row.local, instant: row.instant.toISOString() }])

    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
  })
})
