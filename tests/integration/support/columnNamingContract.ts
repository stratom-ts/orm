import { nullable, number, pipe, string } from 'valibot'
import { expect, vi } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { Dialect } from '@/dialects'
import type { ColumnNamingFunction, CreateDatabaseConfig, Db, TableHandle } from '@/index'
import { column, countAll, defineTable, eq, excluded, lower, reference } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import { snakeCase } from '@/naming'
import { markCompiledQuery } from '@/query/compiled'
import { columnNamesFingerprint, resolveColumnNames } from '@/schemas/physicalColumn'

const People = defineTable(
  'naming_people',
  {
    userId: number(),
    fullName: pipe(string(), column({ unique: true })),
    legacyName: nullable(pipe(string(), column({ name: 'displayName' }))),
  },
  { primaryKey: 'userId', indexes: [{ columns: ['fullName'] }] },
)

const Posts = defineTable(
  'naming_posts',
  { postId: number(), authorId: reference(People, 'userId') },
  { primaryKey: 'postId' },
)

const Store = defineTable(
  'naming_storage',
  { id: number(), oldValue: nullable(string()) },
  { primaryKey: 'id' },
)

const Preserved = defineTable(
  'naming_storage',
  { id: number(), oldValue: nullable(pipe(string(), column({ name: 'oldValue' }))) },
  { primaryKey: 'id' },
)

const Renamed = defineTable(
  'naming_people',
  {
    id: pipe(number(), column({ name: 'user_id' })),
    label: pipe(string(), column({ name: 'full_name', unique: true })),
    legacy: nullable(pipe(string(), column({ name: 'displayName' }))),
  },
  { primaryKey: 'id', indexes: [{ columns: ['label'] }] },
)

const RenamedPosts = defineTable(
  'naming_posts',
  { postId: number(), authorId: reference(Renamed, 'id') },
  { primaryKey: 'postId' },
)

const namingSchemas = [People, Posts] as const

type ClientFactory = (
  schemas: readonly TableHandle[],
  options?: Pick<CreateDatabaseConfig, 'naming' | 'migrationOwnership'>,
) => Db

const value = { userId: 1, fullName: 'Ada', legacyName: 'legacy' }
const custom: ColumnNamingFunction = ({ column, table }) => `${table}_${column}`

/** Runs the same generated-name query and reconciliation contract against each engine. */
async function assertNaming(
  createClient: ClientFactory,
  dialect: Dialect,
  namespace: readonly string[] = [],
) {
  const naming = vi.fn<ColumnNamingFunction>(snakeCase)
  const db = createClient(namingSchemas, { naming: { columns: naming } })
  expect(naming).toHaveBeenCalledTimes(4)
  expect(People.fullName.column).toBe('fullName')
  const before = await db.migrate().dryRun()
  expect(JSON.stringify(before)).toContain('full_name')
  expect(JSON.stringify(before)).toContain('author_id')
  await db.migrate().execute()
  expect(await db.migrate().plan()).toEqual({ steps: [] })
  await assertReads(db)
  await assertWrites(db)
  await assertTransactions(db)
  await assertDeletes(db)
  expect(naming).toHaveBeenCalledTimes(4)
  await assertCustomNaming(createClient, db)
  await assertApplicationRename(createClient)
  await assertProfiles(db, dialect, namespace)
  await assertStorage(createClient, dialect)

  // Physical metadata verifies that generated names reached the actual catalog.
  const table = db.sql.id(...namespace, 'naming_people')
  expect(await db.sql`select full_name as value from ${table}`).toEqual([])
}

async function assertReads(db: Db) {
  expect(await db.insert(People).values(value).execute()).toEqual([value])
  await db.insert(Posts).values({ postId: 10, authorId: 1 }).execute()
  expect(await db.from(People).where('fullName', 'eq', 'Ada').execute()).toEqual([value])

  expect(
    await db
      .from(Posts)
      .leftJoin(People, eq(Posts.authorId, People.userId))
      .select((b) => [Posts.postId, b.as(lower(People.fullName), 'label')])
      .orderBy(Posts.postId)
      .execute(),
  ).toEqual([{ postId: 10, label: 'ada' }])

  expect(
    await db
      .from(People)
      .select((b) => [b.as(countAll(), 'total')])
      .groupBy(People.fullName)
      .having(eq(People.fullName, 'Ada'))
      .execute(),
  ).toHaveLength(1)
}

async function assertWrites(db: Db) {
  expect(
    await db
      .insert(People)
      .values({ ...value, fullName: 'Grace' })
      .onConflict(['userId'])
      .doUpdate({ fullName: excluded(People.fullName) })
      .returning([People.fullName])
      .execute(),
  ).toEqual([{ fullName: 'Grace' }])

  expect(
    await db
      .update(People)
      .set({ fullName: 'Updated' })
      .where('userId', 'eq', 1)
      .returningAll()
      .execute(),
  ).toEqual([{ ...value, fullName: 'Updated' }])
}

async function assertTransactions(db: Db) {
  await db.transaction(async (trx) => {
    expect(await trx.from(People).where(People.userId, 'eq', 1).execute()).toEqual([
      { ...value, fullName: 'Updated' },
    ])

    await trx.transaction(async (nested) => {
      expect(await nested.from(People).select(['fullName']).execute()).toEqual([
        { fullName: 'Updated' },
      ])
    })
  })
}

async function assertDeletes(db: Db) {
  await db.delete(Posts).where('postId', 'eq', 10).returningAll().execute()

  expect(
    await db.delete(People).where('userId', 'eq', 1).returningAll().execute(),
  ).toEqual([{ ...value, fullName: 'Updated' }])
}

async function assertCustomNaming(createClient: ClientFactory, db: Db) {
  const other = createClient(namingSchemas, { naming: { columns: custom } })
  expect(other.from(People).compile().sql).toContain('naming_people_fullName')
  expect(db.from(People).compile().sql).toContain('full_name')
  expect(other.from(People).compile().sql).toContain('displayName')
  const customTable = defineTable(
    'custom_naming',
    { rowId: number(), someValue: string() },
    { primaryKey: 'rowId' },
  )

  const customDb = createClient([customTable], { naming: { columns: custom } })
  await customDb.migrate().execute()

  expect(
    await customDb
      .insert(customTable)
      .values({ rowId: 1, someValue: 'custom' })
      .execute(),
  ).toEqual([{ rowId: 1, someValue: 'custom' }])

  expect(await customDb.migrate().plan()).toEqual({ steps: [] })
}

async function assertApplicationRename(createClient: ClientFactory) {
  expect(
    await createClient([Renamed, RenamedPosts], { naming: { columns: snakeCase } })
      .migrate()
      .plan(),
  ).toEqual({ steps: [] })

  const Collision = defineTable(
    'collision',
    { fullName: string(), FullName: string() },
    { primaryKey: 'fullName' },
  )

  expect(() => createClient([Collision], { naming: { columns: snakeCase } })).toThrow(
    /fullName.*FullName|FullName.*fullName/,
  )
}

async function assertProfiles(db: Db, dialect: Dialect, namespace: readonly string[]) {
  const registrationDefault = namespace.length
    ? [{ role: 'schema' as const, spelling: namespace[0] }]
    : undefined

  const catalog = await dialect.catalog.introspectCatalog(
    { execute: (query) => db.execute(markCompiledQuery(query)) },
    createCatalogRequest(namingSchemas, [], registrationDefault),
  )

  const names = resolveColumnNames(namingSchemas, dialect, snakeCase)
  const planning = { ...dialect.migration.planning, columnNames: names }
  const planned = planMigration(namingSchemas, catalog, planning, { registrationDefault })
  const same = planMigration(
    [...namingSchemas].reverse(),
    catalog,
    {
      ...planning,
      columnNames: resolveColumnNames(namingSchemas, dialect, ({ column }) =>
        snakeCase({ column, table: 'unused' }),
      ),
    },
    { registrationDefault },
  )

  expect(same.profile).toEqual(planned.profile)
  expect(same.plan).toEqual(planned.plan)
  const expected = {
    ...planned.profile,
    columnNamesFingerprint: columnNamesFingerprint(
      namingSchemas,
      planned.identities,
      resolveColumnNames(namingSchemas, dialect, custom),
    ),
  }

  const mismatch = dialect.migration.lower(planned, expected)
  expect(mismatch).toMatchObject({
    issues: [expect.objectContaining({ code: 'profile_mismatch' })],
  })
}

async function assertStorage(createClient: ClientFactory, dialect: Dialect) {
  const plain = createClient([Store])
  await plain.migrate().execute()
  await plain.insert(Store).values({ id: 7, oldValue: 'keep me' }).execute()
  const preserve = createClient([Preserved], { naming: { columns: snakeCase } })
  expect(await preserve.migrate().plan()).toEqual({ steps: [] })

  expect(await preserve.from(Preserved).execute()).toEqual([
    { id: 7, oldValue: 'keep me' },
  ])

  const changed = createClient([Store], { naming: { columns: snakeCase } })
  const plan = await changed.migrate().plan()
  expect(
    plan.steps
      .filter((step) => step.kind === 'add_column')
      .map((step) => step.target.column.spelling),
  ).toContain('old_value')

  expect(plan.steps.some((step) => step.kind === 'drop_column')).toBe(true)
  expect(plan.steps.some((step) => step.kind === 'rename_column')).toBe(false)

  await expect(changed.migrate().execute()).rejects.toThrow(
    dialect.id === 'sqlite'
      ? /complete main namespace dependency evidence/
      : /dangerouslyDropColumn/,
  )

  await assertAdditiveStorage(createClient, preserve)
  await assertDestructiveStorage(dialect, changed, plain)
}

async function assertAdditiveStorage(createClient: ClientFactory, preserve: Db) {
  const additive = createClient([Store], {
    naming: { columns: snakeCase },
    migrationOwnership: [{ kind: 'relation', relation: Store, shape: 'additive' }],
  })

  expect(
    (await additive.migrate().plan()).steps.some((step) => step.kind === 'drop_column'),
  ).toBe(false)

  await additive.migrate().execute()

  expect(await preserve.from(Preserved).execute()).toEqual([
    { id: 7, oldValue: 'keep me' },
  ])

  expect(await additive.from(Store).execute()).toEqual([{ id: 7, oldValue: null }])
}

async function assertDestructiveStorage(dialect: Dialect, changed: Db, plain: Db) {
  if (dialect.id === 'sqlite') {
    await expect(
      changed.migrate().allow('dangerouslyDropColumn').execute(),
    ).rejects.toThrow(/complete main namespace dependency evidence/)
  } else {
    await changed.migrate().allow('dangerouslyDropColumn').execute()
    expect(await changed.migrate().plan()).toEqual({ steps: [] })
    const disabled = await plain.migrate().plan()
    expect(
      disabled.steps.some(
        (step) =>
          step.kind === 'add_column' && step.target.column.spelling === 'oldValue',
      ),
    ).toBe(true)

    expect(
      disabled.steps.some(
        (step) =>
          step.kind === 'drop_column' && step.target.column.spelling === 'old_value',
      ),
    ).toBe(true)

    await plain.migrate().allow('dangerouslyDropColumn').execute()
    expect(await plain.from(Store).execute()).toEqual([{ id: 7, oldValue: null }])
  }
}

export { assertNaming }
