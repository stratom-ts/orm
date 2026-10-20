import type { QueryResult } from 'pg'
import { integer, number, pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import type {
  CatalogFact,
  CatalogRelation,
  CatalogSet,
  CatalogSnapshot,
} from '@/dialects/catalog'
import type { CanonicalNamespaceSegment } from '@/index'
import { column, defineTable, postgresDialect, reference } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import { waitForPostgres } from './postgres.setup'
import { quoteIdentifier, withPostgresDatabase } from './postgresIntegration'

const CatalogParents = defineTable(
  'catalog_parents',
  {
    id: pipe(
      number(),
      integer(),
      column({ generation: { kind: 'identity', mode: 'byDefault' } }),
    ),
    code: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'literal()' } }),
    ),
  },
  {
    primaryKey: 'id',
    indexes: [{ name: 'catalog_parents_code_uidx', columns: ['code'], unique: true }],
  },
)

const CatalogChildren = defineTable(
  'catalog_children',
  { id: string(), parentId: reference(CatalogParents, 'id'), label: string() },
  {
    primaryKey: 'id',
    indexes: [{ name: 'catalog_children_label_idx', columns: ['label'] }],
  },
)

/**
 * Checks real PostgreSQL relation identities and decoded table evidence within the
 * requested scope.
 *
 * @param namespace - Ordered role-tagged namespace segments used for identity resolution.
 */
function assertCatalogRelations(
  namespace: import('@/dialects').CatalogNamespace | undefined,
): void {
  const parents = namespace?.relations.items.find(
    ({ identity }) => identity.relation.spelling === 'catalog_parents',
  )

  expect(parents).toMatchObject({
    kind: 'table',
    nativeDefinition: { state: 'unsupported', by: 'adapter' },
    table: { state: 'present' },
  })

  if (parents?.table.state !== 'present') throw new Error('Expected parent table')

  expect(parents.table.value.primaryKey).toMatchObject({ state: 'present' })

  expect(
    parents.table.value.columns.items.find(({ name }) => name === 'id'),
  ).toMatchObject({
    dataType: { state: 'present' },
    nullable: { state: 'present', value: false },
    generation: {
      state: 'present',
      value: { kind: 'identity', mode: 'byDefault' },
    },
  })

  expect(
    parents.table.value.columns.items.find(({ name }) => name === 'code')?.default,
  ).toMatchObject({ state: 'present' })

  expect(
    parents.table.value.indexes.items.find(
      ({ name }) =>
        name.state === 'present' && name.value === 'catalog_parents_code_uidx',
    ),
  ).toMatchObject({ unique: true, semantics: { state: 'present' } })

  expect(
    parents.table.value.indexes.items.find(
      ({ name }) =>
        name.state === 'present' && name.value === 'catalog_parents_expression_idx',
    ),
  ).toMatchObject({
    semantics: { state: 'unsupported', by: 'adapter' },
    nativeDefinition: { state: 'present' },
  })

  assertForeignKeyEvidence(namespace)
}

describe('PostgreSQL catalog integration', () => {
  beforeAll(waitForPostgres)

  it('should report present, absent, complete-empty, and unsupported evidence', async () => {
    await withPostgresDatabase(
      [CatalogParents, CatalogChildren],
      async ({ db, schema, alternateSchema, admin }) => {
        await db.migrate().execute()

        await admin.query(
          `create index ${quoteIdentifier('catalog_parents_expression_idx')}
           on ${quoteIdentifier(schema)}.${quoteIdentifier('catalog_parents')} ((lower(code)))`,
        )

        const database = await admin.query<{ name: string }>(
          'select current_database() as name',
        )

        const registrationDefault = [{ role: 'schema' as const, spelling: schema }]
        const request = integrationCatalogRequest(registrationDefault, alternateSchema)
        const catalog = await postgresDialect.catalog.introspectCatalog(
          {
            /** Executes fixture SQL with the configured native observations. */
            async execute(query) {
              return (await admin.query<Record<string, unknown>>(query.sql, query.params))
                .rows
            },
          },
          request,
        )

        assertCatalogScope(catalog, schema, database, alternateSchema)
      },
    )
  })
})

/**
 * Checks ordered foreign-key source and target columns with their native referential
 * actions.
 *
 * @param namespace - Ordered role-tagged namespace segments used for identity resolution.
 */
function assertForeignKeyEvidence(
  namespace:
    | Readonly<{
        identity: readonly CanonicalNamespaceSegment[]
        owner: CatalogFact<string>
        relations: CatalogSet<CatalogRelation>
      }>
    | undefined,
) {
  const children = namespace?.relations.items.find(
    ({ identity }) => identity.relation.spelling === 'catalog_children',
  )

  if (children?.table.state !== 'present') throw new Error('Expected child table')

  expect(children.table.value.foreignKeys.items[0]).toMatchObject({
    referencedRelation: { relation: { spelling: 'catalog_parents' } },
    referencedColumns: ['id'],
    semantics: { state: 'present' },
  })
}

/**
 * Checks requested namespace coverage and relation ownership against observed native
 * catalog evidence.
 *
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 * @param database - Native database identity or spelling used to scope fixture resources.
 * @param alternateSchema - Second isolated namespace used to test session-default
 *   behavior.
 */
function assertCatalogScope(
  catalog: CatalogSnapshot,
  schema: string,
  database: QueryResult<{ name: string }>,
  alternateSchema: string,
) {
  expect(catalog.source).toEqual({
    dialect: 'postgresql',
    version: expect.stringMatching(/^\d+$/) as unknown,
  })

  expect(catalog.capabilities).toMatchObject({
    namespaces: { state: 'supported', fidelity: 'native' },
    identity: { state: 'supported', fidelity: 'native' },
    richObjects: { state: 'supported', fidelity: 'opaque' },
  })

  const namespace = catalog.namespaces.items.find(
    ({ identity }) => identity.at(-1)?.identifier.spelling === schema,
  )

  expect(namespace?.relations.coverage).toEqual({
    state: 'partial',
    remainder: {
      state: 'unmanaged',
      reason: 'Relations outside the requested catalog scope are unmanaged',
    },
  })

  assertCatalogAbsenceAndReservations(catalog, database, schema, namespace)

  assertCatalogRelations(namespace)

  const emptyNamespace = catalog.namespaces.items.find(
    ({ identity }) => identity.at(-1)?.identifier.spelling === alternateSchema,
  )

  expect(emptyNamespace).toMatchObject({
    owner: { state: 'present' },
    relations: { items: [], coverage: { state: 'complete' } },
  })
}

/**
 * Checks declared-absent relations and native physical-name reservations in the isolated
 * schema.
 *
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 * @param database - Native database identity or spelling used to scope fixture resources.
 * @param schema - Isolated or resolved SQL schema spelling used for physical relation
 *   access.
 * @param namespace - Ordered role-tagged namespace segments used for identity resolution.
 */
function assertCatalogAbsenceAndReservations(
  catalog: CatalogSnapshot,
  database: QueryResult<{ name: string }>,
  schema: string,
  namespace:
    | Readonly<{
        identity: readonly CanonicalNamespaceSegment[]
        owner: CatalogFact<string>
        relations: CatalogSet<CatalogRelation>
      }>
    | undefined,
) {
  const absent = catalog.request.absentRelations.find(
    ({ relation }) => relation.spelling === 'catalog_missing',
  )

  expect(absent).toEqual({
    namespace: [
      {
        role: 'database',
        identifier: {
          spelling: database.rows[0]!.name,
          comparisonKey: database.rows[0]!.name,
        },
      },
      {
        role: 'schema',
        identifier: { spelling: schema, comparisonKey: schema },
      },
    ],
    relation: { spelling: 'catalog_missing', comparisonKey: 'catalog_missing' },
  })

  expect(
    namespace?.relations.items.some(
      ({ identity }) => identity.relation.spelling === 'catalog_missing',
    ),
  ).toBe(false)

  expect(catalog.nameReservations.coverage).toEqual({ state: 'complete' })

  expect(
    catalog.nameReservations.items.some(
      ({ namespace: reservedNamespace, name }) =>
        reservedNamespace.at(-1)?.identifier.spelling === schema &&
        name === 'catalog_missing',
    ),
  ).toBe(false)
}

/**
 * Requests fixture relations, an absent relation, and complete alternate-namespace
 * coverage.
 *
 * @param registrationDefault - Schema segments used by the registered fixture tables.
 * @param alternateSchema - Empty namespace whose complete coverage is asserted.
 *
 * @returns The exact integration catalog ownership request.
 */
function integrationCatalogRequest(
  registrationDefault: Parameters<typeof createCatalogRequest>[2],
  alternateSchema: string,
) {
  return createCatalogRequest(
    [CatalogParents, CatalogChildren],
    [
      {
        kind: 'absentRelation',
        relation: {
          namespace: registrationDefault,
          relation: 'catalog_missing',
        },
      },
      {
        kind: 'completeNamespace',
        namespace: [{ role: 'schema', spelling: alternateSchema }],
      },
    ],
    registrationDefault,
  )
}
