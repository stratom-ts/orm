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
  const tables = input.tables ?? []
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

  const buildTable = (fixture: LegacyCatalogTableFixture): CatalogTable => ({
    columns: {
      coverage: { state: 'complete' },
      get items() {
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
      },
    },
    get primaryKey() {
      return fixture.primaryKey
        ? ({ state: 'present', value: keyConstraint(fixture.primaryKey) } as const)
        : ({ state: 'absent' } as const)
    },
    uniqueConstraints: {
      coverage: { state: 'complete' },
      get items() {
        return (fixture.uniqueConstraints ?? []).map(keyConstraint)
      },
    },
    foreignKeys: {
      coverage: { state: 'complete' },
      get items(): CatalogForeignKey[] {
        return (fixture.foreignKeys ?? []).map((foreignKey) => ({
          ...keyConstraint(foreignKey),
          referencedRelation: relationIdentity(
            foreignKey.referencedSchema,
            foreignKey.referencedTable,
          ),
          referencedColumns: foreignKey.referencedColumns,
          onDelete: foreignKey.onDelete,
          onUpdate: foreignKey.onUpdate,
        }))
      },
    },
    indexes: {
      coverage: { state: 'complete' },
      get items(): CatalogIndex[] {
        return (fixture.indexes ?? []).map((index) => ({
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
      },
    },
    options: { items: [], coverage: { state: 'complete' } },
    opaqueObjects: {
      coverage: { state: 'complete' },
      get items() {
        return (fixture.opaqueObjects ?? []).map((object) => ({
          kind: object.kind,
          name: { state: 'present' as const, value: object.name },
          nativeDefinition: {
            state: 'present' as const,
            value: object.nativeDefinition,
          },
          reason: object.reason,
        }))
      },
    },
  })

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

  return {
    tables,
    source: { dialect: 'postgresql', version: '160000' },
    request: resolvedRequest,
    capabilities: {
      fixture: { state: 'supported', fidelity: 'native' },
    },
    namespaceContext: input.namespaceContext,
    get namespaces() {
      return {
        items: buildNamespaces(),
        coverage: { state: 'complete' as const },
      }
    },
    nameReservations: {
      coverage: { state: 'complete' },
      items: (input.nameReservations ?? []).map((reservation) => ({
        namespace: namespaceIdentity(reservation.schema),
        name: reservation.name,
      })),
    },
    constraintNameReservations: {
      coverage: { state: 'complete' },
      items: (input.constraintNameReservations ?? []).map((reservation) => ({
        relation: relationIdentity(reservation.schema, reservation.table),
        name: reservation.name,
      })),
    },
    diagnostics: [],
  }
}
