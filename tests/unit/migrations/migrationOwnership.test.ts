import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, defineTable, postgresDialect, reference } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import {
  createCatalogRequest,
  resolveMigrationOwnership,
} from '@/migrations/migrationOwnership'
import { InvariantError, attemptSync } from '@/utils/error'

import type { PostgresCatalogSnapshotFixture as CatalogSnapshot } from '../helpers/catalog'
import {
  catalogPrimaryKey as createCatalogPrimaryKey,
  planMigration,
} from '../helpers/catalog'
import { SQLITE_IDENTITY_POLICY } from '../helpers/dialectPolicies'
import {
  columnTarget,
  indexTarget,
  namespaceTarget,
  relationTarget,
} from '../helpers/planTargets'

const context = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}
const emptyReservations = {
  nameReservations: [],
  constraintNameReservations: [],
}
const supportedSimple = {
  semanticCompleteness: 'supportedSimple' as const,
  isValid: true,
}
const catalogPrimaryKey = createCatalogPrimaryKey(supportedSimple)

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { namespace: [{ role: 'schema', spelling: 'public' }], primaryKey: 'id' },
)

/** Builds catalog evidence for schema reconciliation checks. */
function catalog(): CatalogSnapshot {
  return {
    namespaceContext: context,
    ...emptyReservations,
    tables: [
      {
        schema: 'public',
        name: 'users',
        columns: [
          { name: 'id', dataType: 'uuid', isNullable: false },
          { name: 'legacy', dataType: 'text', isNullable: true },
        ],
        indexes: [
          {
            name: 'users_legacy_idx',
            columns: ['legacy'],
            unique: false,
            ...supportedSimple,
          },
        ],
        primaryKey: catalogPrimaryKey('users'),
      },
      {
        schema: 'public',
        name: 'billing',
        columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
        primaryKey: catalogPrimaryKey('billing'),
      },
      {
        schema: 'other',
        name: 'billing',
        columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
        primaryKey: catalogPrimaryKey('billing'),
      },
    ],
  }
}

describe('migration ownership', () => {
  it('projects registered handles using their structured relation metadata', () => {
    const Scoped = defineTable(
      'users',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      {
        primaryKey: 'id',
        namespace: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'audit' },
        ],
      },
    )

    expect(createCatalogRequest([Scoped], [], undefined).relations[0]!.relation).toBe(
      Scoped.getTableMetadata().relation,
    )
  })

  it('owns only the exact registered relation with complete shape by default', () => {
    expect(planMigration([Users], catalog(), postgresDialect)).toEqual({
      steps: [
        {
          kind: 'add_column',
          target: columnTarget('public', 'users', 'email'),
          dataType: 'text',
          notNull: true,
        },
        {
          kind: 'drop_index',
          target: indexTarget('public', 'users', 'users_legacy_idx'),
        },
        { kind: 'drop_column', target: columnTarget('public', 'users', 'legacy') },
      ],
    })
  })
})

describe('migration ownership: additive relations create declared members and preserve undeclared members', () => {
  it('additive relations create declared members and preserve undeclared members', () => {
    expect(
      planMigration([Users], catalog(), postgresDialect, {
        migrationOwnership: [{ kind: 'relation', relation: Users, shape: 'additive' }],
      }),
    ).toEqual({
      steps: [
        {
          kind: 'add_column',
          target: columnTarget('public', 'users', 'email'),
          dataType: 'text',
          notNull: true,
        },
      ],
    })
  })

  it('drops only exact tombstones when no namespace is complete', () => {
    expect(
      planMigration([], catalog(), postgresDialect, {
        migrationOwnership: [
          {
            kind: 'absentRelation',
            relation: {
              namespace: [{ role: 'schema', spelling: 'public' }],
              relation: 'billing',
            },
          },
        ],
      }),
    ).toEqual({
      steps: [{ kind: 'drop_table', target: relationTarget('public', 'billing') }],
    })
  })
})

describe('migration ownership: supports an empty complete namespace over observed relations', () => {
  it('supports an empty complete namespace over observed relations', () => {
    expect(
      planMigration([], catalog(), postgresDialect, {
        migrationOwnership: [
          {
            kind: 'completeNamespace',
            namespace: [{ role: 'schema', spelling: 'public' }],
          },
        ],
      }),
    ).toEqual({
      steps: [
        { kind: 'drop_table', target: relationTarget('public', 'billing') },
        { kind: 'drop_table', target: relationTarget('public', 'users') },
      ],
    })
  })
})

describe('migration ownership: ensures an explicitly complete namespace even with no handles or observed tables', () => {
  it('ensures an explicitly complete namespace even with no handles or observed tables', () => {
    expect(
      planMigration(
        [],
        { namespaceContext: context, tables: [], ...emptyReservations },
        postgresDialect,
        {
          migrationOwnership: [
            {
              kind: 'completeNamespace',
              namespace: [{ role: 'schema', spelling: 'empty_app' }],
            },
          ],
        },
      ),
    ).toEqual({
      steps: [{ kind: 'ensure_namespace', target: namespaceTarget('empty_app') }],
    })
  })
})

describe('migration ownership identities and validation', () => {
  it('uses canonical identities for dotted tombstones and deterministic conflicts', () => {
    const dottedCatalog: CatalogSnapshot = {
      namespaceContext: context,
      ...emptyReservations,
      tables: [
        {
          schema: 'a.b',
          name: 'c',
          columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
          primaryKey: catalogPrimaryKey('c'),
        },
        {
          schema: 'a',
          name: 'b.c',
          columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
          primaryKey: catalogPrimaryKey('b.c'),
        },
      ],
    }
    assertDottedOwnershipDiagnostics(dottedCatalog)

    const declarations = [
      { kind: 'relation' as const, relation: Users, shape: 'additive' as const },
      { kind: 'relation' as const, relation: Users, shape: 'complete' as const },
    ]
    /** Plans ownership declarations in their original order for determinism checks. */
    const first = () =>
      planMigration([Users], catalog(), postgresDialect, {
        migrationOwnership: declarations,
      })
    /** Plans ownership declarations in reverse order for determinism checks. */
    const second = () =>
      planMigration([Users], catalog(), postgresDialect, {
        migrationOwnership: [...declarations].reverse(),
      })
    expect(first).toThrow(/duplicate migration ownership relation/i)
    expect(second).toThrow(/duplicate migration ownership relation/i)
    const firstAttempt = attemptSync(first)
    const secondAttempt = attemptSync(second)

    if (firstAttempt.ok || secondAttempt.ok)
      throw new Error('Expected both ownership plans to fail')

    expect((firstAttempt.error as Error).message).toBe(
      (secondAttempt.error as Error).message,
    )
  })
})

describe('migration ownership identities and validation: rejects a tombstone that contradicts a registered handle', () => {
  it('rejects a tombstone that contradicts a registered handle', () => {
    expect(() =>
      planMigration([Users], catalog(), postgresDialect, {
        migrationOwnership: [
          {
            kind: 'absentRelation',
            relation: {
              namespace: [{ role: 'schema', spelling: 'public' }],
              relation: 'users',
            },
          },
        ],
      }),
    ).toThrow(/contradictory present and absent/i)
  })
})

describe('migration ownership identities and validation: validates identifiers reachable only through ownership declarations', () => {
  it('validates identifiers reachable only through ownership declarations', () => {
    const emptyCatalog: CatalogSnapshot = {
      namespaceContext: context,
      tables: [],
      ...emptyReservations,
    }
    expect(() =>
      planMigration([], emptyCatalog, postgresDialect, {
        migrationOwnership: [
          {
            kind: 'completeNamespace',
            namespace: [{ role: 'schema', spelling: 'x'.repeat(64) }],
          },
        ],
      }),
    ).toThrow(/identifier limit of 63 UTF-8 bytes/i)

    expect(() =>
      planMigration([], emptyCatalog, postgresDialect, {
        migrationOwnership: [
          {
            kind: 'absentRelation',
            relation: { relation: 'x'.repeat(64) },
          },
        ],
      }),
    ).toThrow(/identifier limit of 63 UTF-8 bytes/i)
  })
})

describe('migration ownership identities and validation: validates identifiers reachable only through ownership declarations: validates referenced identities even when their handles are not registered', () => {
  it('validates referenced identities even when their handles are not registered', () => {
    const LongTarget = defineTable(
      'x'.repeat(64),
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Referencing = defineTable(
      'referencing',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: reference(LongTarget, 'id'),
      },
      { primaryKey: 'id' },
    )
    expect(() =>
      planMigration(
        [Referencing],
        { namespaceContext: context, tables: [], ...emptyReservations },
        postgresDialect,
      ),
    ).toThrow(/identifier limit of 63 UTF-8 bytes/i)
  })
})

describe('migration ownership identities and validation: stabilizes SQLite-equivalent relation and namespace diagnostics', () => {
  it('stabilizes SQLite-equivalent relation and namespace diagnostics', () => {
    const SqliteUsers = defineTable(
      'Users',
      { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
      { primaryKey: 'id' },
    )
    const sqliteIdentities = createCanonicalRelationIdentityModule({
      policy: SQLITE_IDENTITY_POLICY,
      context: {
        writableDefault: [{ role: 'database', spelling: 'main' }],
      },
    })

    /** Reads the expected ownership failure for these declarations. */
    const message = (declarations: Parameters<typeof resolveMigrationOwnership>[1]) =>
      ownershipFailureMessage(declarations, SqliteUsers, sqliteIdentities)

    const duplicateRelations = createDuplicateSqliteOwnership()
    expect(message(duplicateRelations)).toBe(message([...duplicateRelations].reverse()))

    const contradictory = [
      duplicateRelations[0]!,
      { kind: 'absentRelation' as const, relation: { relation: 'users' } },
    ]
    expect(message(contradictory)).toBe(message([...contradictory].reverse()))

    const duplicateNamespaces = [
      {
        kind: 'completeNamespace' as const,
        namespace: [{ role: 'database' as const, spelling: 'MAIN' }],
      },
      {
        kind: 'completeNamespace' as const,
        namespace: [{ role: 'database' as const, spelling: 'main' }],
      },
    ]
    expect(message(duplicateNamespaces)).toBe(message([...duplicateNamespaces].reverse()))
  })
})

/**
 * Creates the duplicate sqlite ownership fixture used by the contract scenario.
 *
 * @returns The duplicate sqlite ownership fixture used by the contract scenario.
 */
function createDuplicateSqliteOwnership() {
  return [
    {
      kind: 'relation' as const,
      relation: { relation: 'Users' },
      shape: 'complete' as const,
    },
    {
      kind: 'relation' as const,
      relation: { relation: 'users' },
      shape: 'additive' as const,
    },
  ]
}

/**
 * Checks structured dotted identifiers and deterministic ownership-conflict diagnostics.
 *
 * @param dottedCatalog - Catalog fixture with dots inside structured identifier
 *   spellings.
 */
function assertDottedOwnershipDiagnostics(dottedCatalog: CatalogSnapshot) {
  expect(
    planMigration([], dottedCatalog, postgresDialect, {
      migrationOwnership: [
        {
          kind: 'absentRelation',
          relation: {
            namespace: [{ role: 'schema', spelling: 'a.b' }],
            relation: 'c',
          },
        },
      ],
    }),
  ).toEqual({ steps: [{ kind: 'drop_table', target: relationTarget('a.b', 'c') }] })
}

/**
 * Captures an ownership failure and rejects unexpected resolution success.
 *
 * @param declarations - Ownership declarations under test.
 * @param SqliteUsers - Registered SQLite users handle.
 * @param sqliteIdentities - Canonical SQLite identity policy and namespace defaults.
 *
 * @returns The ownership validation failure message.
 */
function ownershipFailureMessage(
  declarations: Parameters<typeof resolveMigrationOwnership>[1],
  SqliteUsers: Parameters<typeof resolveMigrationOwnership>[0][number],
  sqliteIdentities: Parameters<typeof resolveMigrationOwnership>[2],
): string {
  const resolution = attemptSync(() =>
    resolveMigrationOwnership([SqliteUsers], declarations, sqliteIdentities),
  )

  if (!resolution.ok) return (resolution.error as Error).message

  throw new InvariantError('Expected ownership resolution to fail')
}
