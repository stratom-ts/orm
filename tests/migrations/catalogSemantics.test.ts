import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, defineTable, postgresDialect, reference } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import {
  POSTGRES_PHYSICAL_NAMING,
  generatedUniqueName,
} from '@/migrations/physicalNaming'

import type {
  LegacyCatalogForeignKeyFixture as CatalogForeignKey,
  LegacyCatalogSnapshotFixture as CatalogSnapshot,
} from '../helpers/catalog'
import {
  catalogPrimaryKey as createCatalogPrimaryKey,
  planMigration,
} from '../helpers/catalog'

const namespaceContext = {
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

const IndexedEvents = defineTable(
  'indexed_events',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    payload: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', indexes: [{ columns: ['payload'] }] },
)
const UniqueIndexedEvents = defineTable(
  'indexed_events',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    payload: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', indexes: [{ columns: ['payload'], unique: true }] },
)

function indexedCatalog(
  overrides: Partial<NonNullable<CatalogSnapshot['tables'][number]['indexes']>[number]>,
): CatalogSnapshot {
  return {
    namespaceContext,
    ...emptyReservations,
    tables: [
      {
        schema: 'public',
        name: 'indexed_events',
        columns: [
          { name: 'id', dataType: 'uuid', isNullable: false },
          { name: 'payload', dataType: 'text', isNullable: false },
        ],
        indexes: [
          {
            name: 'legacy_payload_idx',
            columns: ['payload'],
            unique: false,
            ...supportedSimple,
            ...overrides,
          },
        ],
        primaryKey: catalogPrimaryKey('indexed_events'),
      },
    ],
  }
}

const Parents = defineTable(
  'parents',
  { id: pipe(string(), column({ type: 'uuid' })) },
  { primaryKey: 'id' },
)

const Children = defineTable(
  'children',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    parentId: reference(Parents, 'id'),
    email: pipe(string(), column({ type: 'text', unique: true })),
  },
  { primaryKey: 'id' },
)

function desiredForeignKey(
  overrides: Partial<CatalogForeignKey> = {},
): CatalogForeignKey {
  return {
    name: 'legacy_parent_fkey',
    columns: ['parentId'],
    referencedSchema: 'public',
    referencedTable: 'parents',
    referencedColumns: ['id'],
    onDelete: 'no action',
    onUpdate: 'no action',
    ...supportedSimple,
    ...overrides,
  }
}

function relationCatalog(options?: {
  uniqueConstraints?: CatalogSnapshot['tables'][number]['uniqueConstraints']
  foreignKeys?: CatalogSnapshot['tables'][number]['foreignKeys']
  extraColumns?: boolean
}): CatalogSnapshot {
  return {
    namespaceContext,
    ...emptyReservations,
    tables: [
      {
        schema: 'public',
        name: 'parents',
        columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
        primaryKey: catalogPrimaryKey('parents'),
      },
      {
        schema: 'public',
        name: 'children',
        columns: [
          { name: 'id', dataType: 'uuid', isNullable: false },
          { name: 'parentId', dataType: 'uuid', isNullable: false },
          { name: 'email', dataType: 'text', isNullable: false },
          ...(options?.extraColumns
            ? [{ name: 'legacy', dataType: 'text', isNullable: true }]
            : []),
        ],
        uniqueConstraints: options?.uniqueConstraints ?? [],
        foreignKeys: options?.foreignKeys ?? [],
        primaryKey: catalogPrimaryKey('children'),
      },
    ],
  }
}

const additiveOwnership = [
  { kind: 'relation' as const, relation: Children, shape: 'additive' as const },
]

describe('catalog semantic adoption', () => {
  it('fails closed for partial and invalid indexes', () => {
    expect(() =>
      planMigration(
        [IndexedEvents],
        indexedCatalog({
          semanticCompleteness: 'unsupported',
          isValid: true,
        }),
        postgresDialect,
      ),
    ).toThrow(/unsupported index catalog semantics/i)

    expect(() =>
      planMigration(
        [IndexedEvents],
        indexedCatalog({
          semanticCompleteness: 'supportedSimple',
          isValid: false,
        }),
        postgresDialect,
      ),
    ).toThrow(/unsupported index catalog semantics/i)
  })

  it('rejects unsupported standalone indexes and unique constraints', () => {
    expect(() =>
      planMigration(
        [UniqueIndexedEvents],
        indexedCatalog({
          unique: true,
          semanticCompleteness: 'unsupported',
          isValid: true,
        }),
        postgresDialect,
      ),
    ).toThrow(/unsupported index catalog semantics/i)

    expect(() =>
      planMigration(
        [Parents, Children],
        relationCatalog({
          uniqueConstraints: [
            {
              name: 'unsupported_email_key',
              columns: ['email'],
              semanticCompleteness: 'unsupported',
              isValid: true,
            },
          ],
          foreignKeys: [desiredForeignKey()],
        }),
        postgresDialect,
      ),
    ).toThrow(/unsupported unique constraint catalog semantics/i)
  })

  it('fails closed for NOT VALID and deferrable foreign keys', () => {
    for (const foreignKey of [
      desiredForeignKey({
        semanticCompleteness: 'supportedSimple',
        isValid: false,
      }),
      desiredForeignKey({
        semanticCompleteness: 'unsupported',
        isValid: true,
      }),
    ]) {
      expect(() =>
        planMigration(
          [Parents, Children],
          relationCatalog({
            uniqueConstraints: [
              {
                name: 'legacy_email_key',
                columns: ['email'],
                ...supportedSimple,
              },
            ],
            foreignKeys: [foreignKey],
          }),
          postgresDialect,
        ),
      ).toThrow(/unsupported foreign key catalog semantics/i)
    }
  })

  it('adds missing declared constraints in additive mode and replans cleanly', () => {
    expect(
      planMigration([Parents, Children], relationCatalog(), postgresDialect, {
        migrationOwnership: additiveOwnership,
      }),
    ).toEqual({
      steps: [
        {
          kind: 'add_unique_constraint',
          schema: 'public',
          table: 'children',
          column: 'email',
        },
        {
          kind: 'add_foreign_key',
          schema: 'public',
          table: 'children',
          column: 'parentId',
          references: { schema: 'public', table: 'parents', column: 'id' },
        },
      ],
    })

    expect(
      planMigration(
        [Parents, Children],
        relationCatalog({
          uniqueConstraints: [
            {
              name: 'legacy_email_key',
              columns: ['email'],
              ...supportedSimple,
            },
          ],
          foreignKeys: [desiredForeignKey()],
        }),
        postgresDialect,
        { migrationOwnership: additiveOwnership },
      ),
    ).toEqual({ steps: [] })
  })

  it('preserves extra additive constraints and reports complete-mode removal limits', () => {
    const catalog = relationCatalog({
      extraColumns: true,
      uniqueConstraints: [
        { name: 'legacy_email_key', columns: ['email'], ...supportedSimple },
        { name: 'legacy_extra_key', columns: ['legacy'], ...supportedSimple },
      ],
      foreignKeys: [
        desiredForeignKey(),
        desiredForeignKey({ name: 'legacy_extra_fkey', columns: ['legacy'] }),
      ],
    })

    expect(
      planMigration([Parents, Children], catalog, postgresDialect, {
        migrationOwnership: additiveOwnership,
      }),
    ).toEqual({ steps: [] })
    expect(() => planMigration([Parents, Children], catalog, postgresDialect)).toThrow(
      /unsupported removal of extra (unique constraints|foreign keys)/i,
    )
  })

  it('reserves check and exclusion constraint names against generated constraints', () => {
    const identities = createCanonicalRelationIdentityModule({
      adapter: 'postgresql',
      context: namespaceContext,
    })
    const generated = generatedUniqueName(
      identities.resolve({ relation: 'children' }),
      'email',
      POSTGRES_PHYSICAL_NAMING,
    )
    const catalog = relationCatalog()
    catalog.constraintNameReservations = [
      { schema: 'public', table: 'children', name: generated },
    ]

    expect(() =>
      planMigration([Parents, Children], catalog, postgresDialect, {
        migrationOwnership: additiveOwnership,
      }),
    ).toThrow(/physical name collision/i)
  })
})
