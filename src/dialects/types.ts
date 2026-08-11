import { SQLDialect } from 'db0'

import type { DialectMigrationAdapter } from '@/ddl/migrationProgram'
import type {
  CanonicalRelationIdentity,
  RelationIdentityAdapter,
} from '@/migrations/canonicalRelationIdentity'
import type {
  ColumnMetadata,
  ReferenceMetadata,
  TableMetadata,
} from '@/schemas/actions/types'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'

import type { CatalogIntrospector } from './catalog'

export type * from './catalog'

/** SQL type string produced by dialect type inference. */
export type SqlDataType = string

/** Logical and physical context supplied to dialect value mappers. */
export type DialectMappingContext = Readonly<{
  /** Resolved physical declaration (for example `TEXT` or `jsonb`). */
  dataType: string
  /** Authored schema, when mapping is for a registered column. */
  schema?: AnySchema
  /** Authored column name, when known. */
  column?: string
  /** Column metadata, when present. */
  metadata?: ColumnMetadata
}>

/** One canonically registered authored column before physical lowering. */
export type AuthoredDesiredColumn = Readonly<{
  name: string
  schema: AnySchema
  metadata?: ColumnMetadata
  reference?: Readonly<{
    metadata: ReferenceMetadata
    targetRelation: CanonicalRelationIdentity
    targetColumn: string
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

/** One physically resolved desired table. */
export type LoweredDesiredTable = Readonly<{
  handle: TableHandle
  identity: CanonicalRelationIdentity
  ast: CreateTableAst
}>

/** Immutable selected-adapter result for the complete desired graph. */
export type LoweredDesiredSchema = Readonly<{
  tables: readonly LoweredDesiredTable[]
}>

/** Parameterized SQL produced by dialect compilation. */
export type CompiledQuery = {
  sql: string
  params: unknown[]
}

/** Comparison operators for simple where predicates. */
export type ComparisonOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'

/** Column reference expression. */
export type ColumnExprAst = {
  readonly kind: 'column'
  readonly column: string
  readonly table?: string
  readonly schema?: string
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
  | { readonly kind: 'all'; readonly table?: string; readonly schema?: string }
  | {
      readonly kind: 'column'
      readonly column: string
      readonly table?: string
      readonly schema?: string
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
  readonly table?: string
  readonly schema?: string
}

/**
 * Composable boolean predicate tree for where / having / join on.
 * `cmp` is either column-vs-value (`value`) or column-vs-column (`right`).
 */
export type PredicateAst =
  | {
      readonly kind: 'cmp'
      readonly column: string
      readonly table?: string
      readonly schema?: string
      readonly op: ComparisonOp
      readonly value?: unknown
      readonly right?: QualifiedColumnAst
    }
  | { readonly kind: 'and'; readonly preds: readonly PredicateAst[] }
  | { readonly kind: 'or'; readonly preds: readonly PredicateAst[] }
  | { readonly kind: 'not'; readonly pred: PredicateAst }

export type OrderByAst = {
  readonly column: string
  readonly table?: string
  readonly schema?: string
  readonly direction: 'asc' | 'desc'
}

/** Explicit join clause (no FK relation sugar). */
export type JoinAst = {
  readonly type: 'inner' | 'left' | 'right'
  readonly table: string
  readonly schema?: string
  readonly on: PredicateAst
}

export type SelectAst = {
  readonly kind: 'select'
  readonly table: string
  readonly schema?: string
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
  readonly table: string
  readonly schema?: string
  /** Column names shared by every values row (order fixed). */
  readonly columns: readonly string[]
  /** One or more value tuples aligned with `columns`. */
  readonly values: readonly (readonly unknown[])[]
  readonly returning?: ReturningAst
}

export type UpdateAst = {
  readonly kind: 'update'
  readonly table: string
  readonly schema?: string
  readonly set: readonly { readonly column: string; readonly value: unknown }[]
  /** Predicate; empty + allowAll is full-table update. */
  readonly where?: PredicateAst
  readonly allowAll: boolean
  readonly returning?: ReturningAst
}

export type DeleteAst = {
  readonly kind: 'delete'
  readonly table: string
  readonly schema?: string
  readonly where?: PredicateAst
  readonly allowAll: boolean
  readonly returning?: ReturningAst
}

export type CreateTableColumnAst = {
  readonly name: string
  readonly dataType: string
  readonly notNull: boolean
  readonly unique: boolean
  readonly uniqueConstraintName?: string
  readonly autoIncrement: boolean
  readonly defaultValue?: string | number | boolean | null
  readonly databaseDefault?: LoweredDatabaseDefault
  readonly generated?: 'always' | 'byDefault'
  readonly references?: {
    readonly table: string
    readonly column: string
    /** Postgres schema of the referenced table; omit for default (`public`). */
    readonly schema?: string
    readonly onDelete?: string
    readonly onUpdate?: string
  }
}

export type CreateTableAst = {
  readonly kind: 'create_table'
  readonly table: string
  readonly schema?: string
  readonly columns: readonly CreateTableColumnAst[]
  readonly primaryKey: readonly string[]
  readonly primaryKeyName?: string
}

export type CreateSchemaAst = {
  readonly kind: 'create_schema'
  readonly schema: string
}

export type CreateIndexAst = {
  readonly kind: 'create_index'
  readonly table: string
  readonly schema?: string
  readonly name: string
  readonly columns: readonly string[]
  readonly unique: boolean
}

export type AlterTableAddColumnAst = {
  readonly kind: 'add_column'
  readonly table: string
  readonly schema?: string
  readonly column: CreateTableColumnAst
}

export type AddForeignKeyAst = {
  readonly kind: 'add_foreign_key'
  readonly table: string
  readonly schema?: string
  readonly column: string
  readonly name?: string
  readonly references: {
    readonly table: string
    readonly column: string
    readonly schema?: string
    readonly onDelete?: string
    readonly onUpdate?: string
  }
}

export type AddUniqueConstraintAst = {
  readonly kind: 'add_unique_constraint'
  readonly table: string
  readonly schema?: string
  readonly column: string
  readonly name: string
}

export type AlterColumnTypeAst = {
  readonly kind: 'alter_column_type'
  readonly table: string
  readonly schema?: string
  readonly column: string
  readonly dataType: string
}

export type SetNotNullAst = {
  readonly kind: 'set_not_null'
  readonly table: string
  readonly schema?: string
  readonly column: string
}

export type DropNotNullAst = {
  readonly kind: 'drop_not_null'
  readonly table: string
  readonly schema?: string
  readonly column: string
}

export type DropColumnAst = {
  readonly kind: 'drop_column'
  readonly table: string
  readonly schema?: string
  readonly column: string
}

export type DropTableAst = {
  readonly kind: 'drop_table'
  readonly table: string
  readonly schema?: string
}

export type DropIndexAst = {
  readonly kind: 'drop_index'
  readonly table: string
  readonly schema?: string
  readonly index: string
}

export type SqlAst =
  | SelectAst
  | InsertAst
  | UpdateAst
  | DeleteAst
  | CreateTableAst
  | CreateSchemaAst
  | CreateIndexAst
  | AlterTableAddColumnAst
  | AddUniqueConstraintAst
  | AddForeignKeyAst
  | AlterColumnTypeAst
  | SetNotNullAst
  | DropNotNullAst
  | DropColumnAst
  | DropTableAst
  | DropIndexAst

/**
 * Dialect plugin: type mapping, introspection, and AST compilation.
 *
 * V1 ships Postgres only; introspect may be a stub until migrate tickets.
 */
export interface DialectCore {
  readonly id: SQLDialect

  /** Required adapter profile used by canonical migration relation identity. */
  readonly relationIdentity: RelationIdentityAdapter

  /** Physically resolves a complete, canonically registered desired schema graph. */
  lowerDesiredSchema(graph: AuthoredDesiredSchema): LoweredDesiredSchema

  inferColumnType(schema: AnySchema): SqlDataType

  normalizeDataType(dataType: string): string

  /** Canonical SQL expression used to compare a declared column default. */
  normalizeDefaultValue?(value: string | number | boolean | null): string

  compile(node: SqlAst): CompiledQuery

  mapResultValue?(dataType: string, value: unknown): unknown
  mapParamValue?(dataType: string, value: unknown): unknown
  /** Context-aware seam; legacy mappers continue to receive a bare type string. */
  mapResultValueContext?(context: DialectMappingContext, value: unknown): unknown
  mapParamValueContext?(context: DialectMappingContext, value: unknown): unknown
}

/** Complete dialect, including catalog and optional migration runtime support. */
export interface Dialect extends DialectCore {
  /** Deep adapter module for scoped catalog observation. */
  readonly catalog: CatalogIntrospector

  /** Whole-plan lowering and coordinated migration execution. */
  readonly migration?: DialectMigrationAdapter
}
