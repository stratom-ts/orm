import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type { CatalogFact, CatalogSnapshot } from '@/dialects'
import { column, defineTable, postgresDialect } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import { completePostgresCatalog } from '../helpers/catalog'

const context = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    email: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id' },
)
const usersRequest = createCatalogRequest([Users], [])

function emptyCatalog() {
  return completePostgresCatalog(
    {
      namespaceContext: context,
      tables: [],
      nameReservations: [],
      constraintNameReservations: [],
    },
    usersRequest,
  )
}

function usersCatalog() {
  return completePostgresCatalog(
    {
      namespaceContext: context,
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
          ],
          primaryKey: { name: 'users_pkey', columns: ['id'] },
        },
      ],
      nameReservations: [],
      constraintNameReservations: [],
    },
    usersRequest,
  )
}

describe('catalog evidence', () => {
  it('keeps every scalar evidence state distinct', () => {
    const facts: CatalogFact<string>[] = [
      { state: 'present', value: 'value' },
      { state: 'absent' },
      { state: 'unsupported', by: 'engine', reason: 'not available' },
      { state: 'unavailable', cause: 'permission', reason: 'hidden' },
      { state: 'unavailable', cause: 'version', actual: '1', requires: '2' },
      { state: 'unmanaged', reason: 'outside ownership' },
      { state: 'unknown', reason: 'raced' },
    ]

    expect(facts.map((fact) => fact.state)).toEqual([
      'present',
      'absent',
      'unsupported',
      'unavailable',
      'unavailable',
      'unmanaged',
      'unknown',
    ])
  })

  it('requires complete empty coverage before creating a relation', () => {
    expect(
      planMigration([Users], emptyCatalog(), postgresDialect).plan.steps,
    ).toContainEqual({
      kind: 'create_table',
      schema: 'public',
      table: 'users',
    })

    const incomplete: CatalogSnapshot = {
      ...emptyCatalog(),
      namespaces: {
        items: [],
        coverage: {
          state: 'partial',
          remainder: { state: 'unknown', reason: 'catalog query raced' },
        },
      },
    }
    expect(() => planMigration([Users], incomplete, postgresDialect)).toThrow(
      /incomplete catalog coverage.*requested namespaces.*unknown/i,
    )

    const wrongScope: CatalogSnapshot = {
      ...emptyCatalog(),
      request: { relations: [], absentRelations: [], completeNamespaces: [] },
    }
    expect(() => planMigration([Users], wrongScope, postgresDialect)).toThrow(
      /does not cover requested migration target/i,
    )
  })

  it('fails closed for every non-complete collection coverage state', () => {
    const states = [
      { state: 'unsupported' as const, by: 'adapter' as const, reason: 'gap' },
      {
        state: 'unavailable' as const,
        cause: 'permission' as const,
        reason: 'hidden',
      },
      {
        state: 'unavailable' as const,
        cause: 'version' as const,
        actual: '1',
        requires: '2',
      },
      { state: 'unmanaged' as const, reason: 'outside ownership' },
      { state: 'unknown' as const, reason: 'raced' },
    ]

    for (const coverage of states) {
      const catalog: CatalogSnapshot = {
        ...emptyCatalog(),
        namespaces: { items: [], coverage },
      }
      expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(
        /incomplete catalog coverage/i,
      )
    }
  })

  it('blocks a managed comparison when one observed fact is unavailable', () => {
    const catalog = usersCatalog()
    const namespace = catalog.namespaces.items[0]!
    const relation = namespace.relations.items[0]!
    if (relation.table.state !== 'present') throw new Error('expected table fixture')
    const table = relation.table.value
    const email = table.columns.items.find((column) => column.name === 'email')!
    const unavailable: CatalogSnapshot = {
      ...catalog,
      namespaces: {
        coverage: { state: 'complete' },
        items: [
          {
            ...namespace,
            relations: {
              coverage: { state: 'complete' },
              items: [
                {
                  ...relation,
                  table: {
                    state: 'present',
                    value: {
                      ...table,
                      columns: {
                        coverage: { state: 'complete' },
                        items: table.columns.items.map((column) =>
                          column.name === email.name
                            ? {
                                ...column,
                                nullable: {
                                  state: 'unavailable' as const,
                                  cause: 'permission' as const,
                                  reason: 'column metadata hidden',
                                },
                              }
                            : column,
                        ),
                      },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    }

    expect(() => planMigration([Users], unavailable, postgresDialect)).toThrow(
      /incomplete catalog evidence.*nullability.*permission/i,
    )
  })

  it('does not treat an unmanaged collision as confirmed absence', () => {
    const catalog = usersCatalog()
    const namespace = catalog.namespaces.items[0]!
    const relation = namespace.relations.items[0]!
    const unmanaged: CatalogSnapshot = {
      ...catalog,
      namespaces: {
        coverage: { state: 'complete' },
        items: [
          {
            ...namespace,
            relations: {
              coverage: { state: 'complete' },
              items: [{ ...relation, management: 'unmanaged' }],
            },
          },
        ],
      },
    }

    expect(() => planMigration([Users], unmanaged, postgresDialect)).toThrow(
      /collides with an unmanaged catalog relation/i,
    )
  })

  it('preserves opaque objects and blocks destructive changes that could lose them', () => {
    const catalog = completePostgresCatalog(
      {
        namespaceContext: context,
        tables: [
          {
            schema: 'public',
            name: 'users',
            columns: [
              { name: 'id', dataType: 'uuid', isNullable: false },
              { name: 'email', dataType: 'text', isNullable: false },
              { name: 'legacy', dataType: 'text', isNullable: true },
            ],
            primaryKey: { name: 'users_pkey', columns: ['id'] },
            opaqueObjects: [
              {
                kind: 'trigger',
                name: 'users_audit',
                nativeDefinition: 'create trigger users_audit ...',
                reason: 'audit trigger',
              },
            ],
          },
        ],
        nameReservations: [],
        constraintNameReservations: [],
      },
      usersRequest,
    )

    expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(
      /opaque catalog objects.*audit trigger/i,
    )
  })

  it('represents an observed empty namespace without recreating it', () => {
    const ownership = [
      {
        kind: 'completeNamespace' as const,
        namespace: [{ role: 'schema' as const, spelling: 'empty_app' }],
      },
    ]
    const catalog = completePostgresCatalog(
      {
        namespaceContext: context,
        namespaces: ['empty_app'],
        tables: [],
        nameReservations: [],
        constraintNameReservations: [],
      },
      createCatalogRequest([], ownership),
    )

    expect(
      planMigration([], catalog, postgresDialect, {
        migrationOwnership: ownership,
      }).plan,
    ).toEqual({ steps: [] })
  })
})
