import { planMigration as planMigrationWithContext } from '@/ddl/migrationPlan'
import { POSTGRES_IDENTITY_POLICY } from '@/dialects/postgres/identity'
import type {
  CatalogFact,
  CatalogForeignKey,
  CatalogIndex,
  CatalogKeyConstraint,
  CatalogNamespace,
  CatalogRelation,
  CatalogRequest,
  CatalogSet,
  CatalogSnapshot,
  CatalogTable,
  MigrationRelationShape,
  NamespaceContext,
  NamespaceIdentifierInput,
  ReferentialAction,
  RelationIdentityInput,
} from '@/index'
import type {
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
} from '@/migrations/canonicalRelationIdentity'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

export type PostgresCatalogColumnFixture = {
  name: string
  dataType: string
  isNullable: boolean
  defaultExpression?: string | null
  identityGeneration?: 'always' | 'byDefault' | null
}

export type PostgresCatalogKeyFixture = {
  name: string
  columns: string[]
  semanticCompleteness?: 'supportedSimple' | 'unsupported'
  isValid?: boolean
}

export type PostgresCatalogForeignKeyFixture = PostgresCatalogKeyFixture & {
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onDelete: ReferentialAction
  onUpdate: ReferentialAction
}

export type PostgresCatalogIndexFixture = PostgresCatalogKeyFixture & {
  unique: boolean
}

export type PostgresCatalogTableFixture = {
  schema: string
  name: string
  columns: PostgresCatalogColumnFixture[]
  indexes?: PostgresCatalogIndexFixture[]
  primaryKey: PostgresCatalogKeyFixture | null
  uniqueConstraints?: PostgresCatalogKeyFixture[]
  foreignKeys?: PostgresCatalogForeignKeyFixture[]
  opaqueObjects?: {
    kind: 'constraint' | 'index' | 'trigger' | 'policy' | 'other'
    name: string
    nativeDefinition: string
    reason: string
  }[]
}

export type CompletePostgresCatalogFixture = CatalogSnapshot & {
  tables: PostgresCatalogTableFixture[]
}

export type PostgresCatalogSnapshotFixture = {
  namespaceContext: NamespaceContext
  tables: PostgresCatalogTableFixture[]
  namespaces?: string[]
  nameReservations: { schema: string; name: string }[]
  constraintNameReservations: { schema: string; table: string; name: string }[]
}

type SupportedSimpleSemantics = Pick<
  PostgresCatalogKeyFixture,
  'semanticCompleteness' | 'isValid'
>

/**
 * Builds catalog primary key evidence for schema reconciliation checks.
 *
 * @param semantics - Desired or observed semantic facts used for compatibility checks.
 *
 * @returns Catalog primary key evidence for schema reconciliation checks.
 */
export function postgresCatalogPrimaryKey(semantics: SupportedSimpleSemantics) {
  return (table: string, columns: string[] = ['id']): PostgresCatalogKeyFixture => ({
    name: `${table}_pkey`,
    columns,
    ...semantics,
  })
}

/** Completes fixture catalog evidence before invoking migration planning. */
export const planPostgresMigration = (
  schemas: Parameters<typeof planMigrationWithContext>[0],
  catalog: PostgresCatalogSnapshotFixture,
  dialect: Parameters<typeof planMigrationWithContext>[2],
  options?: Parameters<typeof planMigrationWithContext>[3],
) =>
  planMigrationWithContext(
    schemas,
    completePostgresCatalog(
      catalog,
      createCatalogRequest(
        schemas,
        options?.migrationOwnership ?? [],
        options?.registrationDefault,
      ),
    ),
    dialect,
    options,
  ).plan

/**
 * Preserves explicit unsupported key semantics or supplies supported simple-key evidence.
 *
 * @param fixture - Native catalog or connector fixture used by the test.
 *
 * @returns Supported simple-key evidence or the fixture's declared unsupported semantics.
 */
function simpleSemantics(
  fixture: PostgresCatalogKeyFixture,
): CatalogKeyConstraint['semantics'] {
  return fixture.semanticCompleteness === 'unsupported'
    ? {
        state: 'unsupported',
        by: 'adapter',
        reason: 'Fixture declares native semantics',
      }
    : {
        state: 'present',
        value: { kind: 'simple' },
      }
}

/** Projects a fixture key into evidence-bearing native constraint facts. */
function keyConstraint(fixture: PostgresCatalogKeyFixture): CatalogKeyConstraint {
  return {
    name: { state: 'present', value: fixture.name },
    columns: fixture.columns,
    semantics: simpleSemantics(fixture),
    validity: {
      state: 'present',
      value: fixture.isValid === false ? 'invalid' : 'valid',
    },
    nativeDefinition: { state: 'present', value: fixture.name },
  }
}

/**
 * Builds complete table evidence from the native catalog fixture.
 *
 * @param fixture - Native catalog or connector fixture used by the test.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Complete portable table evidence for the native fixture definition.
 */
function buildFixtureTable(
  fixture: PostgresCatalogTableFixture,
  identities: ReturnType<typeof createCanonicalRelationIdentityModule>,
): CatalogTable {
  /** Resolves the supplied schema and relation under the fixture identity policy. */
  const relationIdentity = (schema: string, relation: string) =>
    identities.resolve({ namespace: [{ role: 'schema', spelling: schema }], relation })

  const columns = buildFixtureColumns(fixture)
  const primaryKey = fixture.primaryKey
    ? ({ state: 'present', value: keyConstraint(fixture.primaryKey) } as const)
    : ({ state: 'absent' } as const)

  return fixtureTableEvidence(fixture, relationIdentity, columns, primaryKey)
}

/**
 * Builds table evidence from fixture columns, keys, indexes, and opaque native objects.
 *
 * @param fixture - Native catalog or connector fixture used by the test.
 * @param relationIdentity - Canonical relation identity or resolver used to match catalog
 *   fixtures.
 * @param columns - Ordered column names, references, or observations used by this
 *   operation.
 * @param primaryKey - Observed primary-key evidence in declared column order.
 *
 * @returns Table evidence from fixture columns, keys, indexes, and opaque native objects.
 */
function fixtureTableEvidence(
  fixture: PostgresCatalogTableFixture,
  relationIdentity: (schema: string, relation: string) => CanonicalRelationIdentity,
  columns: CatalogTable['columns']['items'],
  primaryKey: CatalogTable['primaryKey'],
): CatalogTable {
  const { uniqueConstraints, foreignKeys, indexes, opaqueObjects } =
    buildFixtureConstraints(fixture, relationIdentity)

  return {
    columns: { items: columns, coverage: { state: 'complete' } },
    primaryKey,
    uniqueConstraints: {
      items: uniqueConstraints,
      coverage: { state: 'complete' },
    },
    foreignKeys: { items: foreignKeys, coverage: { state: 'complete' } },
    indexes: { items: indexes, coverage: { state: 'complete' } },
    options: { items: [], coverage: { state: 'complete' } },
    opaqueObjects: { items: opaqueObjects, coverage: { state: 'complete' } },
  }
}

/**
 * Decodes fixture keys, indexes, and opaque objects without losing native evidence.
 *
 * @param fixture - Native catalog or connector fixture used by the test.
 * @param relationIdentity - Canonical relation identity or resolver used to match catalog
 *   fixtures.
 *
 * @returns Decoded unique keys, foreign keys, indexes, and opaque native objects.
 */
function buildFixtureConstraints(
  fixture: PostgresCatalogTableFixture,
  relationIdentity: (schema: string, relation: string) => CanonicalRelationIdentity,
) {
  const uniqueConstraints = (fixture.uniqueConstraints ?? []).map(keyConstraint)
  const foreignKeys: CatalogForeignKey[] = (fixture.foreignKeys ?? []).map(
    (foreignKey) => ({
      ...keyConstraint(foreignKey),
      referencedRelation: relationIdentity(
        foreignKey.referencedSchema,
        foreignKey.referencedTable,
      ),
      referencedColumns: foreignKey.referencedColumns,
      onDelete: foreignKey.onDelete,
      onUpdate: foreignKey.onUpdate,
    }),
  )

  const indexes: CatalogIndex[] = (fixture.indexes ?? []).map((index) => ({
    name: { state: 'present', value: index.name },
    origin: 'user',
    columns: index.columns,
    unique: index.unique,
    semantics: simpleSemantics(index),
    validity: {
      state: 'present',
      value: index.isValid === false ? 'invalid' : 'valid',
    },
    nativeDefinition: { state: 'present', value: index.name },
  }))

  const opaqueObjects = (fixture.opaqueObjects ?? []).map((object) => ({
    kind: object.kind,
    name: { state: 'present' as const, value: object.name },
    nativeDefinition: {
      state: 'present' as const,
      value: object.nativeDefinition,
    },
    reason: object.reason,
  }))

  return { uniqueConstraints, foreignKeys, indexes, opaqueObjects }
}

/**
 * Builds ordered native column evidence with explicit storage and generation facts.
 *
 * @param fixture - Native catalog or connector fixture used by the test.
 *
 * @returns Column evidence in authored order with native position and storage facts.
 */
function buildFixtureColumns(fixture: PostgresCatalogTableFixture) {
  return fixture.columns.map((column, position) => ({
    name: column.name,
    position: position + 1,
    dataType: {
      state: 'present' as const,
      value: {
        native: column.dataType,
        comparisonKey: column.dataType,
        family: column.dataType.replace(/\(.*/, ''),
        parameters: [],
        userDefined: { state: 'absent' as const },
      },
    },
    nullable: { state: 'present' as const, value: column.isNullable },
    default:
      column.defaultExpression == null
        ? ({ state: 'absent' } as const)
        : ({
            state: 'present',
            value: {
              kind: 'nativeExpression',
              native: column.defaultExpression,
              comparisonKey: {
                state: 'present',
                value: column.defaultExpression,
              },
            },
          } as const),
    generation:
      column.identityGeneration == null
        ? ({ state: 'absent' } as const)
        : ({
            state: 'present',
            value: { kind: 'identity', mode: column.identityGeneration },
          } as const),
    nativeDefinition: { state: 'present' as const, value: column.dataType },
  }))
}

/**
 * Builds complete postgres catalog evidence for schema reconciliation checks.
 *
 * @param input - Postgres catalog snapshot fixture inputs and shared accumulators.
 * @param request - Requested relations, declared absences, and completely owned
 *   namespaces.
 *
 * @returns Complete postgres catalog evidence for schema reconciliation checks.
 */
export function completePostgresCatalog(
  input: PostgresCatalogSnapshotFixture,
  request: CatalogRequest,
): CompletePostgresCatalogFixture {
  const tables = input.tables
  const identities = createCanonicalRelationIdentityModule({
    policy: POSTGRES_IDENTITY_POLICY,
    context: input.namespaceContext,
    ...(request.registrationDefault === undefined
      ? {}
      : { registrationDefault: request.registrationDefault }),
  })

  const defaultSchema = input.namespaceContext.writableDefault.find(
    ({ role }) => role === 'schema',
  )?.spelling

  /** Resolves the supplied schema and relation under the fixture identity policy. */
  const relationIdentity = (schema: string, relation: string) =>
    identities.resolve({
      namespace: [{ role: 'schema', spelling: schema }],
      relation,
    })

  /** Resolves the supplied schema under the fixture namespace default. */
  const namespaceIdentity = (schema: string) =>
    identities.resolveNamespace([{ role: 'schema', spelling: schema }])

  const resolvedRequest = resolveFixtureCatalogRequest(request, identities)
  /** Builds namespaces for the current fixture scenario. */
  const buildNamespaces = () =>
    buildFixtureNamespaces(
      defaultSchema,
      input,
      tables,
      namespaceIdentity,
      relationIdentity,
      identities,
    )

  const namespaces = buildNamespaces()

  return assembleFixtureCatalog(
    tables,
    resolvedRequest,
    input,
    namespaces,
    namespaceIdentity,
    relationIdentity,
  )
}

/**
 * Builds assemble fixture catalog evidence for schema reconciliation checks.
 *
 * @param tables - Observed table definitions used to build fixture catalog evidence.
 * @param resolvedRequest - Requested scope after canonical identity and namespace
 *   resolution.
 * @param input - Postgres catalog snapshot fixture inputs and shared accumulators.
 * @param namespaces - Observed namespace evidence, including relation coverage.
 * @param namespaceIdentity - Canonical namespace identity used to attach relation
 *   evidence.
 * @param relationIdentity - Canonical relation identity or resolver used to match catalog
 *   fixtures.
 *
 * @returns Assemble fixture catalog evidence for schema reconciliation checks.
 */
function assembleFixtureCatalog(
  tables: PostgresCatalogTableFixture[],
  resolvedRequest: {
    relations: { identity: CanonicalRelationIdentity; shape: MigrationRelationShape }[]
    absentRelations: CanonicalRelationIdentity[]
    completeNamespaces: (readonly CanonicalNamespaceSegment[])[]
  },
  input: PostgresCatalogSnapshotFixture,
  namespaces: Readonly<{
    identity: readonly CanonicalNamespaceSegment[]
    owner: CatalogFact<string>
    relations: CatalogSet<CatalogRelation>
  }>[],
  namespaceIdentity: (schema: string) => readonly CanonicalNamespaceSegment[],
  relationIdentity: (schema: string, relation: string) => CanonicalRelationIdentity,
): CompletePostgresCatalogFixture {
  return {
    tables,
    source: { dialect: 'postgresql', version: '160000' },
    request: resolvedRequest,
    capabilities: {
      namespaces: { state: 'supported', fidelity: 'native' },
      relationOwner: { state: 'supported', fidelity: 'native' },
      identity: { state: 'supported', fidelity: 'native' },
      richObjects: { state: 'supported', fidelity: 'native' },
    },
    namespaceContext: input.namespaceContext,
    namespaces: { items: namespaces, coverage: { state: 'complete' } },
    nameReservations: {
      coverage: { state: 'complete' },
      items: input.nameReservations.map((reservation) => ({
        namespace: namespaceIdentity(reservation.schema),
        name: reservation.name,
      })),
    },
    constraintNameReservations: {
      coverage: { state: 'complete' },
      items: input.constraintNameReservations.map((reservation) => ({
        relation: relationIdentity(reservation.schema, reservation.table),
        name: reservation.name,
      })),
    },
    diagnostics: [],
  }
}

/**
 * Canonicalizes requested ownership using native and registration namespace defaults.
 *
 * @param request - Requested relations, declared absences, and completely owned
 *   namespaces.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Canonical ownership scope using resolved writable and registration defaults.
 */
function resolveFixtureCatalogRequest(
  request: Readonly<{
    relations: readonly Readonly<{
      relation: RelationIdentityInput
      shape: MigrationRelationShape
    }>[]
    absentRelations: readonly RelationIdentityInput[]
    completeNamespaces: readonly (readonly NamespaceIdentifierInput[])[]
    registrationDefault?: readonly NamespaceIdentifierInput[]
  }>,
  identities: CanonicalRelationIdentityModule,
) {
  return {
    relations: request.relations.map(({ relation, shape }) => ({
      identity: identities.resolve(relation),
      shape,
    })),
    absentRelations: request.absentRelations.map((relation) =>
      identities.resolve(relation),
    ),
    completeNamespaces: request.completeNamespaces.map((namespace) =>
      identities.resolveNamespace(namespace),
    ),
  }
}

/**
 * Builds requested namespace coverage with relation and absence evidence.
 *
 * @param defaultSchema - Fixture schema used when an authored relation omits its
 *   namespace.
 * @param input - Postgres catalog snapshot fixture inputs and shared accumulators.
 * @param tables - Observed table definitions used to build fixture catalog evidence.
 * @param namespaceIdentity - Canonical namespace identity used to attach relation
 *   evidence.
 * @param relationIdentity - Canonical relation identity or resolver used to match catalog
 *   fixtures.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Ordered namespace evidence containing requested relation and absence
 *   observations.
 */
function buildFixtureNamespaces(
  defaultSchema: string | undefined,
  input: PostgresCatalogSnapshotFixture,
  tables: PostgresCatalogTableFixture[],
  namespaceIdentity: (schema: string) => readonly CanonicalNamespaceSegment[],
  relationIdentity: (schema: string, relation: string) => CanonicalRelationIdentity,
  identities: CanonicalRelationIdentityModule,
): CatalogNamespace[] {
  const schemaNames = [
    ...(defaultSchema ? [defaultSchema] : []),
    ...(input.namespaces ?? []),
    ...tables.map((table) => table.schema),
  ].filter((schema, index, values) => values.indexOf(schema) === index)

  return schemaNames.map((schema) => ({
    identity: namespaceIdentity(schema),
    owner: { state: 'present', value: 'fixture_owner' },
    relations: {
      coverage: { state: 'complete' },
      items: tables
        .filter((table) => table.schema === schema)
        .map((table) => ({
          identity: relationIdentity(table.schema, table.name),
          kind: 'table',
          persistence: 'permanent',
          owner: { state: 'present', value: 'fixture_owner' },
          management: 'managed',
          nativeDefinition: {
            state: 'unsupported',
            by: 'adapter',
            reason: 'Fixture does not carry CREATE TABLE SQL',
          },
          table: { state: 'present', value: buildFixtureTable(table, identities) },
        })),
    },
  }))
}
