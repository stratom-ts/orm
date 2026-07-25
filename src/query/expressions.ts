import type {
  AggregateExprAst,
  ColumnExprAst,
  ComparisonOp,
  DateFnExprAst,
  PredicateAst,
  QualifiedColumnAst,
  SqlExprAst,
  StringFnExprAst,
} from '@/dialects'
import type { ColumnRef } from '@/types'

function isColumnRef(value: unknown): value is ColumnRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'column' in value &&
    'table' in value &&
    '__type' in value
  )
}

function colRef(column: ColumnRef | string): ColumnExprAst {
  if (typeof column === 'string') {
    return { kind: 'column', column }
  }
  return { kind: 'column', column: column.column, table: column.table }
}

function columnName(column: ColumnRef | string): string {
  return typeof column === 'string' ? column : column.column
}

function columnTable(column: ColumnRef | string): string | undefined {
  return typeof column === 'string' ? undefined : column.table
}

function toQualified(column: ColumnRef | string): QualifiedColumnAst {
  const table = columnTable(column)
  return table ? { column: columnName(column), table } : { column: columnName(column) }
}

function cmpLeaf(
  column: ColumnRef | string,
  op: ComparisonOp,
  value: unknown,
): PredicateAst {
  const left = toQualified(column)
  if (isColumnRef(value)) {
    return {
      kind: 'cmp',
      column: left.column,
      ...(left.table !== undefined ? { table: left.table } : {}),
      op,
      right: toQualified(value),
    }
  }
  return {
    kind: 'cmp',
    column: left.column,
    ...(left.table !== undefined ? { table: left.table } : {}),
    op,
    value,
  }
}

/**
 * Comparison predicate: `eq(User.email, 'a@b.com')` or `eq(Post.userId, User.id)`.
 *
 * @example
 *   eq(User.email, 'alice@example.com')
 *   eq(User.id, Post.userId)
 *
 * @param column - Column reference or name.
 * @param value - Comparison value (literal or another column ref).
 *
 * @returns Equality predicate AST node
 */
export function eq(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'eq', value)
}

/**
 * Not-equal comparison predicate.
 *
 * @example
 *   neq(User.email, 'deleted@example.com')
 *
 * @param column - Column reference or name.
 * @param value - Comparison value (literal or another column ref).
 *
 * @returns Not-equal predicate AST node
 */
export function neq(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'neq', value)
}

/**
 * Greater-than comparison predicate.
 *
 * @example
 *   gt(User.age, 18)
 *
 * @param column - Column reference or name.
 * @param value - Comparison value (literal or another column ref).
 *
 * @returns Greater-than predicate AST node
 */
export function gt(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'gt', value)
}

/**
 * Greater-than-or-equal comparison predicate.
 *
 * @example
 *   gte(User.age, 18)
 *
 * @param column - Column reference or name.
 * @param value - Comparison value (literal or another column ref).
 *
 * @returns Greater-than-or-equal predicate AST node
 */
export function gte(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'gte', value)
}

/**
 * Less-than comparison predicate.
 *
 * @example
 *   lt(User.age, 65)
 *
 * @param column - Column reference or name.
 * @param value - Comparison value (literal or another column ref).
 *
 * @returns Less-than predicate AST node
 */
export function lt(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'lt', value)
}

/**
 * Less-than-or-equal comparison predicate.
 *
 * @example
 *   lte(User.age, 65)
 *
 * @param column - Column reference or name.
 * @param value - Comparison value (literal or another column ref).
 *
 * @returns Less-than-or-equal predicate AST node
 */
export function lte(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'lte', value)
}

/**
 * Combine predicates with AND.
 *
 * @example
 *   and(eq(User.active, true), gt(User.age, 18))
 *
 * @param preds - Predicate AST nodes to combine.
 *
 * @returns AND predicate AST node
 */
export function and(...preds: PredicateAst[]): PredicateAst {
  if (preds.length === 0) {
    throw new Error('and() requires at least one predicate')
  }
  if (preds.length === 1) return preds[0]!
  return { kind: 'and', preds }
}

/**
 * Combine predicates with OR.
 *
 * @example
 *   or(eq(User.role, 'admin'), eq(User.role, 'moderator'))
 *
 * @param preds - Predicate AST nodes to combine.
 *
 * @returns OR predicate AST node
 */
export function or(...preds: PredicateAst[]): PredicateAst {
  if (preds.length === 0) {
    throw new Error('or() requires at least one predicate')
  }
  if (preds.length === 1) return preds[0]!
  return { kind: 'or', preds }
}

/**
 * Negate a predicate.
 *
 * @example
 *   not(eq(User.active, false)) // active != false
 *
 * @param pred - Predicate AST node to negate.
 *
 * @returns NOT predicate AST node
 */
export function not(pred: PredicateAst): PredicateAst {
  return { kind: 'not', pred }
}

/**
 * `count(*)` aggregate.
 *
 * @example
 *   countAll() // SELECT count(*) FROM ...
 *
 * @returns Count-all aggregate expression AST node
 */
export function countAll(): AggregateExprAst {
  return { kind: 'count_all' }
}

/**
 * `count(column)` aggregate.
 *
 * @example
 *   count(User.id) // SELECT count("users"."id") FROM ...
 *
 * @param column - Column reference or name to count.
 *
 * @returns Count aggregate expression AST node
 */
export function count(column: ColumnRef | string): AggregateExprAst {
  return { kind: 'count', arg: colRef(column) }
}

/**
 * `min(column)` aggregate.
 *
 * @example
 *   min(Order.total) // SELECT min("orders"."total") FROM ...
 *
 * @param column - Column reference or name.
 *
 * @returns Min aggregate expression AST node
 */
export function min(column: ColumnRef | string): AggregateExprAst {
  return { kind: 'min', arg: colRef(column) }
}

/**
 * `max(column)` aggregate.
 *
 * @example
 *   max(Order.total) // SELECT max("orders"."total") FROM ...
 *
 * @param column - Column reference or name.
 *
 * @returns Max aggregate expression AST node
 */
export function max(column: ColumnRef | string): AggregateExprAst {
  return { kind: 'max', arg: colRef(column) }
}

/**
 * `sum(column)` aggregate.
 *
 * @example
 *   sum(Order.total) // SELECT sum("orders"."total") FROM ...
 *
 * @param column - Column reference or name.
 *
 * @returns Sum aggregate expression AST node
 */
export function sum(column: ColumnRef | string): AggregateExprAst {
  return { kind: 'sum', arg: colRef(column) }
}

/**
 * `lower(column)` string function.
 *
 * @example
 *   lower(User.name) // SELECT lower("users"."name") FROM ...
 *
 * @param column - Column reference or name.
 *
 * @returns Lower-case string function expression AST node
 */
export function lower(column: ColumnRef | string): StringFnExprAst {
  return { kind: 'lower', arg: colRef(column) }
}

/**
 * `upper(column)` string function.
 *
 * @example
 *   upper(User.name) // SELECT upper("users"."name") FROM ...
 *
 * @param column - Column reference or name.
 *
 * @returns Upper-case string function expression AST node
 */
export function upper(column: ColumnRef | string): StringFnExprAst {
  return { kind: 'upper', arg: colRef(column) }
}

/**
 * `length(column)` string function.
 *
 * @example
 *   length(User.name) // SELECT length("users"."name") FROM ...
 *
 * @param column - Column reference or name.
 *
 * @returns Length string function expression AST node
 */
export function length(column: ColumnRef | string): StringFnExprAst {
  return { kind: 'length', arg: colRef(column) }
}

/**
 * `now()` date function.
 *
 * @example
 *   now() // SELECT now() FROM ...
 *
 * @returns Current timestamp expression AST node
 */
export function now(): DateFnExprAst {
  return { kind: 'now' }
}

/**
 * `date_trunc(unit, column)` date function.
 *
 * @example
 *   dateTrunc('day', Post.createdAt) // SELECT date_trunc($1, "posts"."created_at") FROM ...
 *
 * @param unit - Truncation unit (e.g. 'day', 'month', 'year').
 * @param column - Column reference or name.
 *
 * @returns Date truncation expression AST node
 */
export function dateTrunc(unit: string, column: ColumnRef | string): DateFnExprAst {
  return { kind: 'date_trunc', unit, arg: colRef(column) }
}

/** Expression builder passed to select/where/having/join-on callbacks. */
export type ExpressionBuilder = {
  ref(column: ColumnRef | string): ColumnExprAst
  eq: typeof eq
  neq: typeof neq
  gt: typeof gt
  gte: typeof gte
  lt: typeof lt
  lte: typeof lte
  and: typeof and
  or: typeof or
  not: typeof not
  countAll: typeof countAll
  count: typeof count
  min: typeof min
  max: typeof max
  sum: typeof sum
  lower: typeof lower
  upper: typeof upper
  length: typeof length
  now: typeof now
  dateTrunc: typeof dateTrunc
  /** Alias an expression for select lists. */
  as(expr: SqlExprAst, alias: string): { expr: SqlExprAst; alias: string }
}

export const eb: ExpressionBuilder = {
  ref: colRef,
  eq,
  neq,
  gt,
  gte,
  lt,
  lte,
  and,
  or,
  not,
  countAll,
  count,
  min,
  max,
  sum,
  lower,
  upper,
  length,
  now,
  dateTrunc,
  as(expr, alias) {
    return { expr, alias }
  },
}

/**
 * Build a comparison leaf from column/op/value (value may be a column ref).
 *
 * @example
 *   cmp(User.age, 'gt', 18)
 *   cmp(User.id, 'eq', Post.userId)
 *
 * @param column - Column reference or name.
 * @param op - Comparison operator (eq, neq, gt, gte, lt, lte).
 * @param value - Comparison value (literal or another column ref).
 *
 * @returns Comparison predicate AST node
 */
export function cmp(
  column: ColumnRef | string,
  op: ComparisonOp,
  value: unknown,
): PredicateAst {
  return cmpLeaf(column, op, value)
}

export { columnName, columnTable, colRef, isColumnRef, toQualified }
