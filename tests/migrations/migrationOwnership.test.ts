import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, defineTable, postgresDialect, reference } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { resolveMigrationOwnership } from '@/migrations/migrationOwnership'

import type { LegacyCatalogSnapshotFixture as CatalogSnapshot } from '../helpers/catalog'
import {
  catalogPrimaryKey as createCatalogPrimaryKey,
  planMigration,
} from '../helpers/catalog'

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
    id: pipe(string(), column({ type: 'uuid' })),
    email: pipe(string(), column({ type: 'text' })),
  },
  { schema: 'public', primaryKey: 'id' },
)

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
  it('owns only the exact registered relation with complete shape by default', () => {
    expect(planMigration([Users], catalog(), postgresDialect)).toEqual({
      steps: [
        {
          kind: 'add_column',
          schema: 'public',
          table: 'users',
          column: 'email',
          dataType: 'text',
          notNull: true,
        },
        {
          kind: 'drop_index',
          schema: 'public',
          table: 'users',
          index: 'users_legacy_idx',
        },
        {
          kind: 'drop_column',
          schema: 'public',
          table: 'users',
          column: 'legacy',
        },
      ],
    })
  })

  it('additive relations create declared members and preserve undeclared members', () => {
    expect(
      planMigration([Users], catalog(), postgresDialect, {
        migrationOwnership: [{ kind: 'relation', relation: Users, shape: 'additive' }],
      }),
    ).toEqual({
      steps: [
        {
          kind: 'add_column',
          schema: 'public',
          table: 'users',
          column: 'email',
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
      steps: [{ kind: 'drop_table', schema: 'public', table: 'billing' }],
    })
  })

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
        { kind: 'drop_table', schema: 'public', table: 'billing' },
        { kind: 'drop_table', schema: 'public', table: 'users' },
      ],
    })
  })

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
    ).toEqual({ steps: [{ kind: 'create_schema', schema: 'empty_app' }] })
  })

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
    ).toEqual({ steps: [{ kind: 'drop_table', schema: 'a.b', table: 'c' }] })

    const declarations = [
      { kind: 'relation' as const, relation: Users, shape: 'additive' as const },
      { kind: 'relation' as const, relation: Users, shape: 'complete' as const },
    ]
    const first = () =>
      planMigration([Users], catalog(), postgresDialect, {
        migrationOwnership: declarations,
      })
    const second = () =>
      planMigration([Users], catalog(), postgresDialect, {
        migrationOwnership: [...declarations].reverse(),
      })
    expect(first).toThrow(/duplicate migration ownership relation/i)
    expect(second).toThrow(/duplicate migration ownership relation/i)
    try {
      first()
    } catch (firstError) {
      try {
        second()
      } catch (secondError) {
        expect((firstError as Error).message).toBe((secondError as Error).message)
      }
    }
  })

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

  it('validates referenced identities even when their handles are not registered', () => {
    const LongTarget = defineTable(
      'x'.repeat(64),
      { id: pipe(string(), column({ type: 'uuid' })) },
      { primaryKey: 'id' },
    )
    const Referencing = defineTable(
      'referencing',
      {
        id: pipe(string(), column({ type: 'uuid' })),
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

  it('stabilizes SQLite-equivalent relation and namespace diagnostics', () => {
    const SqliteUsers = defineTable(
      'Users',
      { id: pipe(string(), column({ type: 'text' })) },
      { primaryKey: 'id' },
    )
    const sqliteIdentities = createCanonicalRelationIdentityModule({
      adapter: 'sqlite',
      context: {
        writableDefault: [{ role: 'database', spelling: 'main' }],
      },
    })
    const message = (declarations: Parameters<typeof resolveMigrationOwnership>[1]) => {
      try {
        resolveMigrationOwnership([SqliteUsers], declarations, sqliteIdentities)
      } catch (error) {
        return (error as Error).message
      }
      throw new Error('Expected ownership resolution to fail')
    }

    const duplicateRelations = [
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
