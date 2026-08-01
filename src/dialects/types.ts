import { SQLDialect } from 'db0'

import type {
  NamespaceContext,
  RelationIdentityAdapter,
} from '@/migrations/canonicalRelationIdentity'
import type { ReferentialAction } from '@/schemas/actions/types'
import type { AnySchema } from '@/types/schema'

/** SQL type string produced by dialect type inference. */
export type SqlDataType = string

/** Parameterized SQL produced by dialect compilation. */
export type CompiledQuery = {
  sql: string
  params: unknown[]
}

/** Live column entry from dialect introspection. */
export type CatalogColumn = {
  name: string
  dataType: string
  isNullable: boolean
  hasDefault?: boolean
  isIdentity?: boolean
  /** Normalized SQL expression; null means no default, undefined means unknown. */
  defaultExpression?: string | null
  /** Null means not an identity, undefined means unknown. */
  identityGeneration?: 'always' | 'byDefault' | null
}

export type CatalogKeyConstraint = {
  name: string
  columns: string[]
  semanticCompleteness: 'supportedSimple' | 'unsupported'
  /** False for catalog objects that PostgreSQL will not enforce for all rows. */
  isValid: boolean
}

export type CatalogForeignKey = CatalogKeyConstraint & {
  /** PostgreSQL schema of the referenced catalog relation. */
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onDelete: ReferentialAction
  onUpdate: ReferentialAction
}

/** Live index entry from dialect introspection. */
export type CatalogIndex = {
  name: string
  columns: string[]
  unique: boolean
  semanticCompleteness: 'supportedSimple' | 'unsupported'
  /** False for invalid/not-ready PostgreSQL indexes. */
  isValid: boolean
}

/** Live table entry from dialect introspection. */
export type CatalogTable = {
  name: string
  /** PostgreSQL schema of the catalog relation. */
  schema: string
  columns: CatalogColumn[]
  indexes?: CatalogIndex[]
  /** Undefined means the dialect did not introspect this managed property. */
  primaryKey?: CatalogKeyConstraint | null
  uniqueConstraints?: CatalogKeyConstraint[]
  foreignKeys?: CatalogForeignKey[]
}

/** Catalog snapshot for desired-state migrations. */
export type CatalogSnapshot = {
  tables: CatalogTable[]
  /** Complete transitional reservation set; empty means positively no reserved names. */
  nameReservations: Array<{ schema: string; name: string }>
  /** Complete table-local constraint-name set; empty means positively none. */
  constraintNameReservations: Array<{ schema: string; table: string; name: string }>
  /**
   * Writable namespace facts resolved on the introspection session. Required because
   * migration identity never assumes a shared namespace fallback.
   */
  namespaceContext: NamespaceContext
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

/**
 * Full single-table select AST (replaces legacy `select_all` at compile time).
 * `kind: 'select_all'` remains as a thin alias for select * with no clauses.
 */
export type SelectAllAst = {
  readonly kind: 'select_all'
  readonly table: string
  readonly schema?: string
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
  | SelectAllAst
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
export interface Dialect {
  readonly id: SQLDialect

  /** Required adapter profile used by canonical migration relation identity. */
  readonly relationIdentity: RelationIdentityAdapter

  inferColumnType(schema: AnySchema): SqlDataType

  normalizeDataType(dataType: string): string

  /** Canonical SQL expression used to compare a declared column default. */
  normalizeDefaultValue?(value: string | number | boolean | null): string

  introspect(executor: unknown): Promise<CatalogSnapshot>

  compile(node: SqlAst): CompiledQuery

  mapResultValue?(dataType: string, value: unknown): unknown
  mapParamValue?(dataType: string, value: unknown): unknown
}
