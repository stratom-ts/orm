import { planMigration as planMigrationWithContext } from '@/ddl/migrationPlan'
import type {
  CatalogForeignKey,
  CatalogIndex,
  CatalogKeyConstraint,
  CatalogNamespace,
  CatalogRequest,
  CatalogSnapshot,
  CatalogTable,
  NamespaceContext,
  ReferentialAction,
} from '@/index'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { createCatalogRequest } from '@/migrations/migrationOwnership'

export type LegacyCatalogColumnFixture = {
  name: string
  dataType: string
  isNullable: boolean
  defaultExpression?: string | null
  identityGeneration?: 'always' | 'byDefault' | null
}

export type LegacyCatalogKeyFixture = {
  name: string
  columns: string[]
  semanticCompleteness?: 'supportedSimple' | 'unsupported'
  isValid?: boolean
}

export type LegacyCatalogForeignKeyFixture = LegacyCatalogKeyFixture & {
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onDelete: ReferentialAction
  onUpdate: ReferentialAction
}

export type LegacyCatalogIndexFixture = LegacyCatalogKeyFixture & {
  unique: boolean
}

export type LegacyCatalogTableFixture = {
  schema: string
  name: string
  columns: LegacyCatalogColumnFixture[]
  indexes?: LegacyCatalogIndexFixture[]
  primaryKey: LegacyCatalogKeyFixture | null
  uniqueConstraints?: LegacyCatalogKeyFixture[]
  foreignKeys?: LegacyCatalogForeignKeyFixture[]
  opaqueObjects?: Array<{
    kind: 'constraint' | 'index' | 'trigger' | 'policy' | 'other'
    name: string
    nativeDefinition: string
    reason: string
  }>
}

export type CompletePostgresCatalogFixture = CatalogSnapshot & {
  tables: LegacyCatalogTableFixture[]
}

export type LegacyCatalogSnapshotFixture = {
  namespaceContext: NamespaceContext
  tables: LegacyCatalogTableFixture[]
  namespaces?: string[]
  nameReservations: Array<{ schema: string; name: string }>
  constraintNameReservations: Array<{ schema: string; table: string; name: string }>
}

type SupportedSimpleSemantics = Pick<
  LegacyCatalogKeyFixture,
  'semanticCompleteness' | 'isValid'
>

export function catalogPrimaryKey(semantics: SupportedSimpleSemantics) {
  return (table: string, columns: string[] = ['id']): LegacyCatalogKeyFixture => ({
    name: `${table}_pkey`,
    columns,
    ...semantics,
  })
}

export const planMigration = (
  schemas: Parameters<typeof planMigrationWithContext>[0],
  catalog: LegacyCatalogSnapshotFixture,
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

function simpleSemantics(
  fixture: LegacyCatalogKeyFixture,
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

function keyConstraint(fixture: LegacyCatalogKeyFixture): CatalogKeyConstraint {
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

export function completePostgresCatalog(
  input: LegacyCatalogSnapshotFixture,
  request: CatalogRequest,
): CompletePostgresCatalogFixture {
  const tables = input.tables
  const identities = createCanonicalRelationIdentityModule({
    adapter: 'postgresql',
    context: input.namespaceContext,
    ...(request.registrationDefault === undefined
      ? {}
      : { registrationDefault: request.registrationDefault }),
  })
  const defaultSchema = input.namespaceContext.writableDefault.find(
    ({ role }) => role === 'schema',
  )?.spelling

  const relationIdentity = (schema: string, relation: string) =>
    identities.resolve({
      namespace: [{ role: 'schema', spelling: schema }],
      relation,
    })
  const namespaceIdentity = (schema: string) =>
    identities.resolveNamespace([{ role: 'schema', spelling: schema }])
  const resolvedRequest = {
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

  const buildTable = (fixture: LegacyCatalogTableFixture): CatalogTable => {
    const columns = fixture.columns.map((column, position) => ({
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
    const primaryKey = fixture.primaryKey
      ? ({ state: 'present', value: keyConstraint(fixture.primaryKey) } as const)
      : ({ state: 'absent' } as const)
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

  const buildNamespaces = (): CatalogNamespace[] => {
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
            table: { state: 'present', value: buildTable(table) },
          })),
      },
    }))
  }
  const namespaces = buildNamespaces()

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
