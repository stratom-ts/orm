import {
  decimal,
  ip,
  ipv4,
  ipv6,
  mac,
  mac48,
  mac64,
  nullable,
  pipe,
  string,
  uuid,
} from 'valibot'
import { beforeAll, expect, expectTypeOf, it } from 'vitest'

import type { Db, InferInsert, InferSelect, InferUpdate } from '@/index'
import { column, defineTable, reference } from '@/index'

import { waitForPostgres } from './postgres.setup'
import type { PostgresDatabaseContext } from './postgresIntegration'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

const Parent = defineTable(
  'native_formats',
  {
    id: pipe(string(), ip()),
    uuidValue: pipe(string(), uuid()),
    ipv4Only: pipe(string(), ipv4()),
    ipv6Only: pipe(string(), ipv6()),
    shortMac: pipe(string(), mac48()),
    anyMac: pipe(string(), mac()),
    longMac: pipe(string(), mac64()),
    amount: pipe(string(), decimal()),
    nullableAmount: nullable(pipe(string(), decimal())),
    pinned: pipe(
      string(),
      decimal(),
      column({ physicalType: { postgresql: 'text' }, unique: true }),
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
  { primaryKey: 'id' },
)

const schemas = [Child, Parent] as const
type NativeDatabase = Db<typeof schemas>

type NativeRow = {
  id: string
  uuidValue: string
  ipv4Only: string
  ipv6Only: string
  shortMac: string
  anyMac: string
  longMac: string
  amount: string
  nullableAmount: string | null
  pinned: string
}

const row = {
  id: '2001:0DB8:0000:0000:0000:0000:0000:0001',
  uuidValue: '550E8400-E29B-41D4-A716-446655440000',
  ipv4Only: '192.0.2.1',
  ipv6Only: '2001:0DB8:0000:0000:0000:0000:0000:0002',
  shortMac: 'AB:CD:EF:12:34:56',
  anyMac: 'AB:CD:EF:12:34:56',
  longMac: 'AB:CD:EF:12:34:56:78:90',
  amount: '00012345678901234567890.1200',
  nullableAmount: null,
  pinned: '00042.0100',
}

const canonical = {
  ...row,
  id: '2001:db8::1',
  uuidValue: '550e8400-e29b-41d4-a716-446655440000',
  ipv6Only: '2001:db8::2',
  shortMac: 'ab:cd:ef:12:34:56',
  anyMac: 'ab:cd:ef:ff:fe:12:34:56',
  longMac: 'ab:cd:ef:12:34:56:78:90',
  amount: '12345678901234567890.1200',
}

/** Checks native declarations before applying the Migration Plan. */
async function migrateFormatStrings(db: NativeDatabase) {
  const plan = await db.migrate().plan()
  expect(plan.steps.filter((step) => step.kind === 'create_table')).toHaveLength(2)

  const sql = (await db.migrate().dryRun()).actions
    .flatMap((action) => action.statements.map((statement) => statement.sql))
    .join('\n')

  for (const declaration of [
    '"id" inet',
    '"shortMac" macaddr',
    '"longMac" macaddr8',
    '"amount" numeric',
    '"pinned" text',
    '"parentId" inet',
  ])
    expect(sql).toContain(declaration)
  await db.migrate().execute()
}

/** Checks the native catalog independently of desired-schema inference. */
async function assertFormatCatalog({
  admin,
  schema,
}: Pick<PostgresDatabaseContext<typeof schemas>, 'admin' | 'schema'>) {
  const columns = await admin.query<{
    table_name: string
    column_name: string
    data_type: string
  }>(
    `select table_name, column_name, data_type from information_schema.columns
     where table_schema = $1 and table_name in ('native_formats', 'native_format_refs')`,
    [schema],
  )

  const types = Object.fromEntries(
    columns.rows.map((row) => [`${row.table_name}.${row.column_name}`, row.data_type]),
  )

  expect(types).toMatchObject({
    'native_formats.id': 'inet',
    'native_formats.uuidValue': 'uuid',
    'native_formats.ipv4Only': 'inet',
    'native_formats.ipv6Only': 'inet',
    'native_formats.shortMac': 'macaddr',
    'native_formats.anyMac': 'macaddr8',
    'native_formats.longMac': 'macaddr8',
    'native_formats.amount': 'numeric',
    'native_formats.nullableAmount': 'numeric',
    'native_formats.pinned': 'text',
    'native_format_refs.parentId': 'inet',
    'native_format_refs.nullableParent': 'inet',
    'native_format_refs.pinned': 'text',
  })
}

it('should round-trip PostgreSQL native strings and references, introspect types, and converge', async () => {
  expectTypeOf<InferInsert<typeof Parent>>().toEqualTypeOf<NativeRow>()
  expectTypeOf<InferSelect<typeof Parent>>().toEqualTypeOf<NativeRow>()

  expectTypeOf<InferUpdate<typeof Parent>>().toEqualTypeOf<
    Partial<InferInsert<typeof Parent>>
  >()

  await withPostgresDatabase(schemas, async (context) => {
    const { db } = context
    await migrateFormatStrings(db)
    await assertFormatCatalog(context)
    expect(await db.insert(Parent).values(row).execute()).toEqual([canonical])
    await assertFormatPredicates(db)
    const child = {
      id: 'child',
      parentId: row.id,
      nullableParent: null,
      pinned: row.pinned,
    }

    await db.insert(Child).values(child).execute()
    expect(await db.from(Parent).execute()).toEqual([canonical])

    expect(await db.from(Child).execute()).toEqual([{ ...child, parentId: canonical.id }])

    await assertFormatUpdate(db)

    await expect(db.migrate().plan()).resolves.toEqual({ steps: [] })
    await db.delete(Child).where({ id: child.id }).execute()
    await db.delete(Parent).where({ id: row.id }).execute()
    expect(await db.from(Parent).execute()).toEqual([])
  })
})

/** Checks predicates through every distinct native string storage representation. */
async function assertFormatPredicates(db: NativeDatabase): Promise<void> {
  for (const predicate of [
    { id: row.id },
    { uuidValue: row.uuidValue },
    { ipv4Only: row.ipv4Only },
    { ipv6Only: row.ipv6Only },
    { shortMac: row.shortMac },
    { anyMac: row.anyMac },
    { longMac: row.longMac },
    { amount: row.amount },
    { pinned: row.pinned },
  ])
    expect(await db.from(Parent).where(predicate).execute()).toEqual([canonical])
}

/** Checks native canonicalization in update returning independently of the mapper. */
async function assertFormatUpdate(db: NativeDatabase): Promise<void> {
  const patch = {
    uuidValue: '550E8400-E29B-41D4-A716-446655440001',
    ipv4Only: '192.0.2.2',
    ipv6Only: '2001:0DB8:0000:0000:0000:0000:0000:0003',
    shortMac: 'AB:CD:EF:12:34:57',
    anyMac: 'AB:CD:EF:12:34:57',
    longMac: 'AB:CD:EF:12:34:56:78:91',
    amount: '00000.000100',
    nullableAmount: '00000.1200',
  }

  const output = {
    ...canonical,
    uuidValue: '550e8400-e29b-41d4-a716-446655440001',
    ipv4Only: '192.0.2.2',
    ipv6Only: '2001:db8::3',
    shortMac: 'ab:cd:ef:12:34:57',
    anyMac: 'ab:cd:ef:ff:fe:12:34:57',
    longMac: 'ab:cd:ef:12:34:56:78:91',
    amount: '0.000100',
    nullableAmount: '0.1200',
  }

  expect(await db.update(Parent).set(patch).where({ id: row.id }).execute()).toEqual([
    output,
  ])

  expect(await db.from(Parent).execute()).toEqual([output])
}
