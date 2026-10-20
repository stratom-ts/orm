import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type {
  CatalogColumn,
  CatalogFact,
  CatalogRelation,
  CatalogSnapshot,
  CatalogTable,
} from '@/dialects'
import { column, defineTable, postgresDialect } from '@/index'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

import { relationTarget } from '../helpers/planTargets'
import type { CompletePostgresCatalogFixture } from '../helpers/postgresCatalogFixtures'
import { completePostgresCatalog } from '../helpers/postgresCatalogFixtures'

const context = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id' },
)

const usersRequest = createCatalogRequest([Users], [])

/**
 * Builds empty catalog evidence for schema reconciliation checks.
 *
 * @returns Empty catalog evidence for schema reconciliation checks.
 */
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

/**
 * Builds users catalog evidence for schema reconciliation checks.
 *
 * @returns Users catalog evidence for schema reconciliation checks.
 */
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

    const describe = describeCatalogFact

    expect(facts.map(describe)).toEqual([
      'present:value',
      'absent',
      'unsupported:engine',
      'unavailable:permission',
      'unavailable:version',
      'unmanaged:outside ownership',
      'unknown:raced',
    ])
  })
})

describe('catalog evidence: requires complete empty coverage before creating a relation', () => {
  it('requires complete empty coverage before creating a relation', () => {
    const empty = emptyCatalog()
    const original = structuredClone(empty)

    expect(planMigration([Users], empty, postgresDialect).plan).toEqual({
      steps: [
        {
          kind: 'create_table',
          target: relationTarget('public', 'users'),
        },
      ],
    })

    expect(empty).toEqual(original)

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
})

describe('catalog evidence: fails closed for every non-complete collection coverage state', () => {
  it('fails closed for every non-complete collection coverage state', () => {
    const cases = createIncompleteCoverageCases()

    for (const { coverage, evidence } of cases) {
      const catalog: CatalogSnapshot = {
        ...emptyCatalog(),
        namespaces: { items: [], coverage },
      }

      const original = structuredClone(catalog)

      expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(
        `Incomplete catalog coverage for requested namespaces: ${evidence}`,
      )

      expect(catalog).toEqual(original)
    }
  })
})

const reportsCaseColumnEvidenceWithoutMutatingTheSnapshotCases1 = [
  {
    state: 'absent',
    fact: { state: 'absent' as const },
    evidence: 'absent',
  },
  {
    state: 'engine unsupported',
    fact: {
      state: 'unsupported' as const,
      by: 'engine' as const,
      reason: 'engine has no type metadata',
    },
    evidence: 'unsupported by engine',
  },
  {
    state: 'adapter unsupported',
    fact: {
      state: 'unsupported' as const,
      by: 'adapter' as const,
      reason: 'adapter cannot decode the type',
    },
    evidence: 'unsupported by adapter',
  },
  {
    state: 'permission unavailable',
    fact: {
      state: 'unavailable' as const,
      cause: 'permission' as const,
      reason: 'metadata is hidden',
    },
    evidence: 'unavailable (permission)',
  },
  {
    state: 'version unavailable',
    fact: {
      state: 'unavailable' as const,
      cause: 'version' as const,
      actual: '1',
      requires: '2',
    },
    evidence: 'unavailable (version)',
  },
  {
    state: 'unknown',
    fact: { state: 'unknown' as const, reason: 'catalog query raced' },
    evidence: 'unknown',
  },
] as const

describe('catalog collection coverage states', () => {
  it.each(reportsCaseColumnEvidenceWithoutMutatingTheSnapshotCases1)(
    'reports $state column evidence without mutating the snapshot',
    (testCase) => {
      const catalog = usersCatalog()
      const relation = catalog.namespaces.items[0]!.relations.items[0]!

      if (relation.table.state !== 'present') throw new Error('expected table fixture')

      const email = relation.table.value.columns.items.find(
        (column) => column.name === 'email',
      )!

      ;(email as { dataType: typeof email.dataType }).dataType =
        testCase.fact as typeof email.dataType
      const original = structuredClone(catalog)

      expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(
        `Incomplete catalog evidence for [database:"test", schema:"public", relation:"users", column:"email"] type: ${testCase.evidence}`,
      )

      expect(catalog).toEqual(original)
    },
  )
})

describe('catalog evidence management and ownership', () => {
  it('blocks a managed comparison when one observed fact is unavailable', () => {
    const catalog = usersCatalog()
    const namespace = catalog.namespaces.items[0]!
    const relation = namespace.relations.items[0]!

    if (relation.table.state !== 'present') throw new Error('expected table fixture')

    const table = relation.table.value
    const email = table.columns.items.find((column) => column.name === 'email')!
    const unavailable: CatalogSnapshot = createUnavailableColumnCatalog(
      catalog,
      namespace,
      relation,
      table,
      email,
    )

    expect(() => planMigration([Users], unavailable, postgresDialect)).toThrow(
      /incomplete catalog evidence.*nullability.*permission/i,
    )
  })
})

describe('catalog evidence management and ownership: does not treat an unmanaged collision as confirmed absence', () => {
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
})

describe('catalog evidence management and ownership: allows partial unmanaged remainder for an exact relation request', () => {
  it('allows partial unmanaged remainder for an exact relation request', () => {
    const catalog = usersCatalog()
    const namespace = catalog.namespaces.items[0]!
    ;(namespace as { relations: typeof namespace.relations }).relations = {
      ...namespace.relations,
      coverage: {
        state: 'partial',
        remainder: { state: 'unmanaged', reason: 'outside the exact relation request' },
      },
    }
    const original = structuredClone(catalog)

    expect(planMigration([Users], catalog, postgresDialect).plan).toEqual({ steps: [] })
    expect(catalog).toEqual(original)
  })
})

describe('catalog evidence management and ownership: rejects partial unmanaged remainder for complete namespace ownership', () => {
  it('rejects partial unmanaged remainder for complete namespace ownership', () => {
    const catalog = usersCatalog()
    const namespace = catalog.namespaces.items[0]!
    const ownership = [
      {
        kind: 'completeNamespace' as const,
        namespace: [{ role: 'schema' as const, spelling: 'public' }],
      },
    ]

    ;(catalog as { request: CatalogSnapshot['request'] }).request = {
      relations: [],
      absentRelations: [],
      completeNamespaces: [namespace.identity],
    }
    ;(namespace as { relations: typeof namespace.relations }).relations = {
      ...namespace.relations,
      coverage: {
        state: 'partial',
        remainder: { state: 'unmanaged', reason: 'outside adapter ownership' },
      },
    }
    const original = structuredClone(catalog)

    expect(() =>
      planMigration([Users], catalog, postgresDialect, {
        migrationOwnership: ownership,
      }),
    ).toThrow(
      'Incomplete catalog coverage for relations in namespace [{"role":"database","spelling":"test"},{"role":"schema","spelling":"public"}]: unmanaged',
    )

    expect(catalog).toEqual(original)
  })
})

describe('catalog evidence management and ownership: preserves opaque objects and blocks destructive changes that could lose them', () => {
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

    const original = structuredClone(catalog)

    expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(
      /opaque catalog objects.*audit trigger/i,
    )

    expect(catalog).toEqual(original)
  })
})

describe('catalog evidence management and ownership: preserves opaque objects and blocks destructive changes that could lose them: represents an observed empty namespace without recreating it', () => {
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

/**
 * Copies the catalog fixture with one column's nullability evidence deliberately
 * unavailable.
 *
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 * @param namespace - Ordered role-tagged namespace segments used for identity resolution.
 * @param relation - Authored or canonical relation addressed by this operation.
 * @param table - Table metadata or evidence used to resolve its members.
 * @param email - Authored email value used by the write-validation scenario.
 *
 * @returns The catalog fixture with one column's nullability evidence deliberately
 *   unavailable.
 */
function createUnavailableColumnCatalog(
  catalog: CompletePostgresCatalogFixture,
  namespace: CatalogSnapshot['namespaces']['items'][number],
  relation: CatalogRelation,
  table: CatalogTable,
  email: CatalogColumn,
): CatalogSnapshot {
  return {
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
}

/**
 * Builds explicit unsupported, unavailable, unmanaged, and unknown coverage cases.
 *
 * @returns Coverage cases with the exact diagnostic evidence expected by the tests.
 */
function createIncompleteCoverageCases() {
  return [
    {
      coverage: {
        state: 'unsupported' as const,
        by: 'adapter' as const,
        reason: 'gap',
      },
      evidence: 'unsupported by adapter',
    },
    {
      coverage: {
        state: 'unavailable' as const,
        cause: 'permission' as const,
        reason: 'hidden',
      },
      evidence: 'unavailable (permission)',
    },
    {
      coverage: {
        state: 'unavailable' as const,
        cause: 'version' as const,
        actual: '1',
        requires: '2',
      },
      evidence: 'unavailable (version)',
    },
    {
      coverage: { state: 'unmanaged' as const, reason: 'outside ownership' },
      evidence: 'unmanaged',
    },
    {
      coverage: { state: 'unknown' as const, reason: 'raced' },
      evidence: 'unknown',
    },
  ]
}

/**
 * Formats a catalog fact's state and retained provenance for assertions.
 *
 * @param fact - Catalog evidence whose state and provenance are formatted.
 *
 * @returns A catalog fact's state and retained provenance for assertions.
 */
function describeCatalogFact(fact: CatalogFact<string>): string {
  switch (fact.state) {
    case 'present':
      return `present:${fact.value}`
    case 'absent':
      return 'absent'
    case 'unsupported':
      return `unsupported:${fact.by}`
    case 'unavailable':
      return `unavailable:${fact.cause}`
    case 'unmanaged':
      return `unmanaged:${fact.reason}`
    case 'unknown':
      return `unknown:${fact.reason}`
    default: {
      const exhaustive: never = fact
      return exhaustive
    }
  }
}
