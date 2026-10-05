import { nullable, pipe, string } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import type { AuthoredDesiredSchema, CompiledQuery, Dialect } from '@/dialects'
import { postgresDialect } from '@/dialects'
import { POSTGRES_POLICY } from '@/dialects/postgres/identity'
import type { LoweredDesiredSchema } from '@/dialects/types'
import type { TableHandle } from '@/index'
import {
  MigrationError,
  column,
  defineTable,
  getColumnMetadata,
  reference,
} from '@/index'
import type {
  CanonicalRelationIdentityModule,
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type { PhysicalNameRegistry } from '@/migrations/physicalNaming'
import {
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import { createValueMapper } from '@/query'

import {
  SQLITE_IDENTITY_POLICY,
  SQLITE_PHYSICAL_NAMING_FIXTURE,
} from '../helpers/dialectPolicies'
import { relation as canonicalRelation, identifier } from '../helpers/planTargets'
import { exactQueryAddressing } from '../helpers/queryAddressing'

afterEach(() => {
  vi.restoreAllMocks()
})

/** Creates canonical PostgreSQL identities under the fixture's writable namespace default. */
const postgresIdentities = () =>
  createCanonicalRelationIdentityModule({
    policy: POSTGRES_POLICY,
    context: {
      writableDefault: [
        { role: 'database', spelling: 'test' },
        { role: 'schema', spelling: 'public' },
      ],
    },
  })

/** Creates canonical SQLite identities under the main-database default. */
const sqliteIdentities = () =>
  createCanonicalRelationIdentityModule({
    policy: SQLITE_IDENTITY_POLICY,
    context: { writableDefault: [{ role: 'database', spelling: 'main' }] },
  })

/**
 * Serializes namespace roles and comparison keys into an unambiguous fixture identity
 * key.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns An unambiguous serialization of namespace roles and canonical relation keys.
 */
function identityKey(
  identity: AuthoredDesiredSchema['tables'][number]['identity'],
): string {
  return JSON.stringify([
    ...identity.namespace.map((segment) => [
      segment.role,
      segment.identifier.comparisonKey,
    ]),
    ['relation', identity.relation.comparisonKey],
  ])
}

/**
 * Creates SQLite fixture facets with canonical identity resolution and controlled schema
 * lowering.
 *
 * @returns SQLite fixture facets with canonical identity resolution and controlled schema
 *   lowering.
 */
function fakeSqliteDialect(): Dialect {
  const identity = {
    /** Binds canonical relation identity operations to the configured namespace context. */
    create(options: {
      context: NamespaceContext
      registrationDefault?: readonly NamespaceIdentifierInput[]
    }) {
      return createCanonicalRelationIdentityModule({
        policy: SQLITE_IDENTITY_POLICY,
        ...options,
      })
    },
  }

  return createFakeSqliteFacets(identity)
}

describe('whole-graph desired-schema lowering', () => {
  it('defers structured namespace validation to the selected identity member', () => {
    const Attached = defineTable(
      'events',
      { id: pipe(string(), column({ physicalType: { sqlite: 'text' } })) },
      {
        primaryKey: 'id',
        namespace: [{ role: 'database', spelling: 'attached' }],
      },
    )

    const sqlite = fakeSqliteDialect()
    const registered = registerDesiredSchema(
      [Attached],
      sqlite.identity.create({
        context: { writableDefault: [{ role: 'database', spelling: 'main' }] },
      }),
    )
    expect(registered.tables[0]!.identity.namespace).toEqual([
      {
        role: 'database',
        identifier: { spelling: 'attached', comparisonKey: 'attached' },
      },
    ])

    expect(() =>
      lowerDesiredSchema([Attached], postgresIdentities(), postgresDialect.schema),
    ).toThrow(MigrationError)
  })

  it('binds SQLite identity semantics behind the test dialect facet', () => {
    const identity = fakeSqliteDialect().identity.create({
      context: { writableDefault: [{ role: 'database', spelling: 'main' }] },
    })

    const resolved = identity.resolve({ relation: 'Users' })

    expect(resolved.namespace[0]?.identifier.spelling).toBe('main')
    expect(resolved.relation.comparisonKey).toBe('users')
  })
})

describe('whole-graph desired-schema lowering: preserves an unsupported result from the selected desired-schema lowerer', () => {
  it('preserves an unsupported result from the selected desired-schema lowerer', () => {
    const PostgresOnly = defineTable(
      'postgres_only',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )

    expect(() =>
      lowerDesiredSchema([PostgresOnly], sqliteIdentities(), fakeSqliteDialect().schema),
    ).toThrow(
      new MigrationError({
        message: 'fake SQLite requires a sqlite physical type for id',
      }),
    )
  })
})

describe('whole-graph desired-schema lowering: inherits the selected adapter target type without PostgreSQL leakage', () => {
  it('inherits the selected adapter target type without PostgreSQL leakage', () => {
    const Parent = defineTable(
      'parents',
      {
        id: pipe(
          string(),
          column({
            physicalType: {
              postgresql: 'uuid',
              sqlite: 'blob_id',
              mysql: 'binary(16)',
            },
          }),
        ),
        label: pipe(
          string(),
          column({ physicalType: { postgresql: 'text', sqlite: 'sqlite_text' } }),
        ),
      },
      { primaryKey: 'id' },
    )
    const Child = defineTable(
      'children',
      {
        id: pipe(
          string(),
          column({ physicalType: { postgresql: 'uuid', sqlite: 'blob_id' } }),
        ),
        parentId: reference(Parent, 'id'),
      },
      { primaryKey: 'id' },
    )

    const inferSpy = vi.spyOn(postgresDialect.schema, 'inferColumnType')
    const normalizeSpy = vi.spyOn(postgresDialect.schema, 'normalizeDataType')
    const fake = fakeSqliteDialect()
    expect(getColumnMetadata(Child.getSchema().entries.parentId)).toBeUndefined()
    const sqlite = lowerDesiredSchema([Child, Parent], sqliteIdentities(), fake.schema)

    assertSqliteReferenceTypeMapping(sqlite, inferSpy, normalizeSpy, fake, Child, Parent)
  })
})

describe('desired-schema references', () => {
  it('rejects dangling and non-candidate reference targets before planning', () => {
    const Composite = defineTable(
      'composite',
      {
        tenantId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        memberId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      },
      { primaryKey: ['tenantId', 'memberId'] },
    )
    const Ref = defineTable(
      'refs',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        memberId: reference(Composite, 'memberId'),
      },
      { primaryKey: 'id' },
    )

    expect(() =>
      lowerDesiredSchema([Ref], postgresIdentities(), postgresDialect.schema),
    ).toThrow(/unregistered relation/i)

    expect(() =>
      lowerDesiredSchema([Composite, Ref], postgresIdentities(), postgresDialect.schema),
    ).toThrow(/not a candidate key/i)
  })
})

describe('desired-schema references: accepts table cycles when reference targets have ordinary physical types', () => {
  it('accepts table cycles when reference targets have ordinary physical types', () => {
    const InitialA = defineTable(
      'a',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const B = defineTable(
      'b',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        aId: reference(InitialA, 'id'),
      },
      { primaryKey: 'id' },
    )
    const A = defineTable(
      'a',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        bId: reference(B, 'id'),
      },
      { primaryKey: 'id' },
    )

    expect(() =>
      lowerDesiredSchema([B, A], postgresIdentities(), postgresDialect.schema),
    ).not.toThrow()
  })
})

describe('desired-schema references: resolves reference chains and reports reference-only cycles deterministically', () => {
  it('resolves reference chains and reports reference-only cycles deterministically', () => {
    const Root = defineTable(
      'root',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Middle = defineTable(
      'middle',
      { id: reference(Root, 'id') },
      { primaryKey: 'id' },
    )
    const Leaf = defineTable(
      'leaf',
      { id: reference(Middle, 'id') },
      { primaryKey: 'id' },
    )
    const lowered = lowerDesiredSchema(
      [Leaf, Middle, Root],
      postgresIdentities(),
      postgresDialect.schema,
    )
    expect(
      lowered.tables
        .find((table) => table.identity.relation.spelling === 'leaf')!
        .columns.find((value) => value.identifier.spelling === 'id')?.dataType,
    ).toBe('uuid')

    const InitialB = defineTable(
      'cycle_b',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const CycleA = defineTable(
      'cycle_a',
      { id: reference(InitialB, 'id') },
      { primaryKey: 'id' },
    )
    const CycleB = defineTable(
      'cycle_b',
      { id: reference(CycleA, 'id') },
      { primaryKey: 'id' },
    )
    expect(() =>
      lowerDesiredSchema([CycleB, CycleA], postgresIdentities(), postgresDialect.schema),
    ).toThrow(/reference-only physical type cycle.*cycle_a/i)
  })
})

describe('desired-schema references: resolves reference chains and reports reference-only cycles deterministically: accepts an independent single-column unique index as a candidate key', () => {
  it('accepts an independent single-column unique index as a candidate key', () => {
    const Target = defineTable(
      'indexed_target',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        code: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
      },
      { primaryKey: 'id', indexes: [{ columns: ['code'], unique: true }] },
    )
    const Source = defineTable(
      'indexed_source',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        code: reference(Target, 'code'),
      },
      { primaryKey: 'id' },
    )

    expect(() =>
      lowerDesiredSchema([Source, Target], postgresIdentities(), postgresDialect.schema),
    ).not.toThrow()
  })
})

describe('desired-schema references: resolves reference chains and reports reference-only cycles deterministically: preserves unique on a composite-primary-key member only when independently set', () => {
  it('preserves unique on a composite-primary-key member only when independently set', () => {
    const Membership = defineTable(
      'memberships',
      {
        tenantId: pipe(
          string(),
          column({ physicalType: { postgresql: 'uuid' }, unique: true }),
        ),
        memberId: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      },
      { primaryKey: ['tenantId', 'memberId'] },
    )
    const [table] = lowerDesiredSchema(
      [Membership],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables

    expect(
      table!.columns.find((value) => value.identifier.spelling === 'tenantId')?.unique,
    ).toBe(true)
  })
})

describe('desired-schema reference metadata and value mapping', () => {
  it('lowers composed reference metadata without copying target column options', () => {
    const Target = createTargetTable()
    const Source = createSourceTable(Target)
    const source = lowerDesiredSchema(
      [Source, Target],
      postgresIdentities(),
      postgresDialect.schema,
    ).tables.find((table) => table.identity.relation.spelling === 'composed_sources')!

    expect(source.columns).toEqual(expectedComposedReferenceColumns)
  })
})

describe('desired-schema reference metadata and value mapping: maps reference values with the target type and local mapping functions', () => {
  it('maps reference values with the target type and local mapping functions', () => {
    const Target = defineTable(
      'mapped_targets',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Source = defineTable(
      'mapped_sources',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: pipe(
          reference(Target, 'id'),
          column({
            /** Applies the column parameter override before client mapping. */
            mapParam: (value) => `param:${String(value)}`,
            /** Applies the column result override before client mapping. */
            mapResult: (value) => `result:${String(value)}`,
          }),
        ),
      },
      { primaryKey: 'id' },
    )
    const mapper = createValueMapper(postgresDialect, undefined, [Source, Target])

    expect(mapper.columnTypes(Source).targetId).toBe('uuid')
    expect(mapper.mapParam(Source, 'targetId', 'abc')).toBe('param:abc')
    expect(mapper.mapResultValue(Source, 'targetId', 'abc')).toBe('result:abc')
  })
})

describe('desired-schema reference metadata and value mapping: validates reference targets before global or dialect mapping', () => {
  it('validates reference targets before global or dialect mapping', () => {
    const Target = defineTable(
      'mapper_targets',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id' },
    )
    const Source = defineTable(
      'mapper_sources',
      {
        id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
        targetId: reference(Target, 'id'),
      },
      { primaryKey: 'id' },
    )

    expect(() => createValueMapper(postgresDialect, undefined, [Source])).toThrow(
      /not registered/i,
    )

    const globalMap = vi.fn<(dataType: string, value: unknown) => unknown>(
      (_dataType: string, value: unknown) =>
        typeof value === 'string' ? `global:${value}` : value,
    )
    const globalMapper = createValueMapper(
      postgresDialect,
      { mapParamValue: globalMap },
      [Source, Target],
    )
    expect(globalMapper.mapParam(Source, 'targetId', 'abc')).toBe('global:abc')
    expect(globalMap).toHaveBeenCalledWith('uuid', 'abc')

    const dialectMap = vi.fn<(dataType: string, value: unknown) => unknown>(
      (_dataType: string, value: unknown) =>
        typeof value === 'string' ? `dialect:${value}` : value,
    )
    const dialectMapper = createValueMapper(
      {
        ...postgresDialect,
        query: { ...postgresDialect.query, mapParamValue: dialectMap },
      },
      undefined,
      [Source, Target],
    )
    expect(dialectMapper.mapParam(Source, 'targetId', 'abc')).toBe('dialect:abc')
    expect(dialectMap).toHaveBeenCalledWith('uuid', 'abc')
  })
})

/**
 * Creates the fake sqlite facets fixture used by the contract scenario.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns The fake sqlite facets fixture used by the contract scenario.
 */
function createFakeSqliteFacets(identity: {
  create(options: {
    context: NamespaceContext
    registrationDefault?: readonly NamespaceIdentifierInput[]
  }): CanonicalRelationIdentityModule
}) {
  const naming = createFakeSqliteNaming()

  const lowerDesiredSchema = lowerFakeSqliteDesiredSchema

  const inferColumnType = vi.fn<() => never>(() => {
    throw new Error('fake adapter inference must not be used by this contract')
  })
  const normalizeDataType = vi.fn<(value: string) => string>((value: string) => value)
  const compile = vi.fn<() => CompiledQuery>(() => ({ sql: '', params: [] }))
  const catalog = {
    introspectCatalog: vi.fn<() => Promise<never>>(async () => {
      throw new Error('fake adapter introspection is outside this contract')
    }),
  }

  return {
    id: 'sqlite',
    identity: { id: 'sqlite-fixture', ...identity },
    naming,
    schema: {
      lowerDesiredSchema,
      inferColumnType,
      normalizeDataType,
    },
    query: exactQueryAddressing(compile),
    catalog,
    operations: {
      /** Creates the connector's provider for exclusive native operation sessions. */
      createSessionProvider: () => {
        throw new Error('fake SQLite operations are outside this contract')
      },
      compile,
    },
    migration: createFakeSqliteMigration(
      identity,
      naming,
      lowerDesiredSchema,
      normalizeDataType,
      catalog,
    ),
  }
}

/**
 * Creates the fake sqlite naming fixture used by the contract scenario.
 *
 * @returns The fake sqlite naming fixture used by the contract scenario.
 */
function createFakeSqliteNaming() {
  return {
    /** Generates a deterministic physical name under the selected dialect's limits. */
    generate: (seed: Parameters<typeof generatePhysicalName>[0]) =>
      generatePhysicalName(seed, SQLITE_PHYSICAL_NAMING_FIXTURE),
    /** Rejects physical identifiers that violate the selected dialect's naming rules. */
    validate: (name: string, description: string) =>
      validatePhysicalName(name, description, SQLITE_PHYSICAL_NAMING_FIXTURE),
    /**
     * Creates a registry that detects physical-name collisions in the selected uniqueness
     * scopes.
     */
    createRegistry: () => createPhysicalNameRegistry(SQLITE_PHYSICAL_NAMING_FIXTURE),
  }
}

/**
 * Creates the fake sqlite migration fixture used by the contract scenario.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param naming - Physical-name generation, validation, and uniqueness rules.
 * @param lowerDesiredSchema - Fixture override for desired-schema lowering.
 * @param normalizeDataType - Fixture override for physical-type comparison normalization.
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 *
 * @returns The fake sqlite migration fixture used by the contract scenario.
 */
function createFakeSqliteMigration(
  identity: {
    create(options: {
      context: NamespaceContext
      registrationDefault?: readonly NamespaceIdentifierInput[]
    }): CanonicalRelationIdentityModule
  },
  naming: {
    generate: (seed: Parameters<typeof generatePhysicalName>[0]) => string
    validate: (name: string, description: string) => void
    createRegistry: () => PhysicalNameRegistry
  },
  lowerDesiredSchema: typeof lowerFakeSqliteDesiredSchema,
  normalizeDataType: (value: string) => string,
  catalog: { introspectCatalog(): Promise<never> },
) {
  return {
    planning: {
      identity: { id: 'sqlite-fixture', ...identity },
      naming,
      schema: { lowerDesiredSchema, normalizeDataType },
    },
    catalog,
    /** Lowers for the current fixture scenario. */
    lower: () => {
      throw new Error('fake SQLite migration is outside this contract')
    },
    /** Executes fixture SQL with the configured native observations. */
    execute: async () => {
      throw new Error('fake SQLite migration is outside this contract')
    },
  }
}

/**
 * Builds a fresh source table handle for the schema scenario.
 *
 * @param Target - Table handle used to exercise target schema behavior.
 *
 * @returns A fresh source table handle for the schema scenario.
 */
function createSourceTable(Target: ReturnType<typeof createTargetTable>) {
  return defineTable(
    'composed_sources',
    {
      id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
      targetId: pipe(
        reference(Target, 'id', {
          onDelete: 'set default',
          onUpdate: 'restrict',
        }),
        column({
          unique: true,
          databaseDefault: {
            kind: 'literal',
            value: '00000000-0000-0000-0000-000000000000',
          },
        }),
      ),
      nullableTargetId: nullable(pipe(reference(Target, 'id'), column({ unique: true }))),
      plainTargetId: reference(Target, 'id'),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Builds a fresh target table handle for the schema scenario.
 *
 * @returns A fresh target table handle for the schema scenario.
 */
function createTargetTable() {
  return defineTable(
    'composed_targets',
    {
      id: pipe(
        string(),
        column({
          physicalType: { postgresql: 'uuid' },
          databaseDefault: {
            kind: 'dialectExpression',
            dialect: 'postgresql',
            expression: 'gen_random_uuid()',
          },
        }),
      ),
    },
    { primaryKey: 'id' },
  )
}

/**
 * Checks SQLite reference-type inheritance without using PostgreSQL inference or
 * normalization.
 *
 * @param sqlite - SQLite dialect fixture selected for the scenario.
 * @param inferSpy - Spy recording calls to physical-type inference.
 * @param normalizeSpy - Spy recording calls to physical-type normalization.
 * @param fake - Test dialect whose behavior is checked against the shared contract.
 * @param Child - Table handle used to exercise child schema behavior.
 * @param Parent - Table handle used to exercise parent schema behavior.
 */
function assertSqliteReferenceTypeMapping(
  sqlite: LoweredDesiredSchema,
  inferSpy: unknown,
  normalizeSpy: unknown,
  fake: Dialect,
  Child: TableHandle,
  Parent: TableHandle,
) {
  expect(
    sqlite.tables.map((table) => ({
      relation: table.identity.relation.spelling,
      columns: table.columns.map((value) => ({
        name: value.identifier.spelling,
        dataType: value.dataType,
      })),
    })),
  ).toEqual([
    {
      relation: 'children',
      columns: [
        { name: 'id', dataType: 'blob_id' },
        { name: 'parentId', dataType: 'blob_id' },
      ],
    },
    {
      relation: 'parents',
      columns: [
        { name: 'id', dataType: 'blob_id' },
        { name: 'label', dataType: 'sqlite_text' },
      ],
    },
  ])

  expect(inferSpy).not.toHaveBeenCalled()
  expect(normalizeSpy).not.toHaveBeenCalled()

  expect(createValueMapper(fake, undefined, [Child, Parent]).columnTypes(Child)).toEqual({
    id: 'blob_id',
    parentId: 'blob_id',
  })
}

/**
 * Lowers fake sqlite desired schema for the current fixture scenario.
 *
 * @param graph - Registered authored tables and their resolved reference graph.
 *
 * @returns Desired tables with fixture-resolved column storage and references.
 */
function lowerFakeSqliteDesiredSchema(graph: AuthoredDesiredSchema) {
  const types = collectFakeSqliteColumnTypes(graph)

  return {
    tables: graph.tables.map((table) => ({
      handle: table.handle,
      identity: table.identity,
      columns: table.columns.map((authored) => {
        const dataType = authored.reference
          ? types.get(
              `${identityKey(authored.reference.targetRelation)}\0${authored.reference.targetColumn.spelling}`,
            )
          : types.get(`${identityKey(table.identity)}\0${authored.name}`)

        if (dataType === undefined) {
          throw new MigrationError({
            message: `fake SQLite requires a resolved physical type for ${authored.name}`,
          })
        }

        return {
          identifier: authored.identifier,
          dataType,
          notNull: true,
          unique: authored.metadata?.unique ?? false,
          autoIncrement: false,
        }
      }),
      primaryKey: (Array.isArray(table.metadata.primaryKey)
        ? table.metadata.primaryKey
        : [table.metadata.primaryKey]
      ).map((name) => table.columns.find((column) => column.name === name)!.identifier),
    })),
  }
}

const expectedComposedReferenceColumns = [
  {
    identifier: identifier('id'),
    dataType: 'uuid',
    notNull: true,
    unique: false,
    autoIncrement: false,
  },
  {
    identifier: identifier('targetId'),
    dataType: 'uuid',
    notNull: true,
    unique: true,
    autoIncrement: false,
    databaseDefault: {
      sql: "'00000000-0000-0000-0000-000000000000'",
      normalized: "'00000000-0000-0000-0000-000000000000'",
    },
    reference: {
      relation: canonicalRelation('public', 'composed_targets'),
      column: identifier('id'),
      onDelete: 'set default',
      onUpdate: 'restrict',
    },
  },
  {
    identifier: identifier('nullableTargetId'),
    dataType: 'uuid',
    notNull: false,
    unique: true,
    autoIncrement: false,
    reference: {
      relation: canonicalRelation('public', 'composed_targets'),
      column: identifier('id'),
    },
  },
  {
    identifier: identifier('plainTargetId'),
    dataType: 'uuid',
    notNull: true,
    unique: false,
    autoIncrement: false,
    reference: {
      relation: canonicalRelation('public', 'composed_targets'),
      column: identifier('id'),
    },
  },
]

/**
 * Collects fake sqlite column types for the current fixture scenario.
 *
 * @param graph - Registered authored tables and their resolved reference graph.
 *
 * @returns Resolved physical types keyed by authored column name.
 */
function collectFakeSqliteColumnTypes(graph: AuthoredDesiredSchema) {
  const types = new Map<string, string>()
  const authoredColumns = graph.tables.flatMap((table) =>
    table.columns
      .filter((authored) => !authored.reference)
      .map((authored) => ({ table, authored })),
  )

  for (const { table, authored } of authoredColumns) {
    const selected = authored.metadata?.physicalType?.sqlite

    if (!selected) {
      throw new MigrationError({
        message: `fake SQLite requires a sqlite physical type for ${authored.name}`,
      })
    }

    types.set(`${identityKey(table.identity)}\0${authored.name}`, selected)
  }

  return types
}
