import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { POSTGRES_IDENTITY_POLICY } from '@/dialects/postgres/identity'
import { POSTGRES_PHYSICAL_NAMING } from '@/dialects/postgres/naming'
import { column, defineTable, postgresDialect, reference } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { generatedUniqueName } from '@/migrations/physicalNaming'

import type {
  PostgresCatalogForeignKeyFixture as CatalogForeignKey,
  PostgresCatalogSnapshotFixture as CatalogSnapshot,
} from '../dialects/postgresCatalogFixtures'
import {
  postgresCatalogPrimaryKey as createCatalogPrimaryKey,
  planPostgresMigration as planMigration,
} from '../dialects/postgresCatalogFixtures'
import { columnReference, columnTarget } from '../helpers/planTargets'

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
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    payload: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id', indexes: [{ columns: ['payload'] }] },
)

const UniqueIndexedEvents = defineTable(
  'indexed_events',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    payload: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id', indexes: [{ columns: ['payload'], unique: true }] },
)

/** Builds indexed catalog evidence for schema reconciliation checks. */
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
  { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
  { primaryKey: 'id' },
)

const Children = defineTable(
  'children',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    parentId: reference(Parents, 'id'),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' }, unique: true })),
  },
  { primaryKey: 'id' },
)

/** Builds supported foreign-key evidence with configurable native differences. */
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

/** Builds relation catalog evidence for schema reconciliation checks. */
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
  it('should reject unsupported semantics and plan creation for known invalid matches', () => {
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

    expect(
      planMigration(
        [IndexedEvents],
        indexedCatalog({ semanticCompleteness: 'supportedSimple', isValid: false }),
        postgresDialect,
      ).steps,
    ).toEqual([expect.objectContaining({ kind: 'create_index' })])
  })
})

describe('catalog semantic adoption: rejects unsupported standalone indexes and unique constraints', () => {
  it('should reject unsupported standalone indexes and unique constraints', () => {
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
})

describe('catalog semantic adoption: fails closed for NOT VALID and deferrable foreign keys', () => {
  it('should fail closed for NOT VALID and deferrable foreign keys', () => {
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
})

describe('catalog semantic adoption: adds missing declared constraints in additive mode and replans cleanly', () => {
  it('should add missing declared constraints in additive mode and replan cleanly', () => {
    expect(
      planMigration([Parents, Children], relationCatalog(), postgresDialect, {
        migrationOwnership: additiveOwnership,
      }),
    ).toEqual({
      steps: [
        {
          kind: 'add_unique_constraint',
          target: columnTarget('public', 'children', 'email'),
        },
        {
          kind: 'add_foreign_key',
          target: columnTarget('public', 'children', 'parentId'),
          references: columnReference('public', 'parents', 'id'),
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
})

describe('catalog semantic adoption: preserves additive constraints and removes authorized source columns', () => {
  it('should preserve additive constraints and remove constraints with their authorized source columns', () => {
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

    expect(planMigration([Parents, Children], catalog, postgresDialect)).toEqual({
      steps: [
        { kind: 'drop_column', target: columnTarget('public', 'children', 'legacy') },
      ],
    })
  })
})

describe('catalog semantic adoption: reserves check and exclusion constraint names against generated constraints', () => {
  it('should reserve check and exclusion constraint names against generated constraints', () => {
    const identities = createCanonicalRelationIdentityModule({
      policy: POSTGRES_IDENTITY_POLICY,
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

it('should keep unrelated invalid indexes guarded instead of inferring ownership from a name', () => {
  expect(() =>
    planMigration(
      [IndexedEvents],
      indexedCatalog({ isValid: false, columns: ['id'] }),
      postgresDialect,
    ),
  ).toThrow(/unmatched invalid index/i)
})

it('should reject conflicting definitions even when an authored index name matches invalid storage', () => {
  const Explicit = defineTable(
    'indexed_events',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      payload: string(),
    },
    { primaryKey: 'id', indexes: [{ name: 'legacy_payload_idx', columns: ['payload'] }] },
  )

  expect(() =>
    planMigration(
      [Explicit],
      indexedCatalog({ isValid: false, columns: ['id'] }),
      postgresDialect,
    ),
  ).toThrow(/index definition change/i)
})

it('should reject ambiguous invalid semantic matches', () => {
  const catalog = indexedCatalog({ isValid: false })
  catalog.tables[0].indexes?.push({
    name: 'second_invalid',
    columns: ['payload'],
    unique: false,
    ...supportedSimple,
    isValid: false,
  })

  expect(() => planMigration([IndexedEvents], catalog, postgresDialect)).toThrow(
    /ambiguous index semantic match/i,
  )
})

it('should reserve the generated replacement name before planning invalid-index cleanup', () => {
  const catalog = indexedCatalog({ isValid: false })
  const step = planMigration([IndexedEvents], catalog, postgresDialect).steps[0]

  if (step.kind !== 'create_index') throw new Error('Expected index creation intent')

  expect(step.target.index.spelling).not.toBe('legacy_payload_idx')

  catalog.nameReservations.push({
    schema: 'public',
    name: step.target.index.spelling,
  })

  expect(() => planMigration([IndexedEvents], catalog, postgresDialect)).toThrow(
    /physical name collision/i,
  )
})
