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
import type { ResolvedColumnNames } from '@/schemas/physicalColumn'
import type { StorageFacts } from '@/storage/facts'
import type { TableHandle } from '@/types'
import type { DriverErrorClassifier } from '@/utils/error'

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
  /**
   * Binds canonical relation identity operations to the configured namespace context.
   *
   * @param options - Configuration and dependencies for this operation.
   *
   * @returns Canonical identity operations bound to the selected namespace defaults.
   */
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
  /**
   * Generates a deterministic physical name under the selected dialect's limits.
   *
   * @param seed - Structured owning identity and object details used to generate the
   *   physical name.
   *
   * @returns The deterministic physical name within the selected dialect's identifier
   *   limits.
   */
  generate(seed: PhysicalNameSeed): string
  /**
   * Rejects physical identifiers that violate the selected dialect's naming rules.
   *
   * @param name - Physical identifier or dialect label used by this operation.
   * @param description - Diagnostic label that identifies invalid input.
   */
  validate(name: string, description: string): void
  /**
   * Creates a registry that detects physical-name collisions in the selected uniqueness
   * scopes.
   *
   * @returns A registry that detects physical-name collisions in the selected uniqueness
   *   scopes.
   */
  createRegistry(): PhysicalNameRegistry
}>

/** One canonically registered authored column before physical lowering. */
export type AuthoredDesiredColumn = Readonly<{
  name: string
  identifier: CanonicalIdentifier
  facts: StorageFacts
  metadata?: ColumnMetadata
  reference?: Readonly<{
    metadata: ReferenceMetadata
    targetRelation: CanonicalRelationIdentity
    targetColumn: CanonicalIdentifier
  }>
}>

/** One canonically registered authored table before physical lowering. */
export type AuthoredDesiredTable = Readonly<{
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

/** Physical lowering result before shared code restores the native table association. */
export type StorageDesiredSchema = Readonly<{
  tables: readonly Omit<LoweredDesiredTable, 'handle'>[]
}>

/** Whole-graph schema lowering and physical column type behavior. */
export type DialectSchema = Readonly<{
  /**
   * Resolves authored column storage into the selected dialect's desired-schema
   * representation.
   *
   * @param graph - Registered authored tables and their resolved reference graph.
   *
   * @returns Desired tables with dialect-specific physical storage and resolved
   *   references.
   */
  lowerDesiredSchema(
    graph: AuthoredDesiredSchema,
    context?: Readonly<{
      /** The client supplies an explicit result-mapping contract for every column. */
      hasGlobalResultMapping: boolean
      /** The client supplies an explicit parameter-mapping contract for every column. */
      hasGlobalParameterMapping?: boolean
    }>,
  ): StorageDesiredSchema
  /**
   * Infers a supported physical SQL type from logical storage facts.
   *
   * @param facts - Provider-neutral logical storage evidence.
   *
   * @returns The supported physical SQL type; unsupported schema facts throw.
   */
  inferColumnType(facts: StorageFacts): SqlDataType
  /**
   * Normalizes physical SQL type spelling for stable schema comparison.
   *
   * @param dataType - Physical SQL type used for validation, comparison, or value
   *   mapping.
   *
   * @returns The normalized type spelling used for storage equality.
   */
  normalizeDataType(dataType: string): string
}>

/** Database session evidence available immediately before physical execution. */
export type QuerySessionIdentity = Readonly<{
  database: string
  namespaceContext?: NamespaceContext
}>

/** Parameterized SQL produced by dialect compilation. */
export type CompiledQuery = {
  sql: string
  params: readonly unknown[]
  /** SQL output aliases restored before application value mapping. */
  resultProjection?: readonly Readonly<{ sqlName: string; outputName: string }>[]
  /** Optional member-owned execution guard evaluated on the pinned session. */
  assertSession?: (identity: QuerySessionIdentity) => void
}

/**
 * One client-scoped resolution of a member's relation and member semantics.
 *
 * Compilation and every semantic lookup use this same client-scoped result. The
 * reusable member contract enforces that its addressing policies agree.
 */
export type DialectQueryResolution = Readonly<{
  /**
   * Compiles the current query or command into SQL and ordered bound parameters.
   *
   * @param node - AST node or dependency-graph node being processed.
   *
   * @returns Compiled SQL and bound values in emitted order.
   */
  compile(node: SqlAst): CompiledQuery
  /**
   * Finds registered handles compatible with the authored relation under the selected
   * query rules.
   *
   * @param relation - Authored or canonical relation addressed by this operation.
   * @param handles - Registered handles used for relation and column resolution.
   *
   * @returns Registered handles compatible with the authored relation under the selected
   *   query rules.
   */
  findRelationMatches(
    relation: RelationIdentityInput,
    handles?: readonly TableHandle[],
  ): readonly TableHandle[]
  /**
   * Finds columns compatible with an authored name under the selected query rules.
   *
   * @param handle - Table handle whose schema and relation metadata are required.
   * @param column - Authored column spelling to resolve, map, or compile.
   *
   * @returns Columns compatible with an authored name under the selected query rules.
   */
  findColumnMatches(handle: TableHandle, column: string): readonly string[]
}>

/** Client registration context consumed by one selected Query member. */
export type DialectQueryResolveOptions = Readonly<{
  columnNames?: ResolvedColumnNames
  /** Optional namespace applied to omitted authored relation registrations. */
  registrationDefault?: readonly NamespaceIdentifierInput[]
}>

/** Logical column semantics supplied independently of the selected physical SQL type. */
export type DialectValueMappingContext = Readonly<{
  /**
   * Logical facts, resolved through reference targets independently of physical
   * overrides.
   */
  facts: StorageFacts
  /** Local reference facts, including wrappers and actions applied at the source. */
  authoredFacts?: StorageFacts
}>

/** SQL resolution, compilation, and optional dialect value conversion behavior. */
export type DialectQuery = Readonly<{
  /** SQL syntax used by the scoped template tag; omitted by members without raw SQL. */
  rawSql?: Readonly<{
    quoteIdentifier(identifier: string): string
    placeholder(position: number): string
  }>

  /** Proves native number arithmetic support; absent extensions reject addition. */
  numericAssignmentType?: (
    dataType: string,
    context: DialectValueMappingContext,
  ) => 'integer' | 'float' | undefined
  /** Rejects unproven built-in mappings during client construction, before SQL. */
  validateValueMapping?: (dataType: string, context: DialectValueMappingContext) => void
  /**
   * Binds query compilation and matching to the registered table handles.
   *
   * @param handles - Registered handles used for relation and column resolution.
   * @param options - Configuration and dependencies for this operation.
   *
   * @returns Query compilation and matching operations for the resolved registry.
   */
  resolve(
    handles: readonly TableHandle[],
    options?: DialectQueryResolveOptions,
  ): DialectQueryResolution
  /**
   * Maps driver values with optional logical schema context; physical type stays
   * unchanged.
   */
  mapResultValue?: (
    dataType: string,
    value: unknown,
    context?: DialectValueMappingContext,
  ) => unknown
  /** Maps parameters with optional logical schema context; physical type stays unchanged. */
  mapParamValue?: (
    dataType: string,
    value: unknown,
    context?: DialectValueMappingContext,
  ) => unknown
}>

/** Structured operation lifecycle command compiled by the selected dialect. */
export type OperationCommand =
  | Readonly<{ kind: 'ping' }>
  | Readonly<{ kind: 'begin'; isolationLevel?: 'serializable'; behavior?: 'immediate' }>
  | Readonly<{ kind: 'commit' | 'rollback' }>
  | Readonly<{
      kind: 'createSavepoint' | 'rollbackToSavepoint' | 'releaseSavepoint'
      id: number
    }>

/** Adapts a selected connector and compiles its operation lifecycle commands. */
export type DialectOperations = Readonly<{
  /**
   * Creates the connector's provider for exclusive native operation sessions.
   *
   * @param connector - Connector that owns native connection resources.
   * @param dialectId - ID of the selected Dialect member for driver errors.
   *
   * @returns The connector's provider for exclusive native operation sessions.
   */
  createSessionProvider(connector: Connector, dialectId: string): OperationSessionProvider
  /**
   * Compiles the current query or command into SQL and ordered bound parameters.
   *
   * @param command - Portable operation lifecycle command to compile.
   *
   * @returns Compiled SQL and bound values in emitted order.
   */
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
  | { readonly kind: 'scalar'; readonly query: SelectAst }
  | { readonly kind: 'outer'; readonly ref: ColumnExprAst }
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
  | { readonly kind: 'exists'; readonly query: SelectAst }
  | { readonly kind: 'inQuery'; readonly left: SqlExprAst; readonly query: SelectAst }
  | {
      readonly kind: 'exprCmp'
      readonly left: SqlExprAst
      readonly op: ComparisonOp
      readonly right: SqlExprAst | { readonly kind: 'value'; readonly value: unknown }
    }
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
  readonly nulls?: 'first' | 'last'
}

/** Join clause with a resolved ON predicate. */
export type JoinAst = {
  readonly type: 'inner' | 'left' | 'right'
  readonly relation: RelationIdentityInput
  readonly on: PredicateAst
  /** Reference intent retained for occurrence-specific physical-session validation. */
  readonly reference?: Readonly<{
    relation: RelationIdentityInput
    occurrence: RelationIdentityInput
  }>
}

export type SelectAst = {
  readonly kind: 'select'
  /** A compound owns its operands and its own ordering and pagination. */
  readonly compound?: Readonly<{
    operator: 'union' | 'union all' | 'intersect' | 'except'
    left: SelectAst
    right: SelectAst
  }>
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
  | {
      readonly kind: 'projection'
      readonly columns: readonly Readonly<{ column: string; alias: string }>[]
    }

/** One assignment in an insert conflict update action. */
export type InsertConflictAssignmentAst = Readonly<{
  column: string
  value:
    | Readonly<{ kind: 'value'; value: unknown }>
    | Readonly<{ kind: 'excluded'; column: string }>
}>

/** Structured insert conflict target and action. */
export type InsertConflictAst = Readonly<{
  target: readonly string[]
  action:
    | Readonly<{ kind: 'doNothing' }>
    | Readonly<{
        kind: 'doUpdate'
        set: readonly InsertConflictAssignmentAst[]
      }>
}>

export type InsertAst = {
  readonly kind: 'insert'
  readonly relation: RelationIdentityInput
  /** Column names shared by every values row (order fixed). */
  readonly columns: readonly string[]
  /** One or more value tuples aligned with `columns`. */
  readonly values: readonly (readonly unknown[])[]
  readonly conflict?: InsertConflictAst
  readonly returning?: ReturningAst
}

export type UpdateAst = {
  readonly kind: 'update'
  readonly relation: RelationIdentityInput
  readonly set: readonly (
    | { readonly column: string; readonly value: unknown; readonly addition?: never }
    | {
        readonly column: string
        readonly addition: { readonly source: string; readonly delta: number }
        readonly value?: never
      }
  )[]
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
 * Production adapters implement every facet; test-only adapters may expose explicit
 * unsupported stubs for capabilities outside their contract.
 */
export interface Dialect {
  readonly id: string

  /** Interprets native failures using only this member's reliable diagnostics. */
  readonly classifyDriverError: DriverErrorClassifier

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
