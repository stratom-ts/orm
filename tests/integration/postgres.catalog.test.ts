import { integer, number, pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

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

describe('PostgreSQL catalog integration', () => {
  beforeAll(waitForPostgres)

  it('reports present, absent, complete-empty, and unsupported evidence', async () => {
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
        const request = createCatalogRequest(
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
        const catalog = await postgresDialect.catalog.introspectCatalog(
          {
            async execute(query) {
              return (await admin.query(query.sql, query.params)).rows
            },
          },
          request,
        )

        expect(catalog.source).toEqual({
          dialect: 'postgresql',
          version: expect.stringMatching(/^\d+$/),
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

        const children = namespace?.relations.items.find(
          ({ identity }) => identity.relation.spelling === 'catalog_children',
        )
        if (children?.table.state !== 'present') throw new Error('Expected child table')

        expect(children.table.value.foreignKeys.items[0]).toMatchObject({
          referencedRelation: { relation: { spelling: 'catalog_parents' } },
          referencedColumns: ['id'],
          semantics: { state: 'present' },
        })

        const emptyNamespace = catalog.namespaces.items.find(
          ({ identity }) => identity.at(-1)?.identifier.spelling === alternateSchema,
        )
        expect(emptyNamespace).toMatchObject({
          owner: { state: 'present' },
          relations: { items: [], coverage: { state: 'complete' } },
        })
      },
    )
  })
})
