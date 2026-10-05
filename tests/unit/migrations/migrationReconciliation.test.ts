import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { MigrationError, column, defineTable, postgresDialect, reference } from '@/index'
import type { TableHandle } from '@/types'
import { attemptSync } from '@/utils/error'

import type { PostgresCatalogSnapshotFixture as CatalogSnapshot } from '../helpers/catalog'
import {
  catalogPrimaryKey as createCatalogPrimaryKey,
  planMigration,
} from '../helpers/catalog'
import {
  columnTarget,
  indexTarget,
  namespaceTarget,
  relationTarget,
} from '../helpers/planTargets'

const managedCatalogData: CatalogSnapshot['tables'][number]['columns'] = [
  {
    name: 'id',
    dataType: 'integer',
    isNullable: false,
    defaultExpression: null,
    identityGeneration: 'byDefault',
  },
  {
    name: 'email',
    dataType: 'text',
    isNullable: false,
    defaultExpression: null,
    identityGeneration: null,
  },
  {
    name: 'status',
    dataType: 'text',
    isNullable: false,
    defaultExpression: "'pending'",
    identityGeneration: null,
  },
]

const POSTGRES_NAMESPACE_CONTEXT = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

/** Builds empty catalog reservations evidence for schema reconciliation checks. */
function emptyCatalogReservations() {
  return {
    nameReservations: [],
    constraintNameReservations: [],
  }
}

const SUPPORTED_CATALOG_SEMANTICS = {
  semanticCompleteness: 'supportedSimple' as const,
  isValid: true,
}

const catalogPrimaryKey = createCatalogPrimaryKey(SUPPORTED_CATALOG_SEMANTICS)

/** Builds empty catalog evidence for schema reconciliation checks. */
function emptyCatalog(): CatalogSnapshot {
  return {
    tables: [],
    namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
    ...emptyCatalogReservations(),
  }
}

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

const Settings = defineTable(
  'settings',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'integer' } })),
    label: string(),
    status: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'pending' } }),
    ),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

const ManagedUsers = defineTable(
  'managed_users',
  {
    id: pipe(
      string(),
      column({
        physicalType: { postgresql: 'integer' },
        generation: { kind: 'identity', mode: 'byDefault' },
      }),
    ),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' }, unique: true })),
    status: pipe(
      string(),
      column({
        physicalType: { postgresql: 'text' },
        databaseDefault: { kind: 'literal', value: 'pending' },
      }),
    ),
  },
  {
    primaryKey: 'id',
    namespace: [{ role: 'schema', spelling: 'public' }],
    indexes: [{ name: 'managed_users_status_idx', columns: ['status'] }],
  },
)

const ManagedPosts = defineTable(
  'managed_posts',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    userId: reference(ManagedUsers, 'id', {
      onDelete: 'cascade',
      onUpdate: 'restrict',
    }),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

/** Builds users catalog evidence for schema reconciliation checks. */
function usersCatalog(
  columns: CatalogSnapshot['tables'][number]['columns'],
): CatalogSnapshot {
  return {
    namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
    ...emptyCatalogReservations(),
    tables: [
      {
        schema: 'public',
        name: 'users',
        columns,
        primaryKey: {
          name: 'users_pkey',
          columns: ['id'],
          ...SUPPORTED_CATALOG_SEMANTICS,
        },
      },
    ],
  }
}

/** Builds managed catalog evidence for schema reconciliation checks. */
function managedCatalog(): CatalogSnapshot {
  return {
    namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
    ...emptyCatalogReservations(),
    tables: [
      createManagedUsersCatalog(),
      {
        schema: 'public',
        name: 'managed_posts',
        columns: [
          { name: 'id', dataType: 'uuid', isNullable: false },
          { name: 'userId', dataType: 'integer', isNullable: false },
        ],
        primaryKey: {
          name: 'managed_posts_pkey',
          columns: ['id'],
          ...SUPPORTED_CATALOG_SEMANTICS,
        },
        uniqueConstraints: [],
        foreignKeys: [
          {
            name: 'managed_posts_userId_fkey',
            columns: ['userId'],
            referencedSchema: 'public',
            referencedTable: 'managed_users',
            referencedColumns: ['id'],
            onDelete: 'cascade',
            onUpdate: 'restrict',
            ...SUPPORTED_CATALOG_SEMANTICS,
          },
        ],
      },
    ],
  }
}

/**
 * Captures the expected migration-planning error and fails if planning succeeds.
 *
 * @param schemas - Registered table handles defining the desired schema.
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 *
 * @returns The expected MigrationError; unexpected planning success fails the test.
 */
function planningError(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
): MigrationError {
  const result = attemptSync(() => planMigration(schemas, catalog, postgresDialect))

  if (result.ok) throw new Error('Expected migration planning to fail')

  expect(result.error).toBeInstanceOf(MigrationError)
  return result.error as MigrationError
}

/**
 * Builds a table handle with deliberately invalid schema metadata.
 *
 * @param name - Physical identifier or dialect label used by this operation.
 *
 * @returns A table handle with deliberately invalid schema metadata.
 */
function invalidTableHandle(name: string): TableHandle {
  return {
    /**
     * Returns the relation, primary-key, index, and ownership metadata attached to the
     * table.
     */
    getTableMetadata: () => ({ name, relation: { relation: name }, primaryKey: 'id' }),
    /** Returns the table's original Valibot schema for validation and metadata lookup. */
    getSchema: () => ({ entries: {} }),
  } as unknown as TableHandle
}

describe('Migration reconciliation', () => {
  it('returns no steps when the catalog matches the registered tables', () => {
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ])

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({ steps: [] })
  })

  it('uses PostgreSQL lowering and normalization for comparisons', () => {
    const catalog: CatalogSnapshot = {
      namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
      ...emptyCatalogReservations(),
      tables: [
        {
          schema: 'public',
          name: 'settings',
          columns: [
            { name: 'id', dataType: 'int4', isNullable: false },
            { name: 'label', dataType: 'text', isNullable: false },
            {
              name: 'status',
              dataType: 'text',
              isNullable: false,
              defaultExpression: "'pending'",
            },
          ],
          primaryKey: catalogPrimaryKey('settings'),
        },
      ],
    }

    expect(planMigration([Settings], catalog, postgresDialect)).toEqual({ steps: [] })
  })
})

describe('Migration reconciliation: matches a tagged literal that looks like a PostgreSQL expression', () => {
  it('matches a tagged literal that looks like a PostgreSQL expression', () => {
    const LiteralDefault = defineTable(
      'literal_defaults',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'integer' } })),
        value: pipe(
          string(),
          column({ databaseDefault: { kind: 'literal', value: 'now()' } }),
        ),
      },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )

    const catalog = {
      ...emptyCatalog(),
      tables: [
        {
          schema: 'public',
          name: 'literal_defaults',
          columns: [
            { name: 'id', dataType: 'integer', isNullable: false },
            {
              name: 'value',
              dataType: 'text',
              isNullable: false,
              defaultExpression: "'now()'",
            },
          ],
          primaryKey: catalogPrimaryKey('literal_defaults'),
        },
      ],
    }

    expect(planMigration([LiteralDefault], catalog, postgresDialect)).toEqual({
      steps: [],
    })
  })
})

describe('Migration reconciliation: returns a constructive step for a missing column', () => {
  it('returns a constructive step for a missing column', () => {
    const catalog = usersCatalog([{ name: 'id', dataType: 'uuid', isNullable: false }])

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({
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
})

describe('Migration reconciliation: returns every exact-relation destructive step without permission input', () => {
  it('returns every exact-relation destructive step without permission input', () => {
    const catalog: CatalogSnapshot = {
      namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
      ...emptyCatalogReservations(),
      tables: [
        {
          schema: 'public',
          name: 'users',
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false },
            { name: 'email', dataType: 'text', isNullable: false },
            { name: 'legacy', dataType: 'text', isNullable: true },
          ],
          indexes: [
            {
              name: 'users_stale_idx',
              columns: ['email'],
              unique: false,
              ...SUPPORTED_CATALOG_SEMANTICS,
            },
          ],
          primaryKey: catalogPrimaryKey('users'),
        },
        {
          schema: 'public',
          name: 'orphan',
          columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
          primaryKey: catalogPrimaryKey('orphan'),
        },
      ],
    }

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({
      steps: [
        { kind: 'drop_index', target: indexTarget('public', 'users', 'users_stale_idx') },
        { kind: 'drop_column', target: columnTarget('public', 'users', 'legacy') },
      ],
    })
  })
})

describe('Migration reconciliation identities and constraint order', () => {
  it('matches omitted and explicit relations against non-default catalog namespaces', () => {
    const Omitted = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Public = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const catalog: CatalogSnapshot = {
      ...emptyCatalogReservations(),
      namespaceContext: {
        writableDefault: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'tenant' },
        ],
      },
      tables: [
        {
          schema: 'tenant',
          name: 'items',
          columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
          primaryKey: catalogPrimaryKey('items'),
        },
        {
          schema: 'public',
          name: 'items',
          columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
          primaryKey: catalogPrimaryKey('items'),
        },
      ],
    }

    expect(planMigration([Omitted], catalog, postgresDialect)).toEqual({ steps: [] })
    expect(planMigration([Public], catalog, postgresDialect)).toEqual({ steps: [] })
  })
})

describe('Migration reconciliation identities and constraint order: matches dotted desired and catalog tuples without collisions', () => {
  it('matches dotted desired and catalog tuples without collisions', () => {
    const DottedSchema = defineTable(
      'c',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a.b' }] },
    )
    const DottedRelation = defineTable(
      'b.c',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a' }] },
    )
    const catalog: CatalogSnapshot = createDottedCatalog()

    expect(
      planMigration([DottedSchema, DottedRelation], catalog, postgresDialect),
    ).toEqual({
      steps: [],
    })

    const Anchor = defineTable(
      'anchor',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a' }] },
    )
    const mismatchedCatalog: CatalogSnapshot = {
      namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
      ...emptyCatalogReservations(),
      tables: [
        catalog.tables[1]!,
        {
          schema: 'a',
          name: 'anchor',
          columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
          primaryKey: catalogPrimaryKey('anchor'),
        },
      ],
    }

    expect(
      planMigration([DottedSchema, Anchor], mismatchedCatalog, postgresDialect),
    ).toEqual({
      steps: [
        { kind: 'ensure_namespace', target: namespaceTarget('a.b') },
        { kind: 'create_table', target: relationTarget('a.b', 'c') },
      ],
    })
  })
})

describe('Migration reconciliation identities and constraint order: matches dotted desired and catalog tuples without collisions: formats relation members structurally in planning diagnostics', () => {
  it('formats relation members structurally in planning diagnostics', () => {
    const Dotted = defineTable(
      'c',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a.b' }] },
    )
    const catalog: CatalogSnapshot = {
      namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
      ...emptyCatalogReservations(),
      tables: [
        {
          schema: 'a.b',
          name: 'c',
          columns: [
            { name: 'id', dataType: 'uuid', isNullable: false },
            { name: 'x.y', dataType: 'text', isNullable: true },
            { name: 'x.y', dataType: 'text', isNullable: true },
          ],
          primaryKey: catalogPrimaryKey('c'),
        },
      ],
    }

    expect(planningError([Dotted], catalog).message).toBe(
      'Duplicate catalog column [database:"test", schema:"a.b", relation:"c", column:"x.y"]',
    )
  })
})

describe('Migration reconciliation constraint ordering', () => {
  it('ignores non-semantic constraint order but preserves ordered key sequences', () => {
    const Teams = createTeamsTable()
    const Memberships = defineTable(
      'memberships',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        primaryTeamId: reference(Teams, 'teamId'),
        secondaryTeamId: reference(Teams, 'teamId'),
        primaryEmail: pipe(
          string(),
          column({ physicalType: { postgresql: 'text' }, unique: true }),
        ),
        secondaryEmail: pipe(
          string(),
          column({ physicalType: { postgresql: 'text' }, unique: true }),
        ),
      },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const catalog: CatalogSnapshot = createOrderingCatalog()
    const permuted = structuredClone(catalog)
    permuted.tables.reverse()
    permuted.tables[0]!.columns.reverse()
    permuted.tables[0]!.uniqueConstraints!.reverse()
    permuted.tables[0]!.foreignKeys!.reverse()

    expect(planMigration([Memberships, Teams], catalog, postgresDialect)).toEqual({
      steps: [],
    })

    expect(planMigration([Teams, Memberships], permuted, postgresDialect)).toEqual({
      steps: [],
    })

    const reversedKey = structuredClone(catalog)
    reversedKey.tables[0]!.primaryKey!.columns.reverse()

    expect(() =>
      planMigration([Memberships, Teams], reversedKey, postgresDialect),
    ).toThrow(/primary key change/i)
  })
})

describe('Migration reconciliation diagnostics', () => {
  it('throws for unsupported drift', () => {
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ])
    catalog.tables[0]!.primaryKey = {
      name: 'users_pkey',
      columns: ['email'],
      ...SUPPORTED_CATALOG_SEMANTICS,
    }

    expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(MigrationError)

    expect(() => planMigration([Users], catalog, postgresDialect)).toThrow(
      /unsupported primary key change/i,
    )
  })
})

describe('Migration reconciliation diagnostics: directly rejects unsupported %s drift', () => {
  it.each([
    [
      'default',
      (catalog: CatalogSnapshot) => {
        catalog.tables[0]!.columns[2]!.defaultExpression = "'disabled'"
      },
    ],
    [
      'identity',
      (catalog: CatalogSnapshot) => {
        catalog.tables[0]!.columns[0]!.identityGeneration = 'always'
      },
    ],
    [
      'primary key',
      (catalog: CatalogSnapshot) => {
        catalog.tables[0]!.primaryKey!.columns = ['email']
      },
    ],
    [
      'unique constraint',
      (catalog: CatalogSnapshot) => {
        catalog.tables[0]!.uniqueConstraints!.push({
          name: 'managed_users_status_key',
          columns: ['status'],
          ...SUPPORTED_CATALOG_SEMANTICS,
        })
      },
    ],
    [
      'foreign key',
      (catalog: CatalogSnapshot) => {
        catalog.tables[1]!.foreignKeys![0]!.onDelete = 'restrict'
      },
    ],
    [
      'index definition',
      (catalog: CatalogSnapshot) => {
        catalog.tables[0]!.indexes![0]!.columns = ['email']
      },
    ],
  ] as const)('directly rejects unsupported %s drift', (property, mutate) => {
    const catalog = managedCatalog()
    mutate(catalog)

    const error = planningError([ManagedUsers, ManagedPosts], catalog)
    expect(error.message).toMatch(new RegExp(property, 'i'))
  })
})

describe('Migration reconciliation diagnostics: selects issues by canonical target before property', () => {
  it('selects issues by canonical target before property', () => {
    const catalog = managedCatalog()
    catalog.tables[0]!.primaryKey!.columns = ['email']
    catalog.tables[1]!.foreignKeys![0]!.onDelete = 'restrict'

    const permuted = structuredClone(catalog)
    permuted.tables.reverse()

    for (const table of permuted.tables) {
      table.columns.reverse()
      table.uniqueConstraints?.reverse()
      table.foreignKeys?.reverse()
      table.indexes?.reverse()
    }

    const first = planningError([ManagedUsers, ManagedPosts], catalog)
    const second = planningError([ManagedPosts, ManagedUsers], permuted)

    expect(first.message).toBe(second.message)
    expect(first.message).toMatch(/foreign key.*managed_posts/i)
  })
})

describe('Migration reconciliation diagnostics: uses fixed property order for issues on the same target', () => {
  it('uses fixed property order for issues on the same target', () => {
    const catalog = managedCatalog()
    const users = catalog.tables[0]!
    users.primaryKey!.columns = ['email']
    users.uniqueConstraints = []
    users.foreignKeys = [
      {
        referencedSchema: 'public',
        name: 'unexpected_fkey',
        columns: ['email'],
        referencedTable: 'managed_posts',
        referencedColumns: ['id'],
        onDelete: 'no action',
        onUpdate: 'no action',
        ...SUPPORTED_CATALOG_SEMANTICS,
      },
    ]

    const error = planningError([ManagedUsers], catalog)
    expect(error.message).toMatch(/primary key.*managed_users/i)
  })
})

describe('Migration reconciliation diagnostics: selects the same column issue across desired-property and catalog permutations', () => {
  it('selects the same column issue across desired-property and catalog permutations', () => {
    const Forward = createForwardTable()
    const Reversed = createReversedTable()
    const catalog: CatalogSnapshot = {
      namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
      ...emptyCatalogReservations(),
      tables: [
        {
          schema: 'public',
          name: 'ordered_settings',
          columns: [
            {
              name: 'zeta',
              dataType: 'text',
              isNullable: false,
              defaultExpression: "'x'",
            },
            { name: 'id', dataType: 'uuid', isNullable: false },
            {
              name: 'alpha',
              dataType: 'text',
              isNullable: false,
              defaultExpression: "'x'",
            },
          ],
          primaryKey: catalogPrimaryKey('ordered_settings'),
        },
      ],
    }
    const permuted = structuredClone(catalog)
    permuted.tables[0]!.columns.reverse()

    const first = planningError([Forward], catalog)
    const second = planningError([Reversed], permuted)

    expect(first.message).toBe(second.message)
    expect(first.message).toMatch(/alpha/i)
  })
})

describe('Migration reconciliation invalid inputs and ownership', () => {
  it('rejects invalid desired and catalog inputs deterministically', () => {
    const alpha = invalidTableHandle('alpha')
    const zeta = invalidTableHandle('zeta')

    const firstDesired = planningError([zeta, alpha], emptyCatalog())
    const secondDesired = planningError([alpha, zeta], emptyCatalog())
    expect(firstDesired.message).toBe(secondDesired.message)
    expect(firstDesired.message).toMatch(/alpha/i)

    const duplicateCatalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ])
    duplicateCatalog.tables.push(structuredClone(duplicateCatalog.tables[0]!))
    duplicateCatalog.tables[1]!.columns = duplicateCatalog.tables[1]!.columns.slice(0, 1)
    const reversedCatalog = structuredClone(duplicateCatalog)
    reversedCatalog.tables.reverse()

    expect(planningError([Users], duplicateCatalog).message).toBe(
      planningError([Users], reversedCatalog).message,
    )
  })

  it('considers invalid issues from every duplicate registered handle', () => {
    const invalidUsers = invalidTableHandle('users')

    const validFirst = planningError([Users, invalidUsers], emptyCatalog())
    const invalidFirst = planningError([invalidUsers, Users], emptyCatalog())

    expect(validFirst.message).toBe(invalidFirst.message)
    expect(validFirst.message).toMatch(/no columns/i)
  })
})

describe('Migration reconciliation invalid inputs and ownership: breaks otherwise identical issue ties deterministically', () => {
  it('breaks otherwise identical issue ties deterministically', () => {
    const missingPrimaryKey = {
      /**
       * Returns the relation, primary-key, index, and ownership metadata attached to the
       * table.
       */
      getTableMetadata: () => ({
        name: 'users',
        relation: { relation: 'users' },
        primaryKey: '',
      }),
      /** Returns the table's original Valibot schema for validation and metadata lookup. */
      getSchema: () => ({ entries: {} }),
    } as unknown as TableHandle
    const noColumns = invalidTableHandle('users')

    const first = planningError([missingPrimaryKey, noColumns], emptyCatalog())
    const second = planningError([noColumns, missingPrimaryKey], emptyCatalog())

    expect(first.message).toBe(second.message)
  })

  it('throws instead of exposing constructive steps alongside an issue', () => {
    const catalog = managedCatalog()
    catalog.tables[0]!.columns = catalog.tables[0]!.columns.filter(
      (column) => column.name !== 'email',
    )
    catalog.tables[1]!.foreignKeys![0]!.onDelete = 'restrict'

    expect(() =>
      planMigration([ManagedUsers, ManagedPosts], catalog, postgresDialect),
    ).toThrow(MigrationError)
  })

  it('names the owning relation when a catalog member cannot be addressed', () => {
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
      { name: '', dataType: 'text', isNullable: true },
    ])

    expect(planningError([Users], catalog).message).toMatch(
      /Cannot address column "" of \[database:"test", schema:"public", relation:"users"\]/,
    )
  })
})

describe('Migration reconciliation invalid inputs and ownership: accepts one physical name reported under several catalog relations', () => {
  it('accepts one physical name reported under several catalog relations', () => {
    const catalog = usersCatalog([{ name: 'id', dataType: 'uuid', isNullable: false }])
    catalog.tables[0]!.indexes = [
      {
        name: 'shared_idx',
        columns: ['id'],
        unique: false,
        ...SUPPORTED_CATALOG_SEMANTICS,
      },
    ]

    catalog.tables.push({
      schema: 'public',
      name: 'partition',
      columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
      indexes: [
        {
          name: 'shared_idx',
          columns: ['id'],
          unique: false,
          ...SUPPORTED_CATALOG_SEMANTICS,
        },
      ],
      primaryKey: catalogPrimaryKey('partition'),
    })

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({
      steps: [
        {
          kind: 'add_column',
          target: columnTarget('public', 'users', 'email'),
          dataType: 'text',
          notNull: true,
        },
        { kind: 'drop_index', target: indexTarget('public', 'users', 'shared_idx') },
      ],
    })
  })
})

describe('Migration reconciliation invalid inputs and ownership: accepts one physical name reported under several catalog relations: scopes reserved catalog names to their own namespace', () => {
  it('scopes reserved catalog names to their own namespace', () => {
    const TenantUsers = defineTable(
      'users',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'other_app' }] },
    )
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ])
    catalog.namespaces = ['other_app']

    // An unrelated object named 'users' occupies the other namespace, not this one.
    catalog.nameReservations = [{ schema: 'other_app', name: 'users' }]

    expect(planningError([Users, TenantUsers], catalog).message).toMatch(
      /physical name collision for "users"/i,
    )
  })
})

describe('Migration reconciliation invalid inputs and ownership: does not infer namespace ownership from registered handles', () => {
  it('does not infer namespace ownership from registered handles', () => {
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ])
    catalog.tables.push(
      {
        schema: 'public',
        name: 'orphan',
        columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
        primaryKey: catalogPrimaryKey('orphan'),
      },
      {
        schema: 'other_app',
        name: 'secrets',
        columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
        primaryKey: catalogPrimaryKey('secrets'),
      },
    )

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({ steps: [] })
  })
})

/** Creates the dotted catalog fixture used by the contract scenario. */
function createDottedCatalog(): CatalogSnapshot {
  return {
    namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
    ...emptyCatalogReservations(),
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
}

/**
 * Builds a fresh reversed table handle for the schema scenario.
 *
 * @returns A fresh reversed table handle for the schema scenario.
 */
function createReversedTable() {
  return defineTable(
    'ordered_settings',
    {
      zeta: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: 'zeta' },
        }),
      ),
      alpha: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: 'alpha' },
        }),
      ),
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh forward table handle for the schema scenario.
 *
 * @returns A fresh forward table handle for the schema scenario.
 */
function createForwardTable() {
  return defineTable(
    'ordered_settings',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      alpha: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: 'alpha' },
        }),
      ),
      zeta: pipe(
        string(),
        column({
          physicalType: { postgresql: 'text' },
          databaseDefault: { kind: 'literal', value: 'zeta' },
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh teams table handle for the schema scenario.
 *
 * @returns A fresh teams table handle for the schema scenario.
 */
function createTeamsTable() {
  return defineTable(
    'teams',
    {
      tenantId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      teamId: pipe(
        string(),
        column({ physicalType: { postgresql: 'uuid' }, unique: true }),
      ),
    },
    {
      primaryKey: ['tenantId', 'teamId'],
      namespace: [{ role: 'schema', spelling: 'public' }],
    },
  )
}

/** Creates the ordering catalog fixture used by the contract scenario. */
function createOrderingCatalog(): CatalogSnapshot {
  return {
    namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
    ...emptyCatalogReservations(),
    tables: [
      {
        schema: 'public',
        name: 'teams',
        columns: [
          { name: 'teamId', dataType: 'uuid', isNullable: false },
          { name: 'tenantId', dataType: 'uuid', isNullable: false },
        ],
        primaryKey: {
          name: 'teams_pkey',
          columns: ['tenantId', 'teamId'],
          ...SUPPORTED_CATALOG_SEMANTICS,
        },
        uniqueConstraints: [
          {
            name: 'teams_team_id_key',
            columns: ['teamId'],
            ...SUPPORTED_CATALOG_SEMANTICS,
          },
        ],
      },
      createMembershipsCatalog(),
    ],
  }
}

/** Creates the managed users catalog fixture used by the contract scenario. */
function createManagedUsersCatalog(): CatalogSnapshot['tables'][number] {
  return {
    schema: 'public',
    name: 'managed_users',
    columns: structuredClone(managedCatalogData),
    indexes: [
      {
        name: 'managed_users_status_idx',
        columns: ['status'],
        unique: false,
        ...SUPPORTED_CATALOG_SEMANTICS,
      },
    ],
    primaryKey: {
      name: 'managed_users_pkey',
      columns: ['id'],
      ...SUPPORTED_CATALOG_SEMANTICS,
    },
    uniqueConstraints: [
      {
        name: 'managed_users_email_key',
        columns: ['email'],
        ...SUPPORTED_CATALOG_SEMANTICS,
      },
    ],
    foreignKeys: [],
  }
}

/** Creates the memberships catalog fixture used by the contract scenario. */
function createMembershipsCatalog(): CatalogSnapshot['tables'][number] {
  return {
    schema: 'public',
    name: 'memberships',
    columns: [
      { name: 'secondaryEmail', dataType: 'text', isNullable: false },
      { name: 'primaryTeamId', dataType: 'uuid', isNullable: false },
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'secondaryTeamId', dataType: 'uuid', isNullable: false },
      { name: 'primaryEmail', dataType: 'text', isNullable: false },
    ],
    primaryKey: catalogPrimaryKey('memberships'),
    uniqueConstraints: [
      {
        name: 'memberships_secondary_email_key',
        columns: ['secondaryEmail'],
        ...SUPPORTED_CATALOG_SEMANTICS,
      },
      {
        name: 'memberships_primary_email_key',
        columns: ['primaryEmail'],
        ...SUPPORTED_CATALOG_SEMANTICS,
      },
    ],
    foreignKeys: [
      {
        name: 'memberships_secondary_team_fkey',
        columns: ['secondaryTeamId'],
        referencedSchema: 'public',
        referencedTable: 'teams',
        referencedColumns: ['teamId'],
        onDelete: 'no action',
        onUpdate: 'no action',
        ...SUPPORTED_CATALOG_SEMANTICS,
      },
      {
        name: 'memberships_primary_team_fkey',
        columns: ['primaryTeamId'],
        referencedSchema: 'public',
        referencedTable: 'teams',
        referencedColumns: ['teamId'],
        onDelete: 'no action',
        onUpdate: 'no action',
        ...SUPPORTED_CATALOG_SEMANTICS,
      },
    ],
  }
}
