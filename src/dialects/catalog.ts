import type {
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  NamespaceContext,
  NamespaceIdentifierInput,
  RelationIdentityInput,
} from '@/migrations/canonicalRelationIdentity'
import type { MigrationRelationShape } from '@/migrations/migrationOwnership'
import type { ReferentialAction } from '@/schemas/actions/types'

export type CatalogNoEvidence =
  | Readonly<{ state: 'unsupported'; by: 'engine' | 'adapter'; reason: string }>
  | Readonly<{ state: 'unavailable'; cause: 'permission'; reason: string }>
  | Readonly<{
      state: 'unavailable'
      cause: 'version'
      actual: string
      requires: string
    }>
  | Readonly<{ state: 'unmanaged'; reason: string }>
  | Readonly<{ state: 'unknown'; reason: string }>

export type CatalogFact<T> =
  | Readonly<{ state: 'present'; value: T }>
  | Readonly<{ state: 'absent' }>
  | CatalogNoEvidence

export type CatalogCoverage =
  | Readonly<{ state: 'complete' }>
  | Readonly<{ state: 'partial'; remainder: CatalogNoEvidence }>
  | CatalogNoEvidence

export type CatalogSet<T> = Readonly<{
  items: readonly T[]
  coverage: CatalogCoverage
}>

export type CatalogCapability =
  | Readonly<{ state: 'supported'; fidelity: 'portable' | 'native' | 'opaque' }>
  | Extract<CatalogNoEvidence, { state: 'unsupported' | 'unavailable' }>

export type CatalogRequest = Readonly<{
  relations: readonly Readonly<{
    relation: RelationIdentityInput
    shape: MigrationRelationShape
  }>[]
  absentRelations: readonly RelationIdentityInput[]
  completeNamespaces: readonly (readonly NamespaceIdentifierInput[])[]
  registrationDefault?: readonly NamespaceIdentifierInput[]
}>

export type ResolvedCatalogRequest = Readonly<{
  relations: readonly Readonly<{
    identity: CanonicalRelationIdentity
    shape: MigrationRelationShape
  }>[]
  absentRelations: readonly CanonicalRelationIdentity[]
  completeNamespaces: readonly (readonly CanonicalNamespaceSegment[])[]
}>

export type CatalogDiagnostic = Readonly<{
  code: string
  message: string
  target?: CanonicalRelationIdentity
}>

export type CatalogDataType = Readonly<{
  native: string
  comparisonKey: string
  family: string
  parameters: readonly (string | number)[]
  userDefined: CatalogFact<CanonicalRelationIdentity>
}>

export type CatalogDefault = Readonly<{
  kind: 'literal' | 'portableExpression' | 'nativeExpression'
  native: string
  comparisonKey: CatalogFact<string>
}>

export type CatalogValueGeneration =
  | Readonly<{ kind: 'identity'; mode: 'always' | 'byDefault' }>
  | Readonly<{ kind: 'autoIncrement' }>
  | Readonly<{ kind: 'rowidAlias'; autoIncrement: boolean }>
  | Readonly<{
      kind: 'computed'
      storage: 'virtual' | 'stored'
      expression: string
    }>

export type CatalogColumn = Readonly<{
  name: string
  position: number
  dataType: CatalogFact<CatalogDataType>
  nullable: CatalogFact<boolean>
  default: CatalogFact<CatalogDefault>
  generation: CatalogFact<CatalogValueGeneration>
  nativeDefinition: CatalogFact<string>
}>

export type CatalogSimpleSemantics = Readonly<{
  kind: 'simple'
}>

export type CatalogKeyConstraint = Readonly<{
  name: CatalogFact<string>
  columns: readonly string[]
  semantics: CatalogFact<CatalogSimpleSemantics>
  validity: CatalogFact<'valid' | 'invalid'>
  nativeDefinition: CatalogFact<string>
}>

export type CatalogForeignKey = CatalogKeyConstraint &
  Readonly<{
    referencedRelation: CanonicalRelationIdentity
    referencedColumns: readonly string[]
    onDelete: ReferentialAction
    onUpdate: ReferentialAction
  }>

export type CatalogIndex = Readonly<{
  name: CatalogFact<string>
  origin: 'user' | 'constraint' | 'system'
  columns: readonly string[]
  unique: boolean
  semantics: CatalogFact<CatalogSimpleSemantics>
  validity: CatalogFact<'valid' | 'invalid' | 'building'>
  nativeDefinition: CatalogFact<string>
}>

export type OpaqueCatalogObject = Readonly<{
  kind: 'constraint' | 'index' | 'trigger' | 'policy' | 'other'
  name: CatalogFact<string>
  nativeDefinition: CatalogFact<string>
  reason: string
}>

export type CatalogTable = Readonly<{
  columns: CatalogSet<CatalogColumn>
  primaryKey: CatalogFact<CatalogKeyConstraint>
  uniqueConstraints: CatalogSet<CatalogKeyConstraint>
  foreignKeys: CatalogSet<CatalogForeignKey>
  indexes: CatalogSet<CatalogIndex>
  options: CatalogSet<Readonly<{ name: string; value: string }>>
  opaqueObjects: CatalogSet<OpaqueCatalogObject>
}>

export type CatalogRelation = Readonly<{
  identity: CanonicalRelationIdentity
  kind: 'table' | 'partitionedTable' | 'view' | 'materializedView' | 'foreignTable'
  persistence: 'permanent' | 'temporary' | 'unlogged'
  owner: CatalogFact<string>
  management: 'managed' | 'unmanaged'
  nativeDefinition: CatalogFact<string>
  table: CatalogFact<CatalogTable>
}>

export type CatalogNamespace = Readonly<{
  identity: readonly CanonicalNamespaceSegment[]
  owner: CatalogFact<string>
  relations: CatalogSet<CatalogRelation>
}>

export type CatalogNameReservation = Readonly<{
  namespace: readonly CanonicalNamespaceSegment[]
  name: string
}>

export type CatalogConstraintNameReservation = Readonly<{
  relation: CanonicalRelationIdentity
  name: string
}>

export type CatalogSnapshot = Readonly<{
  source: Readonly<{ dialect: string; version: string }>
  request: ResolvedCatalogRequest
  capabilities: Readonly<Record<string, CatalogCapability>>
  namespaceContext: NamespaceContext
  namespaces: CatalogSet<CatalogNamespace>
  nameReservations: CatalogSet<CatalogNameReservation>
  constraintNameReservations: CatalogSet<CatalogConstraintNameReservation>
  diagnostics: readonly CatalogDiagnostic[]
}>

export type CatalogExecutor = {
  execute(query: { sql: string; params: unknown[] }): Promise<unknown[]>
}

export interface CatalogIntrospector {
  introspectCatalog(
    executor: CatalogExecutor,
    request: CatalogRequest,
  ): Promise<CatalogSnapshot>
}
