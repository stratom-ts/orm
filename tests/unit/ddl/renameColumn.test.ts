import { nullable, pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { MigrationColumnRename } from '@/ddl/renameColumn'
import type { CatalogSnapshot } from '@/dialects/catalog'
import type { TableHandle } from '@/index'
import { column, defineTable, postgresDialect } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import { completePostgresCatalog } from '../dialects/postgresCatalogFixtures'

const User = defineTable(
  'users',
  { id: string(), fullName: nullable(string()), second: nullable(string()) },
  { primaryKey: 'id' },
)

const context = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const intent: MigrationColumnRename = { table: User, from: 'displayName', to: 'fullName' }

function catalog(
  names = ['id', 'displayName', 'second'],
  handles: TableHandle[] = [User],
): CatalogSnapshot {
  const snapshot = completePostgresCatalog(
    {
      namespaceContext: context,
      nameReservations: [],
      constraintNameReservations: [],
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: names.map((name) => ({
            name,
            dataType: 'text',
            isNullable: name !== 'id',
          })),
          primaryKey: { name: 'users_pkey', columns: ['id'] },
        },
      ],
    },
    createCatalogRequest(handles, []),
  )

  return {
    ...snapshot,
    renameDependencies: {
      coverage: { state: 'complete' },
      items: snapshot.namespaces.items.flatMap((namespace) => namespace.relations.items),
    },
  }
}

function plan(renames: readonly MigrationColumnRename[], snapshot = catalog()) {
  return planMigration([User], snapshot, postgresDialect, { renames })
}

it('projects without modifying original evidence and uses a structured destination target', () => {
  const original = catalog()
  const before = structuredClone(original)
  const planned = plan([intent], original)
  expect(original).toEqual(before)
  expect(planned.originalCatalogSnapshot).toBe(original)
  expect(planned.plan.steps).toHaveLength(1)

  expect(planned.plan.steps[0]).toMatchObject({
    kind: 'rename_column',
    target: {
      kind: 'column',
      column: { spelling: 'fullName', comparisonKey: 'fullName' },
    },
    from: { spelling: 'displayName', comparisonKey: 'displayName' },
  })
})

it('deduplicates identical mappings and canonically orders independent intent sets', () => {
  const second = { table: User, from: 'oldSecond', to: 'second' }
  const original = catalog(['id', 'displayName', 'oldSecond'])
  expect(plan([second, intent, intent], original).plan).toEqual(
    plan([intent, second], original).plan,
  )

  expect(plan([intent, second], original).plan.steps.map((step) => step.kind)).toEqual([
    'rename_column',
    'rename_column',
  ])
})

it.each([
  ['same key', [{ ...intent, from: 'fullName' }]],
  ['missing destination', [{ ...intent, to: 'missing' }]],
  ['desired source', [{ ...intent, from: 'second' }]],
  ['fan out', [intent, { ...intent, to: 'second' }]],
  ['fan in', [intent, { ...intent, from: 'another' }]],
  ['chain', [intent, { ...intent, from: 'fullName', to: 'second' }]],
  ['cycle', [intent, { ...intent, from: 'fullName', to: 'displayName' }]],
  [
    'unregistered',
    [
      {
        ...intent,
        table: defineTable(
          'users',
          { id: string(), fullName: string() },
          { primaryKey: 'id' },
        ),
      },
    ],
  ],
  ['empty identifier', [{ ...intent, from: '' }]],
  ['NUL identifier', [{ ...intent, from: 'bad\0name' }]],
] as const)('rejects %s mappings', (_reason, renames) => {
  expect(() => plan(renames)).toThrow(/./)
})

it.each([
  ['id', 'displayName', 'fullName', 'second'],
  ['id', 'second'],
])('rejects conflicting observed names %j', (...names) => {
  expect(() => plan([intent], catalog(names))).toThrow('exactly one')
})

it('requires complete dependency coverage and target evidence', () => {
  expect(() => plan([intent], { ...catalog(), renameDependencies: undefined })).toThrow(
    'complete dependency',
  )

  expect(() =>
    plan([intent], {
      ...catalog(),
      renameDependencies: { coverage: { state: 'complete' }, items: [] },
    }),
  ).toThrow('omits rename target')
})

it('treats an observed destination as satisfied while still planning residual drift', () => {
  const Required = defineTable(
    'users',
    { id: string(), fullName: string(), second: nullable(string()) },
    { primaryKey: 'id' },
  )

  const original = catalog(['id', 'fullName', 'second'], [Required])
  const planned = planMigration([Required], original, postgresDialect, {
    renames: [{ table: Required, from: 'displayName', to: 'fullName' }],
  })

  expect(planned.plan.steps).toMatchObject([
    { kind: 'set_not_null', target: { column: { spelling: 'fullName' } } },
  ])
})

it('uses physical destination names rather than application property names', () => {
  const Physical = defineTable(
    'users',
    {
      id: string(),
      fullName: pipe(nullable(string()), column({ name: 'full_name' })),
      second: nullable(string()),
    },
    { primaryKey: 'id' },
  )

  const original = catalog(undefined, [Physical])
  expect(() =>
    planMigration([Physical], original, postgresDialect, {
      renames: [{ table: Physical, from: 'displayName', to: 'fullName' }],
    }),
  ).toThrow('physical column')

  expect(
    planMigration([Physical], original, postgresDialect, {
      renames: [{ table: Physical, from: 'displayName', to: 'full_name' }],
    }).plan.steps,
  ).toMatchObject([
    { kind: 'rename_column', target: { column: { spelling: 'full_name' } } },
  ])
})

it('produces equal plans under registration and independent intent permutations', () => {
  const Other = defineTable(
    'other',
    { id: string(), fullName: nullable(string()) },
    { primaryKey: 'id' },
  )

  const handles = [User, Other]
  const fixture = completePostgresCatalog(
    {
      namespaceContext: context,
      nameReservations: [],
      constraintNameReservations: [],
      tables: handles.map((handle) => ({
        schema: 'public',
        name: handle === User ? 'users' : 'other',
        primaryKey: {
          name: handle === User ? 'users_pkey' : 'other_pkey',
          columns: ['id'],
        },
        columns: ['id', 'displayName', ...(handle === User ? ['second'] : [])].map(
          (name) => ({ name, dataType: 'text', isNullable: name !== 'id' }),
        ),
      })),
    },
    createCatalogRequest(handles, []),
  )

  const original = {
    ...fixture,
    renameDependencies: {
      coverage: { state: 'complete' as const },
      items: fixture.namespaces.items.flatMap((namespace) => namespace.relations.items),
    },
  }

  const other = { table: Other, from: 'displayName', to: 'fullName' }
  expect(
    planMigration(handles, original, postgresDialect, { renames: [intent, other] }).plan,
  ).toEqual(
    planMigration([...handles].reverse(), original, postgresDialect, {
      renames: [other, intent],
    }).plan,
  )
})
