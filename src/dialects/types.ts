import type { Connector } from 'db0'

import type { DialectMigrationAdapter } from '@/ddl/migrationProgram'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import type { PhysicalNameRegistry, PhysicalNameSeed } from '@/migrations/physicalNaming'
import type { OperationSessionProvider } from '@/operations/operationSession'
import type {
  ColumnMetadata,
  ReferenceMetadata,
  RelationIdentityInput,
  TableMetadata,
} from '@/schemas/actions/types'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'

import type { CatalogIntrospector } from './catalog'

export type * from './catalog'

/** SQL type string produced by dialect type inference. */
export type SqlDataType = string

/**
 * Dialect identity and writable-namespace selection.
 *
 * The module binds the selected dialect's identity semantics while allowing
 * callers to provide the session namespace context and registration default.
 */
export type DialectIdentity = Readonly<{
  /** Stable semantic identity key for MigrationSemanticProfile comparison. */
  readonly id: string
  create(options: {
    context: NamespaceContext
    registrationDefault?: readonly NamespaceIdentifierInput[]
  }): CanonicalRelationIdentityModule
}>

/**
 * Dialect-bound physical naming behavior.
 *
 * The underlying profile and its low-level comparison and scope rules remain
 * implementation details of the selected dialect.
 */
export type DialectNaming = Readonly<{
  generate(seed: PhysicalNameSeed): string
  validate(name: string, description: string): void
  createRegistry(): PhysicalNameRegistry
}>

/** One canonically registered authored column before physical lowering. */
export type AuthoredDesiredColumn = Readonly<{
  name: string
  identifier: CanonicalIdentifier
  schema: AnySchema
  metadata?: ColumnMetadata
  reference?: Readonly<{
    metadata: ReferenceMetadata
    targetRelation: CanonicalRelationIdentity
    targetColumn: CanonicalIdentifier
  }>
}>

/** One canonically registered authored table before physical lowering. */
export type AuthoredDesiredTable = Readonly<{
  handle: TableHandle
  identity: CanonicalRelationIdentity
  metadata: TableMetadata
  columns: readonly AuthoredDesiredColumn[]
}>

/** Complete, canonically ordered and reference-validated authored schema graph. */
export type AuthoredDesiredSchema = Readonly<{
  tables: readonly AuthoredDesiredTable[]
}>

/** Adapter-rendered database default carried unambiguously to DDL. */
export type LoweredDatabaseDefault = Readonly<{
  sql: string
  normalized: string
}>

/** One physically resolved desired column with portable canonical addressing. */
export type LoweredDesiredColumn = Readonly<{
  identifier: CanonicalIdentifier
  dataType: string
  notNull: boolean
  unique: boolean
  autoIncrement: boolean
  defaultValue?: string | number | boolean | null
  databaseDefault?: LoweredDatabaseDefault
  generated?: 'always' | 'byDefault'
  reference?: Readonly<{
    relation: CanonicalRelationIdentity
    column: CanonicalIdentifier
    onDelete?: string
    onUpdate?: string
  }>
}>

/** One physically resolved desired table. */
export type LoweredDesiredTable = Readonly<{
  handle: TableHandle
  identity: CanonicalRelationIdentity
  columns: readonly LoweredDesiredColumn[]
  primaryKey: readonly CanonicalIdentifier[]
}>

/** Immutable selected-adapter result for the complete desired graph. */
export type LoweredDesiredSchema = Readonly<{
  tables: readonly LoweredDesiredTable[]
}>

/** Whole-graph schema lowering and physical column type behavior. */
export type DialectSchema = Readonly<{
  lowerDesiredSchema(graph: AuthoredDesiredSchema): LoweredDesiredSchema
  inferColumnType(schema: AnySchema): SqlDataType
  normalizeDataType(dataType: string): string
  normalizeDefaultValue?: (value: string | number | boolean | null) => string
}>

/** Parameterized SQL produced by dialect compilation. */
export type CompiledQuery = {
  sql: string
  params: unknown[]
}

/** SQL compilation and optional dialect value conversion behavior. */
export type DialectQuery = Readonly<{
  compile(node: SqlAst): CompiledQuery
  mapResultValue?: (dataType: string, value: unknown) => unknown
  mapParamValue?: (dataType: string, value: unknown) => unknown
}>

/** Structured operation lifecycle command compiled by the selected dialect. */
export type OperationCommand =
  | Readonly<{ kind: 'ping' }>
  | Readonly<{ kind: 'begin' | 'commit' | 'rollback' }>
  | Readonly<{
      kind: 'createSavepoint' | 'rollbackToSavepoint' | 'releaseSavepoint'
      id: number
    }>

/** Adapts a selected connector and compiles its operation lifecycle commands. */
export type DialectOperations = Readonly<{
  createSessionProvider(connector: Connector): OperationSessionProvider
  compile(command: OperationCommand): CompiledQuery
}>

/** Comparison operators for simple where predicates. */
export type ComparisonOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'

/** Column reference expression. */
export type ColumnExprAst = {
  readonly kind: 'column'
  readonly column: string
  readonly relation?: RelationIdentityInput
}

/** Aggregate / scalar expressions supported in v1. */
export type AggregateExprAst =
  | { readonly kind: 'count_all' }
  | { readonly kind: 'count'; readonly arg: ColumnExprAst }
  | {
      readonly kind: 'min' | 'max' | 'sum'
      readonly arg: ColumnExprAst
    }

export type StringFnExprAst = {
  readonly kind: 'lower' | 'upper' | 'length'
  readonly arg: ColumnExprAst
}

export type DateFnExprAst =
  | { readonly kind: 'now' }
  | {
      readonly kind: 'date_trunc'
      readonly unit: string
      readonly arg: ColumnExprAst
    }

/** Scalar SQL expression (select list / having). */
export type SqlExprAst =
  | ColumnExprAst
  | AggregateExprAst
  | StringFnExprAst
  | DateFnExprAst

/** Select list item. */
export type SelectItemAst =
  | { readonly kind: 'all'; readonly relation?: RelationIdentityInput }
  | {
      readonly kind: 'column'
      readonly column: string
      readonly relation?: RelationIdentityInput
      readonly alias?: string
    }
  | {
      readonly kind: 'expr'
      readonly expr: SqlExprAst
      readonly alias: string
    }

/**
 * Equality or comparison predicate on a single column.
 * Kept for simple update/delete where; also used inside {@link PredicateAst}.
 */
export type WhereClause = {
  readonly column: string
  readonly op: ComparisonOp
  readonly value: unknown
}

/** Optional table-qualified column name in predicates / order / group. */
export type QualifiedColumnAst = {
  readonly column: string
  readonly relation?: RelationIdentityInput
}

/**
 * Composable boolean predicate tree for where / having / join on.
 * `cmp` is either column-vs-value (`value`) or column-vs-column (`right`).
 */
export type PredicateAst =
  | {
      readonly kind: 'cmp'
      readonly column: string
      readonly relation?: RelationIdentityInput
      readonly op: ComparisonOp
      readonly value?: unknown
      readonly right?: QualifiedColumnAst
    }
  | { readonly kind: 'and'; readonly preds: readonly PredicateAst[] }
  | { readonly kind: 'or'; readonly preds: readonly PredicateAst[] }
  | { readonly kind: 'not'; readonly pred: PredicateAst }

export type OrderByAst = {
  readonly column: string
  readonly relation?: RelationIdentityInput
  readonly direction: 'asc' | 'desc'
}

/** Explicit join clause (no FK relation sugar). */
export type JoinAst = {
  readonly type: 'inner' | 'left' | 'right'
  readonly relation: RelationIdentityInput
  readonly on: PredicateAst
}

export type SelectAst = {
  readonly kind: 'select'
  readonly relation: RelationIdentityInput
  /** Empty or `[{ kind: 'all' }]` → `select *`. */
  readonly selection: readonly SelectItemAst[]
  readonly joins?: readonly JoinAst[]
  readonly where?: PredicateAst
  readonly orderBy?: readonly OrderByAst[]
  readonly limit?: number
  readonly offset?: number
  readonly groupBy?: readonly QualifiedColumnAst[]
  readonly having?: PredicateAst
}

/** Returning projection for insert/update/delete. */
export type ReturningAst =
  | { readonly kind: 'all' }
  | { readonly kind: 'columns'; readonly columns: readonly string[] }

export type InsertAst = {
  readonly kind: 'insert'
  readonly relation: RelationIdentityInput
  /** Column names shared by every values row (order fixed). */
  readonly columns: readonly string[]
  /** One or more value tuples aligned with `columns`. */
  readonly values: readonly (readonly unknown[])[]
  readonly returning?: ReturningAst
}

export type UpdateAst = {
  readonly kind: 'update'
  readonly relation: RelationIdentityInput
  readonly set: readonly { readonly column: string; readonly value: unknown }[]
  /** Predicate; empty + allowAll is full-table update. */
  readonly where?: PredicateAst
  readonly allowAll: boolean
  readonly returning?: ReturningAst
}

export type DeleteAst = {
  readonly kind: 'delete'
  readonly relation: RelationIdentityInput
  readonly where?: PredicateAst
  readonly allowAll: boolean
  readonly returning?: ReturningAst
}

export type SqlAst = SelectAst | InsertAst | UpdateAst | DeleteAst

/**
 * Complete connector-selected dialect member.
 *
 * Each cohesive facet owns one stage of database semantics: identity and
 * namespace resolution, physical naming, schema lowering, query behavior,
 * catalog observation, operation-session adaptation, and migration lowering.
 * PostgreSQL is the production implementation; test-only adapters may expose
 * explicit unsupported stubs for capabilities outside their contract.
 */
export interface Dialect {
  readonly id: string

  /** Identity and writable-namespace selection for canonical relations. */
  readonly identity: DialectIdentity

  /** Physical identifier limits, comparison, and uniqueness rules. */
  readonly naming: DialectNaming

  /** Whole-graph schema lowering and physical type behavior. */
  readonly schema: DialectSchema

  /** SQL compilation and value mapping behavior. */
  readonly query: DialectQuery

  /** Deep adapter module for scoped catalog observation. */
  readonly catalog: CatalogIntrospector

  /** Operation-session adaptation for the selected connector. */
  readonly operations: DialectOperations

  /** Bound planning, catalog observation, lowering, and coordinated execution. */
  readonly migration: DialectMigrationAdapter
}
