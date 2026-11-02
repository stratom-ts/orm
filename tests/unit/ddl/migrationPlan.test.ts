import { decimal, ip, mac48, mac64, nullable, pipe, string, uuid } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import type { PlannedMigration } from '@/ddl/migrationPlan'
import { planMigration as planMigrationWithContext } from '@/ddl/migrationPlan'
import type { AuthoredDesiredSchema, CompiledQuery, Dialect } from '@/dialects'
import { POSTGRES_IDENTITY_POLICY } from '@/dialects/postgres/identity'
import { POSTGRES_PHYSICAL_NAMING } from '@/dialects/postgres/naming'
import type { TableHandle } from '@/index'
import { column, defineTable, postgresDialect, reference } from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type {
  CanonicalRelationIdentityModule,
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import {
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'

import type { PostgresCatalogSnapshotFixture as CatalogSnapshot } from '../dialects/postgresCatalogFixtures'
import {
  completePostgresCatalog,
  postgresCatalogPrimaryKey as createCatalogPrimaryKey,
  planPostgresMigration as planMigration,
} from '../dialects/postgresCatalogFixtures'
import {
  columnIdentifiers,
  columnReference,
  columnTarget,
  indexTarget,
  namespaceTarget,
  relationTarget,
} from '../helpers/planTargets'
import { exactQueryAddressing } from '../helpers/queryAddressing'

const usesTheSuppliedDialectWithoutIntrospectionOrCompilationData = [
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

it('should authorize local unique and foreign-key removal only through explicit source-column drops', () => {
  const Keep = defineTable('keep', { id: string() }, { primaryKey: 'id' })
  const Retain = defineTable(
    'keep',
    { id: string(), removed: nullable(string()) },
    { primaryKey: 'id' },
  )

  const catalog = droppedConstraintCatalog()

  expect(planMigration([Keep], catalog, postgresDialect)).toEqual({
    steps: [{ kind: 'drop_column', target: columnTarget('public', 'keep', 'removed') }],
  })

  expect(() => planMigration([Retain], catalog, postgresDialect)).toThrow(
    'Unsupported removal of extra unique constraints',
  )

  const onlyForeign = {
    ...catalog,
    tables: catalog.tables.map((table) => ({ ...table, uniqueConstraints: [] })),
  }

  expect(() => planMigration([Retain], onlyForeign, postgresDialect)).toThrow(
    'Unsupported removal of extra foreign keys',
  )
})

/** Builds local constraints whose source column can be explicitly dropped. */
function droppedConstraintCatalog(): CatalogSnapshot {
  return {
    ...emptyCatalog(),
    tables: [
      {
        schema: 'public',
        name: 'keep',
        columns: [
          { name: 'id', dataType: 'text', isNullable: false },
          { name: 'removed', dataType: 'text', isNullable: true },
        ],
        primaryKey: {
          name: 'keep_pkey',
          columns: ['id'],
          ...SUPPORTED_CATALOG_SEMANTICS,
        },
        uniqueConstraints: [
          {
            name: 'keep_removed_key',
            columns: ['removed'],
            ...SUPPORTED_CATALOG_SEMANTICS,
          },
        ],
        foreignKeys: [
          {
            name: 'keep_removed_fk',
            columns: ['removed'],
            referencedSchema: 'public',
            referencedTable: 'parent',
            referencedColumns: ['id'],
            onDelete: 'no action',
            onUpdate: 'no action',
            ...SUPPORTED_CATALOG_SEMANTICS,
          },
        ],
      },
    ],
  }
}

const catalogPrimaryKey = createCatalogPrimaryKey(SUPPORTED_CATALOG_SEMANTICS)

describe('PostgreSQL inferred UUID Migration Plans', () => {
  it('should leave an already-UUID catalog unchanged', () => {
    const Desired = defineTable(
      'uuid_payloads',
      { id: pipe(string(), uuid()) },
      { primaryKey: 'id' },
    )

    const catalog: CatalogSnapshot = {
      ...emptyCatalog(),
      tables: [
        {
          schema: 'public',
          name: 'uuid_payloads',
          columns: [{ name: 'id', dataType: 'uuid', isNullable: false }],
          primaryKey: catalogPrimaryKey('uuid_payloads'),
        },
      ],
    }

    expect(planMigration([Desired], catalog, postgresDialect)).toEqual({ steps: [] })
  })
})

describe('should plan PostgreSQL native string formats', () => {
  it.each([
    [ip(), 'inet'],
    [mac48(), 'macaddr'],
    [mac64(), 'macaddr8'],
    [decimal(), 'numeric'],
  ] as const)(
    'should leave an existing %s catalog unchanged as %s',
    (format, dataType) => {
      const Desired = defineTable(
        'native_payloads',
        { id: pipe(string(), format) },
        { primaryKey: 'id' },
      )

      const catalog: CatalogSnapshot = {
        ...emptyCatalog(),
        tables: [
          {
            schema: 'public',
            name: 'native_payloads',
            columns: [{ name: 'id', dataType, isNullable: false }],
            primaryKey: catalogPrimaryKey('native_payloads'),
          },
        ],
      }

      expect(planMigration([Desired], catalog, postgresDialect)).toEqual({ steps: [] })

      catalog.tables[0].columns[0].dataType = 'text'

      expect(planMigration([Desired], catalog, postgresDialect).steps).toMatchObject([
        { kind: 'alter_column_type', dataType },
      ])
    },
  )
})

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
    uniqueEmail: pipe(
      string(),
      column({ physicalType: { postgresql: 'text' }, unique: true }),
    ),
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
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'audit' }] },
)

/** Returns a fresh cyclic permutation used to check input-order invariance. */
function rotate<T>(values: readonly T[]): T[] {
  return values.length < 2 ? [...values] : [...values.slice(1), values[0]]
}

/** Builds mixed catalog evidence for schema reconciliation checks. */
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
      createMixedAccountsCatalog(),
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

describe('Migration Plan construction', () => {
  it('should plan authored namespace intent from table metadata', () => {
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
})

/**
 * Lowers custom desired schema for the current fixture scenario.
 *
 * @param graph - Registered authored tables and their resolved reference graph.
 *
 * @returns Desired tables using the fixture's custom storage types.
 */
const lowerCustomDesiredSchema = (graph: AuthoredDesiredSchema) => ({
  tables: graph.tables.map((table) => ({
    identity: table.identity,
    columns: table.columns.map((column) => ({
      identifier: column.identifier,
      dataType: 'custom_string',
      notNull: !column.facts.nullable,
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
    primaryKey: (Array.isArray(table.metadata.primaryKey)
      ? table.metadata.primaryKey
      : [table.metadata.primaryKey]
    ).map((name) => table.columns.find((column) => column.name === name)!.identifier),
  })),
})

describe('Migration Plan selected dialect semantics', () => {
  it('should use the supplied dialect without introspection or compilation', () => {
    const PortableSettings = createPortableSettingsTable()
    const { dialect, introspect, compile, identity, identityModules, naming } =
      createCustomPlanningDialect()

    const catalog: CatalogSnapshot = {
      namespaceContext: POSTGRES_NAMESPACE_CONTEXT,
      ...emptyCatalogReservations(),
      tables: [
        {
          schema: 'public',
          name: 'portable_settings',
          columns: structuredClone(
            usesTheSuppliedDialectWithoutIntrospectionOrCompilationData,
          ),
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

    assertCustomPlanningFacets(planned, identity, identityModules, naming)
  })
})

describe('Migration Plan phase and target ordering', () => {
  it('should cover every supported step kind in canonical phase and target order', () => {
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
      steps: expectedCanonicalMigrationSteps,
    })
  })
})

describe('Migration Plan ordering and semantic profiles', () => {
  it('should use locale-independent code-unit target ordering', () => {
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
})

describe('Migration Plan ordering and semantic profiles: produces equal Migration Plans for omitted and explicit resolved defaults', () => {
  it('should produce equal Migration Plans for omitted and explicit resolved defaults', () => {
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

    const Tenant = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'tenant' }] },
    )

    const FullyQualifiedTenant = createFullyQualifiedTenantTable()
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

    assertEquivalentRegistrationProfiles(
      Omitted,
      Public,
      tenantCatalog,
      Tenant,
      FullyQualifiedTenant,
    )

    const omittedQuery = postgresDialect.query.resolve([Omitted]).compile({
      kind: 'select',
      relation: Omitted.getTableMetadata().relation,
      selection: [{ kind: 'all' }],
    })

    expect(omittedQuery.sql).toContain('from "items" as "items"')
    expect(omittedQuery.sql).not.toContain('"public"."items"')
    expect(omittedQuery.sql).not.toContain('"tenant"."items"')
  })
})

describe('Migration Plan ordering and semantic profiles: uses an explicit registration default before the session writable default', () => {
  it('should use an explicit registration default before the session writable default', () => {
    const Omitted = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )

    const Tenant = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'tenant' }] },
    )

    expect(
      planMigration([Omitted], emptyCatalog(), postgresDialect, {
        registrationDefault: [{ role: 'schema', spelling: 'tenant' }],
      }),
    ).toEqual(planMigration([Tenant], emptyCatalog(), postgresDialect))
  })
})

describe('Migration Plan ordering and semantic profiles: uses an explicit registration default before the session writable default: applies the registration default to foreign-key targets', () => {
  it('should apply the registration default to foreign-key targets', () => {
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
})

describe('Migration Plan ordering and semantic profiles: keeps structured migration registrations distinct without dotted keys', () => {
  it('should keep structured migration registrations distinct without dotted keys', () => {
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
        { primaryKey: 'id', namespace: [{ role: 'schema', spelling: schema }] },
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
})

describe('Migration Plan determinism and semantic profiles', () => {
  it('should be invariant to registered table and catalog collection order', () => {
    const handles = [Accounts, AuditEvents, Comments, Users]
    const catalog = mixedCatalog()
    const originalCatalog = structuredClone(catalog)
    const expected = planMigration(handles, catalog, postgresDialect)

    const catalogs = [catalog, structuredClone(catalog), structuredClone(catalog)]
    catalogs[1].tables.reverse()
    catalogs[2].tables = rotate(catalogs[2].tables)

    for (const candidate of catalogs.slice(1)) {
      for (const table of candidate.tables) {
        table.columns = rotate(table.columns)

        table.indexes?.reverse()
      }
    }

    for (const registered of [handles, [...handles].reverse(), rotate(handles)]) {
      for (const candidate of catalogs) {
        expect(planMigration(registered, candidate, postgresDialect)).toEqual(expected)
      }
    }

    expect(catalog).toEqual(originalCatalog)
  })
})

describe('Migration Plan determinism and semantic profiles: records the resolved semantic profile every step was built under', () => {
  it('should record the resolved semantic profile every step was built under', () => {
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
})

describe('Migration Plan determinism and semantic profiles: keeps step kinds and phase order stable while targets stay profile-local', () => {
  it('should keep step kinds and phase order stable while targets stay profile-local', () => {
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
})

/**
 * Builds a fresh fully qualified tenant table handle for the schema scenario.
 *
 * @returns A fresh fully qualified tenant table handle for the schema scenario.
 */
function createFullyQualifiedTenantTable() {
  return defineTable(
    'items',
    { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
    {
      primaryKey: 'id',
      namespace: [
        { role: 'database', spelling: 'test' },
        { role: 'schema', spelling: 'tenant' },
      ],
    },
  )
}

/**
 * Builds a fresh portable settings table handle for the schema scenario.
 *
 * @returns A fresh portable settings table handle for the schema scenario.
 */
function createPortableSettingsTable() {
  return defineTable(
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
}

/**
 * Checks equal Migration Plans for omitted and explicitly resolved namespace defaults.
 *
 * @param Omitted - Table handle used to exercise omitted schema behavior.
 * @param Public - Table handle used to exercise public schema behavior.
 * @param tenantCatalog - Observed catalog evidence in the tenant namespace.
 * @param Tenant - Table handle used to exercise tenant schema behavior.
 * @param FullyQualifiedTenant - Table handle used to exercise fully qualified tenant
 *   schema behavior.
 */
function assertEquivalentRegistrationProfiles(
  Omitted: TableHandle,
  Public: TableHandle,
  tenantCatalog: CatalogSnapshot,
  Tenant: TableHandle,
  FullyQualifiedTenant: ReturnType<typeof createFullyQualifiedTenantTable>,
) {
  expect(planMigration([Omitted], emptyCatalog(), postgresDialect)).toEqual(
    planMigration([Public], emptyCatalog(), postgresDialect),
  )

  expect(planMigration([Omitted], tenantCatalog, postgresDialect)).toEqual(
    planMigration([Tenant], tenantCatalog, postgresDialect),
  )

  expect(planMigration([FullyQualifiedTenant], tenantCatalog, postgresDialect)).toEqual(
    planMigration([Tenant], tenantCatalog, postgresDialect),
  )

  expect(planMigration([Public], tenantCatalog, postgresDialect)).not.toEqual(
    planMigration([Omitted], tenantCatalog, postgresDialect),
  )
}

/**
 * Checks that Migration Plan construction uses the selected identity, naming, and schema
 * facets.
 *
 * @param planned - Migration Plan with its resolved Semantic Profile and desired-schema
 *   registrations.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param identityModules - Identity modules whose policy differences are exercised.
 * @param naming - Physical-name generation, validation, and uniqueness rules.
 */
function assertCustomPlanningFacets(
  planned: PlannedMigration,
  identity: ReturnType<typeof createPlanningDialectSpies>['identity'],
  identityModules: CanonicalRelationIdentityModule[],
  naming: ReturnType<typeof createPlanningDialectSpies>['naming'],
) {
  expect(planned.profile.identityAdapter).toBe('custom-identity')
  expect(identity.create).toHaveBeenCalled()

  expect(identityModules[0].resolve({ relation: 'portable_settings' }).namespace).toEqual(
    identityModules[0].resolve({
      namespace: [{ role: 'schema', spelling: 'public' }],
      relation: 'portable_settings',
    }).namespace,
  )

  expect(naming.generate).toHaveBeenCalled()
  expect(naming.validate).toHaveBeenCalled()
  expect(naming.createRegistry).toHaveBeenCalled()
}

/**
 * Creates the custom planning dialect fixture used by the contract scenario.
 *
 * @returns The custom planning dialect fixture used by the contract scenario.
 */
function createCustomPlanningDialect() {
  const { identity, naming, compile, introspect, identityModules } =
    createPlanningDialectSpies()

  const lowerDesiredSchema = lowerCustomDesiredSchema
  const inferColumnType = inferCustomPlanningType
  const normalizeDataType = normalizeCustomPlanningType
  const normalizeDefaultValue = normalizeCustomPlanningDefault
  const dialect: Dialect = {
    id: 'mysql',
    classifyDriverError: () => ({ kind: 'unknown', retryable: false }),
    identity,
    naming,
    schema: {
      lowerDesiredSchema,
      inferColumnType,
      normalizeDataType,
      normalizeDefaultValue,
    },
    query: exactQueryAddressing(compile),
    operations: {
      /** Creates the connector's provider for exclusive native operation sessions. */
      createSessionProvider: () => {
        throw new Error('fake migration-planning operations are outside this contract')
      },
      compile,
    },
    migration: {
      planning: {
        identity,
        naming,
        schema: {
          lowerDesiredSchema,
          normalizeDataType,
          normalizeDefaultValue,
        },
      },
      catalog: { introspectCatalog: introspect },
      /** Lowers for the current fixture scenario. */
      lower: () => {
        throw new Error('fake migration lowering is outside this contract')
      },
      /** Executes fixture SQL with the configured native observations. */
      execute: async () => {
        throw new Error('fake migration execution is outside this contract')
      },
    },
    catalog: { introspectCatalog: introspect },
  }

  return { dialect, introspect, compile, identity, identityModules, naming }
}

/**
 * Creates the planning dialect spies fixture used by the contract scenario.
 *
 * @returns The planning dialect spies fixture used by the contract scenario.
 */
function createPlanningDialectSpies() {
  const introspect = vi.fn<Dialect['catalog']['introspectCatalog']>(
    async (_executor, request) => completePostgresCatalog(emptyCatalog(), request),
  )

  const compile = vi.fn<() => CompiledQuery>(() => ({ sql: '', params: [] }))
  const identityModules: CanonicalRelationIdentityModule[] = []
  const identity = {
    id: 'custom-identity',
    create: vi.fn<Dialect['identity']['create']>(
      (options: {
        context: NamespaceContext
        registrationDefault?: readonly NamespaceIdentifierInput[]
      }) => {
        const identities = createCanonicalRelationIdentityModule({
          policy: POSTGRES_IDENTITY_POLICY,
          ...options,
        })

        identityModules.push(identities)
        return identities
      },
    ),
  }

  const naming = {
    generate: vi.fn<Dialect['naming']['generate']>(
      (seed: Parameters<typeof generatePhysicalName>[0]) =>
        generatePhysicalName(seed, POSTGRES_PHYSICAL_NAMING),
    ),
    validate: vi.fn<Dialect['naming']['validate']>((name: string, description: string) =>
      validatePhysicalName(name, description, POSTGRES_PHYSICAL_NAMING),
    ),
    createRegistry: vi.fn<Dialect['naming']['createRegistry']>(() =>
      createPhysicalNameRegistry(POSTGRES_PHYSICAL_NAMING),
    ),
  }

  return { identity, naming, compile, introspect, identityModules }
}

/** Creates the mixed accounts catalog fixture used by the contract scenario. */
function createMixedAccountsCatalog(): CatalogSnapshot['tables'][number] {
  return {
    schema: 'public',
    name: 'accounts',
    columns: [
      { name: 'removedZ', dataType: 'text', isNullable: true },
      { name: 'indexFirst', dataType: 'text', isNullable: false },
      { name: 'madeRequired', dataType: 'text', isNullable: true },
      { name: 'id', dataType: 'uuid', isNullable: false },
      { name: 'changedType', dataType: 'integer', isNullable: false },
      { name: 'madeNullable', dataType: 'text', isNullable: false },
      { name: 'uniqueEmail', dataType: 'text', isNullable: false },
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
  }
}

const expectedCanonicalMigrationSteps = [
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
    kind: 'add_unique_constraint',
    target: columnTarget('public', 'accounts', 'uniqueEmail'),
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
]

/** Infers a supported physical SQL type from Valibot schema facts. */
function inferCustomPlanningType() {
  return 'custom_string'
}

/** Normalizes physical SQL type spelling for stable schema comparison. */
function normalizeCustomPlanningType(dataType: string) {
  return dataType === 'custom_string_alias' ? 'custom_string' : dataType
}

/** Normalizes the fixture default into its comparison spelling. */
function normalizeCustomPlanningDefault(value: string | number | boolean | null) {
  return `custom_default:${String(value)}`
}
