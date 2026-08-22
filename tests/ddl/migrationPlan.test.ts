import { nullable, pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { planMigration as planMigrationWithContext } from '@/ddl/migrationPlan'
import type { AuthoredDesiredSchema, Dialect } from '@/dialects'
import {
  MigrationError,
  column,
  defineTable,
  isSqlNullable,
  postgresDialect,
  reference,
} from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type {
  CanonicalRelationIdentityModule,
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import {
  POSTGRES_PHYSICAL_NAMING,
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import type { TableHandle } from '@/types'

import type { PostgresCatalogSnapshotFixture as CatalogSnapshot } from '../helpers/catalog'
import {
  completePostgresCatalog,
  catalogPrimaryKey as createCatalogPrimaryKey,
  planMigration,
} from '../helpers/catalog'
import {
  columnIdentifiers,
  columnReference,
  columnTarget,
  indexTarget,
  namespaceTarget,
  relationTarget,
} from '../helpers/planTargets'

const POSTGRES_NAMESPACE_CONTEXT = {
  writableDefault: [
    { role: 'database' as const, spelling: 'test' },
    { role: 'schema' as const, spelling: 'public' },
  ],
}

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
  { primaryKey: 'id', schema: 'public' },
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
  { primaryKey: 'id', schema: 'public' },
)

const Accounts = defineTable(
  'accounts',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    addedReference: reference(Users, 'id'),
    addedText: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    changedType: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    madeNullable: nullable(
      pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    ),
    madeRequired: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    indexSecond: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    indexFirst: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  {
    primaryKey: 'id',
    indexes: [
      {
        name: 'accounts_ordered_idx',
        columns: ['indexSecond', 'indexFirst'],
      },
    ],
  },
)

const Comments = defineTable(
  'comments',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
    userId: reference(Users, 'id'),
  },
  { primaryKey: 'id' },
)

const AuditEvents = defineTable(
  'events',
  { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
  { primaryKey: 'id', schema: 'audit' },
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
    schema: 'public',
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
  { primaryKey: 'id', schema: 'public' },
)

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

function rotate<T>(values: readonly T[]): T[] {
  return values.length < 2 ? [...values] : [...values.slice(1), values[0]!]
}

function mixedCatalog(): CatalogSnapshot {
  return {
    namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
    ...emptyCatalogReservations(),
    tables: [
      {
        schema: 'public',
        name: 'users',
        columns: [
          { name: 'email', dataType: 'text', isNullable: false },
          { name: 'id', dataType: 'uuid', isNullable: false },
        ],
        primaryKey: catalogPrimaryKey('users'),
      },
      {
        schema: 'public',
        name: 'accounts',
        columns: [
          { name: 'removedZ', dataType: 'text', isNullable: true },
          { name: 'indexFirst', dataType: 'text', isNullable: false },
          { name: 'madeRequired', dataType: 'text', isNullable: true },
          { name: 'id', dataType: 'uuid', isNullable: false },
          { name: 'changedType', dataType: 'integer', isNullable: false },
          { name: 'madeNullable', dataType: 'text', isNullable: false },
          { name: 'indexSecond', dataType: 'text', isNullable: false },
          { name: 'removedA', dataType: 'text', isNullable: true },
        ],
        indexes: [
          {
            name: 'stale_z_idx',
            columns: ['removedZ'],
            unique: false,
            ...SUPPORTED_CATALOG_SEMANTICS,
          },
          {
            name: 'stale_a_idx',
            columns: ['removedA'],
            unique: false,
            ...SUPPORTED_CATALOG_SEMANTICS,
          },
        ],
        primaryKey: catalogPrimaryKey('accounts'),
      },
      {
        schema: 'public',
        name: 'z_orphan',
        columns: [
          { name: 'child', dataType: 'text', isNullable: true },
          { name: 'id', dataType: 'uuid', isNullable: false },
        ],
        indexes: [
          {
            name: 'orphan_child_idx',
            columns: ['child'],
            unique: false,
            ...SUPPORTED_CATALOG_SEMANTICS,
          },
        ],
        primaryKey: catalogPrimaryKey('z_orphan'),
      },
      {
        schema: 'public',
        name: 'a_orphan',
        columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
        primaryKey: catalogPrimaryKey('a_orphan'),
      },
    ],
  }
}

function managedCatalog(): CatalogSnapshot {
  return {
    namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
    ...emptyCatalogReservations(),
    tables: [
      {
        schema: 'public',
        name: 'managed_users',
        columns: [
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
        ],
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
      },
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

function planningError(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
): MigrationError {
  try {
    planMigration(schemas, catalog, postgresDialect)
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError)
    return error as MigrationError
  }

  throw new Error('Expected migration planning to fail')
}

function invalidTableHandle(name: string): TableHandle {
  return {
    getTableMetadata: () => ({ name, relation: { relation: name }, primaryKey: 'id' }),
    getSchema: () => ({ entries: {} }),
  } as unknown as TableHandle
}

describe('Migration Plan construction', () => {
  it('returns no steps when the catalog matches the registered tables', () => {
    const catalog = usersCatalog([
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'email', dataType: 'text', isNullable: false },
    ])

    expect(planMigration([Users], catalog, postgresDialect)).toEqual({ steps: [] })
  })

  it('plans authored namespace intent from table metadata', () => {
    const Scoped = defineTable(
      'scoped_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      {
        primaryKey: 'id',
        namespace: [{ role: 'schema', spelling: 'audit' }],
      },
    )

    expect(planMigration([Scoped], emptyCatalog(), postgresDialect)).toEqual({
      steps: [
        { kind: 'ensure_namespace', target: namespaceTarget('audit') },
        {
          kind: 'create_table',
          target: relationTarget('audit', 'scoped_events'),
        },
      ],
    })
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

  it('uses the supplied dialect without introspection or compilation', () => {
    const PortableSettings = defineTable(
      'portable_settings',
      {
        id: string(),
        status: pipe(
          string(),
          column({ databaseDefault: { kind: 'literal', value: 'ready' } }),
        ),
        taggedStatus: string(),
      },
      { primaryKey: 'id' },
    )
    const introspect = vi.fn(async (_executor, request) =>
      completePostgresCatalog(emptyCatalog(), request),
    )
    const compile = vi.fn(() => ({ sql: '', params: [] }))
    const identityModules: CanonicalRelationIdentityModule[] = []
    const identity = {
      id: 'custom-identity',
      create: vi.fn(
        (options: {
          context: NamespaceContext
          registrationDefault?: readonly NamespaceIdentifierInput[]
        }) => {
          const identities = createCanonicalRelationIdentityModule({
            adapter: 'postgresql',
            ...options,
          })
          identityModules.push(identities)
          return identities
        },
      ),
    }
    const naming = {
      generate: vi.fn((seed: Parameters<typeof generatePhysicalName>[0]) =>
        generatePhysicalName(seed, POSTGRES_PHYSICAL_NAMING),
      ),
      validate: vi.fn((name: string, description: string) =>
        validatePhysicalName(name, description, POSTGRES_PHYSICAL_NAMING),
      ),
      createRegistry: vi.fn(() => createPhysicalNameRegistry(POSTGRES_PHYSICAL_NAMING)),
    }
    const lowerDesiredSchema = (graph: AuthoredDesiredSchema) => ({
      tables: graph.tables.map((table) => ({
        handle: table.handle,
        identity: table.identity,
        ast: {
          kind: 'create_table' as const,
          table: table.metadata.name,
          ...(table.identity.namespace.find((segment) => segment.role === 'schema') ===
          undefined
            ? {}
            : {
                schema: table.identity.namespace.find(
                  (segment) => segment.role === 'schema',
                )!.identifier.spelling,
              }),
          columns: table.columns.map((column) => ({
            name: column.name,
            dataType: 'custom_string',
            notNull: !isSqlNullable(column.schema),
            unique: column.metadata?.unique ?? false,
            autoIncrement: false,
            ...(column.metadata?.databaseDefault === undefined
              ? {}
              : {
                  databaseDefault: {
                    sql: `custom_database:${String(
                      column.metadata.databaseDefault.kind === 'literal'
                        ? column.metadata.databaseDefault.value
                        : column.metadata.databaseDefault.expression,
                    )}`,
                    normalized: `custom_database:${String(
                      column.metadata.databaseDefault.kind === 'literal'
                        ? column.metadata.databaseDefault.value
                        : column.metadata.databaseDefault.expression,
                    )}`,
                  },
                }),
            ...(column.name === 'taggedStatus'
              ? {
                  defaultValue: 'legacy',
                  databaseDefault: {
                    sql: 'custom_database:ready',
                    normalized: 'custom_database:ready',
                  },
                }
              : {}),
          })),
          primaryKey: Array.isArray(table.metadata.primaryKey)
            ? table.metadata.primaryKey
            : [table.metadata.primaryKey],
        },
      })),
    })
    const inferColumnType = () => 'custom_string'
    const normalizeDataType = (dataType: string) =>
      dataType === 'custom_string_alias' ? 'custom_string' : dataType
    const normalizeDefaultValue = (value: string | number | boolean | null) =>
      `custom_default:${String(value)}`
    const dialect: Dialect = {
      id: 'mysql',
      identity,
      naming,
      schema: {
        lowerDesiredSchema,
        inferColumnType,
        normalizeDataType,
        normalizeDefaultValue,
      },
      query: { compile },
      operations: {
        createSessionProvider: () => {
          throw new Error('fake migration-planning operations are outside this contract')
        },
      },
      migration: {
        lower: () => {
          throw new Error('fake migration lowering is outside this contract')
        },
        execute: async () => {
          throw new Error('fake migration execution is outside this contract')
        },
      },
      relationIdentity: 'postgresql',
      catalog: { introspectCatalog: introspect },
      lowerDesiredSchema,
      inferColumnType,
      normalizeDataType,
      normalizeDefaultValue,
      compile,
    }
    const catalog: CatalogSnapshot = {
      namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
      ...emptyCatalogReservations(),
      tables: [
        {
          schema: 'public',
          name: 'portable_settings',
          columns: [
            { name: 'id', dataType: 'custom_string_alias', isNullable: false },
            {
              name: 'status',
              dataType: 'custom_string_alias',
              isNullable: false,
              defaultExpression: 'custom_database:ready',
            },
            {
              name: 'taggedStatus',
              dataType: 'custom_string_alias',
              isNullable: false,
              defaultExpression: 'custom_database:ready',
            },
          ],
          primaryKey: {
            name: 'portable_settings_pkey',
            columns: ['id'],
            ...SUPPORTED_CATALOG_SEMANTICS,
          },
        },
      ],
    }

    expect(planMigration([PortableSettings], catalog, dialect)).toEqual({ steps: [] })
    expect(introspect).not.toHaveBeenCalled()
    expect(compile).not.toHaveBeenCalled()

    const planned = planMigrationWithContext(
      [PortableSettings],
      completePostgresCatalog(
        emptyCatalog(),
        createCatalogRequest([PortableSettings], []),
      ),
      dialect,
    )
    expect(planned.profile.identityAdapter).toBe('custom-identity')
    expect(identity.create).toHaveBeenCalled()
    expect(
      identityModules[0]!.resolve({ relation: 'portable_settings' }).namespace,
    ).toEqual(
      identityModules[0]!.resolve({
        namespace: [{ role: 'schema', spelling: 'public' }],
        relation: 'portable_settings',
      }).namespace,
    )
    expect(naming.generate).toHaveBeenCalled()
    expect(naming.validate).toHaveBeenCalled()
    expect(naming.createRegistry).toHaveBeenCalled()
  })

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

  it('covers every supported step kind in canonical phase and target order', () => {
    expect(
      planMigration(
        [Comments, Users, AuditEvents, Accounts],
        mixedCatalog(),
        postgresDialect,
        {
          migrationOwnership: [
            {
              kind: 'completeNamespace',
              namespace: [{ role: 'schema', spelling: 'public' }],
            },
          ],
        },
      ),
    ).toEqual({
      steps: [
        { kind: 'ensure_namespace', target: namespaceTarget('audit') },
        { kind: 'create_table', target: relationTarget('audit', 'events') },
        { kind: 'create_table', target: relationTarget('public', 'comments') },
        {
          kind: 'add_column',
          target: columnTarget('public', 'accounts', 'addedReference'),
          dataType: 'uuid',
          notNull: true,
        },
        {
          kind: 'add_column',
          target: columnTarget('public', 'accounts', 'addedText'),
          dataType: 'text',
          notNull: true,
        },
        {
          kind: 'alter_column_type',
          target: columnTarget('public', 'accounts', 'changedType'),
          dataType: 'text',
        },
        {
          kind: 'drop_not_null',
          target: columnTarget('public', 'accounts', 'madeNullable'),
        },
        {
          kind: 'set_not_null',
          target: columnTarget('public', 'accounts', 'madeRequired'),
        },
        {
          kind: 'create_index',
          target: indexTarget('public', 'accounts', 'accounts_ordered_idx'),
          columns: columnIdentifiers('indexSecond', 'indexFirst'),
          unique: false,
        },
        {
          kind: 'add_foreign_key',
          target: columnTarget('public', 'accounts', 'addedReference'),
          references: columnReference('public', 'users', 'id'),
        },
        {
          kind: 'add_foreign_key',
          target: columnTarget('public', 'comments', 'userId'),
          references: columnReference('public', 'users', 'id'),
        },
        {
          kind: 'drop_index',
          target: indexTarget('public', 'accounts', 'stale_a_idx'),
        },
        {
          kind: 'drop_index',
          target: indexTarget('public', 'accounts', 'stale_z_idx'),
        },
        { kind: 'drop_column', target: columnTarget('public', 'accounts', 'removedA') },
        { kind: 'drop_column', target: columnTarget('public', 'accounts', 'removedZ') },
        { kind: 'drop_table', target: relationTarget('public', 'a_orphan') },
        { kind: 'drop_table', target: relationTarget('public', 'z_orphan') },
      ],
    })
  })

  it('uses locale-independent code-unit target ordering', () => {
    const Lowercase = defineTable(
      'alpha',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Uppercase = defineTable(
      'Zulu',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )

    expect(
      planMigration([Lowercase, Uppercase], emptyCatalog(), postgresDialect),
    ).toEqual({
      steps: [
        { kind: 'create_table', target: relationTarget('public', 'Zulu') },
        { kind: 'create_table', target: relationTarget('public', 'alpha') },
      ],
    })
  })

  it('produces equal Migration Plans for omitted and explicit resolved defaults', () => {
    const Omitted = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Public = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'public' },
    )
    const Tenant = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'tenant' },
    )
    const tenantCatalog: CatalogSnapshot = {
      tables: [],
      ...emptyCatalogReservations(),
      namespaceContext: {
        writableDefault: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'tenant' },
        ],
      },
    }

    expect(planMigration([Omitted], emptyCatalog(), postgresDialect)).toEqual(
      planMigration([Public], emptyCatalog(), postgresDialect),
    )
    expect(planMigration([Omitted], tenantCatalog, postgresDialect)).toEqual(
      planMigration([Tenant], tenantCatalog, postgresDialect),
    )
    expect(planMigration([Public], tenantCatalog, postgresDialect)).not.toEqual(
      planMigration([Omitted], tenantCatalog, postgresDialect),
    )
  })

  it('uses an explicit registration default before the session writable default', () => {
    const Omitted = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Tenant = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'tenant' },
    )

    expect(
      planMigration([Omitted], emptyCatalog(), postgresDialect, {
        registrationDefault: [{ role: 'schema', spelling: 'tenant' }],
      }),
    ).toEqual(planMigration([Tenant], emptyCatalog(), postgresDialect))
  })

  it('matches omitted and explicit relations against non-default catalog namespaces', () => {
    const Omitted = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Public = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'public' },
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

  it('applies the registration default to foreign-key targets', () => {
    const Parent = defineTable(
      'parents',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Child = defineTable(
      'children',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        parentId: reference(Parent, 'id'),
      },
      { primaryKey: 'id' },
    )

    expect(
      planMigration([Child, Parent], emptyCatalog(), postgresDialect, {
        registrationDefault: [{ role: 'schema', spelling: 'tenant' }],
      }),
    ).toEqual({
      steps: [
        { kind: 'ensure_namespace', target: namespaceTarget('tenant') },
        { kind: 'create_table', target: relationTarget('tenant', 'children') },
        { kind: 'create_table', target: relationTarget('tenant', 'parents') },
        {
          kind: 'add_foreign_key',
          target: columnTarget('tenant', 'children', 'parentId'),
          references: columnReference('tenant', 'parents', 'id'),
        },
      ],
    })
  })

  it('keeps structured migration registrations distinct without dotted keys', () => {
    const definitions = [
      ['c', 'a.b'],
      ['b.c', 'a'],
      ['quoted"table', 'a'],
      ['Case', 'a'],
      ['case', 'a'],
      ['caf\u00e9', 'a'],
      ['cafe\u0301', 'a'],
    ] as const
    const handles = definitions.map(([name, schema]) =>
      defineTable(
        name,
        { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
        { primaryKey: 'id', schema },
      ),
    )

    const plan = planMigration(handles, emptyCatalog(), postgresDialect)
    const targets = plan.steps
      .filter((step) => step.kind === 'create_table')
      .map((step) => [
        step.target.relation.namespace.at(-1)!.identifier.spelling,
        step.target.relation.relation.spelling,
      ])

    expect(targets).toEqual([
      ['a', 'Case'],
      ['a', 'b.c'],
      ['a', 'cafe\u0301'],
      ['a', 'caf\u00e9'],
      ['a', 'case'],
      ['a', 'quoted"table'],
      ['a.b', 'c'],
    ])
  })

  it('matches dotted desired and catalog tuples without collisions', () => {
    const DottedSchema = defineTable(
      'c',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'a.b' },
    )
    const DottedRelation = defineTable(
      'b.c',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'a' },
    )
    const catalog: CatalogSnapshot = {
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

    expect(
      planMigration([DottedSchema, DottedRelation], catalog, postgresDialect),
    ).toEqual({
      steps: [],
    })

    const Anchor = defineTable(
      'anchor',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'a' },
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

  it('formats relation members structurally in planning diagnostics', () => {
    const Dotted = defineTable(
      'c',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'a.b' },
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

  it('is invariant to registered table and catalog collection order', () => {
    const handles = [Accounts, AuditEvents, Comments, Users]
    const catalog = mixedCatalog()
    const originalCatalog = structuredClone(catalog)
    const expected = planMigration(handles, catalog, postgresDialect)

    const catalogs = [catalog, structuredClone(catalog), structuredClone(catalog)]
    catalogs[1]!.tables.reverse()
    catalogs[2]!.tables = rotate(catalogs[2]!.tables)

    for (const candidate of catalogs.slice(1)) {
      for (const table of candidate.tables) {
        table.columns = rotate(table.columns)
        if (table.indexes) table.indexes.reverse()
      }
    }

    for (const registered of [handles, [...handles].reverse(), rotate(handles)]) {
      for (const candidate of catalogs) {
        expect(planMigration(registered, candidate, postgresDialect)).toEqual(expected)
      }
    }

    expect(catalog).toEqual(originalCatalog)
  })

  it('ignores non-semantic constraint order but preserves ordered key sequences', () => {
    const Teams = defineTable(
      'teams',
      {
        tenantId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        teamId: pipe(
          string(),
          column({ physicalType: { postgresql: 'uuid' }, unique: true }),
        ),
      },
      { primaryKey: ['tenantId', 'teamId'], schema: 'public' },
    )
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
      { primaryKey: 'id', schema: 'public' },
    )
    const catalog: CatalogSnapshot = {
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
        {
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
        },
      ],
    }
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

  it('selects the same column issue across desired-property and catalog permutations', () => {
    const Forward = defineTable(
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
    const Reversed = defineTable(
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

  it('breaks otherwise identical issue ties deterministically', () => {
    const missingPrimaryKey = {
      getTableMetadata: () => ({
        name: 'users',
        relation: { relation: 'users' },
        primaryKey: '',
      }),
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

  it('scopes reserved catalog names to their own namespace', () => {
    const TenantUsers = defineTable(
      'users',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', schema: 'other_app' },
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

  it('records the resolved semantic profile every step was built under', () => {
    const schemas = [Users]
    const registrationDefault = [{ role: 'schema' as const, spelling: 'tenant' }]

    expect(
      planMigrationWithContext(
        schemas,
        completePostgresCatalog(
          emptyCatalog(),
          createCatalogRequest(schemas, [], registrationDefault),
        ),
        postgresDialect,
        { registrationDefault },
      ).profile,
    ).toEqual({
      identityAdapter: 'postgresql',
      namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
      registrationDefault,
    })
  })

  it('keeps step kinds and phase order stable while targets stay profile-local', () => {
    const Items = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const tenantCatalog: CatalogSnapshot = {
      ...emptyCatalog(),
      namespaceContext: {
        writableDefault: [
          { role: 'database', spelling: 'test' },
          { role: 'schema', spelling: 'tenant' },
        ],
      },
    }

    const publicPlan = planMigration([Items], emptyCatalog(), postgresDialect)
    const tenantPlan = planMigration([Items], tenantCatalog, postgresDialect)

    expect(publicPlan.steps.map((step) => step.kind)).toEqual(
      tenantPlan.steps.map((step) => step.kind),
    )
    expect(publicPlan).not.toEqual(tenantPlan)
    expect(publicPlan.steps).toEqual([
      { kind: 'create_table', target: relationTarget('public', 'items') },
    ])
    expect(tenantPlan.steps).toEqual([
      { kind: 'create_table', target: relationTarget('tenant', 'items') },
    ])
  })

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
