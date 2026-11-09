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
import { QueryError } from '@/utils/error'

import { nestedQuery } from './subquery'
import type {
  ScalarExpression,
  ScalarValue,
  SelectQuery,
  SingleProjection,
} from './subquery'

/**
 * Checks whether a value is a column reference.
 *
 * @example
 *   isColumnRef(User.id) // true
 *
 * @param value - Value to inspect.
 */
function isColumnRef(value: unknown): value is ColumnRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    'column' in value &&
    'relation' in value &&
    '__type' in value
  )
}

/**
 * Converts a column reference or name into a column expression.
 *
 * @example
 *   colRef(User.id)
 *
 * @param column - Column reference or unqualified name.
 */
function colRef<C extends ColumnRef | string>(
  column: C,
): ColumnExprAst & {
  column: C extends ColumnRef<string, infer N> ? N : C
} & (C extends ColumnRef<string, string, infer V>
    ? { readonly __value?: V; readonly __source?: C }
    : unknown)

function colRef(column: ColumnRef | string): ColumnExprAst {
  if (typeof column === 'string') return { kind: 'column', column }

  return {
    kind: 'column',
    column: column.column,
    relation: column.relation,
  }
}

/**
 * Gets the column name from a reference or string.
 *
 * @example
 *   columnName(User.id) // 'id'
 *
 * @param column - Column reference or name.
 */
function columnName(column: ColumnRef | string): string {
  return typeof column === 'string' ? column : column.column
}

/**
 * Gets the authored relation intent from a column reference.
 *
 * @example
 *   columnRelation(User.id) // { relation: 'users' }
 *
 * @param column - Column reference or name.
 */
function columnRelation(column: ColumnRef | string): ColumnRef['relation'] | undefined {
  return typeof column === 'string' ? undefined : column.relation
}

/**
 * Converts a column reference or name into a qualified-column AST node.
 *
 * @example
 *   toQualified(User.id)
 *
 * @param column - Column reference or unqualified name.
 */
function toQualified(column: ColumnRef | string): QualifiedColumnAst {
  const relation = columnRelation(column)
  return relation
    ? {
        column: columnName(column),
        relation,
      }
    : { column: columnName(column) }
}

/**
 * Builds a comparison predicate leaf.
 *
 * @param column - Left-hand column reference or name.
 * @param op - Comparison operator.
 * @param value - Literal value or right-hand column reference.
 */
function cmpLeaf(
  column: ColumnRef | string | SqlExprAst,
  op: ComparisonOp,
  value: unknown,
): PredicateAst {
  if (isExpression(column) || isExpression(value)) {
    return {
      kind: 'exprCmp',
      left: operand(column),
      op,
      right:
        isColumnRef(value) || isExpression(value)
          ? operand(value)
          : { kind: 'value', value },
    }
  }

  const left = toQualified(column)

  if (isColumnRef(value)) {
    return {
      kind: 'cmp',
      column: left.column,
      ...(left.relation !== undefined ? { relation: left.relation } : {}),
      op,
      right: toQualified(value),
    }
  }

  return {
    kind: 'cmp',
    column: left.column,
    ...(left.relation !== undefined ? { relation: left.relation } : {}),
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
function eq<L extends ColumnRef | string | ScalarExpression | OuterExpression, R>(
  column: L,
  value: R & CompatibleOperands<L, R>,
): PredicateAst {
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
function neq<L extends ColumnRef | string | ScalarExpression | OuterExpression, R>(
  column: L,
  value: R & CompatibleOperands<L, R>,
): PredicateAst {
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
function gt<L extends ColumnRef | string | ScalarExpression | OuterExpression, R>(
  column: L,
  value: R & CompatibleOperands<L, R>,
): PredicateAst {
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
function gte<L extends ColumnRef | string | ScalarExpression | OuterExpression, R>(
  column: L,
  value: R & CompatibleOperands<L, R>,
): PredicateAst {
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
function lt<L extends ColumnRef | string | ScalarExpression | OuterExpression, R>(
  column: L,
  value: R & CompatibleOperands<L, R>,
): PredicateAst {
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
function lte<L extends ColumnRef | string | ScalarExpression | OuterExpression, R>(
  column: L,
  value: R & CompatibleOperands<L, R>,
): PredicateAst {
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
function and(...preds: PredicateAst[]): PredicateAst {
  if (preds.length === 0)
    throw new QueryError({ message: 'and() requires at least one predicate' })

  if (preds.length === 1) return preds[0]

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
function or(...preds: PredicateAst[]): PredicateAst {
  if (preds.length === 0)
    throw new QueryError({ message: 'or() requires at least one predicate' })

  if (preds.length === 1) return preds[0]

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
function not(pred: PredicateAst): PredicateAst {
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
function countAll(): AggregateExprAst {
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
function count(column: ColumnRef | string): AggregateExprAst {
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
function min(column: ColumnRef | string): AggregateExprAst {
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
function max(column: ColumnRef | string): AggregateExprAst {
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
function sum(column: ColumnRef | string): AggregateExprAst {
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
function lower(column: ColumnRef | string): StringFnExprAst {
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
function upper(column: ColumnRef | string): StringFnExprAst {
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
function length(column: ColumnRef | string): StringFnExprAst {
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
function now(): DateFnExprAst {
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
function dateTrunc(unit: string, column: ColumnRef | string): DateFnExprAst {
  return { kind: 'date_trunc', unit, arg: colRef(column) }
}

/** Expression builder passed to select/where/having/join-on callbacks. */
type ExpressionBuilder = {
  /**
   * Converts a column name or reference into a scalar column expression.
   *
   * @param column - Column reference or authored name used to address the query member.
   *
   * @returns A scalar column-expression AST for the supplied name or reference.
   */
  ref: typeof colRef
  scalar: typeof scalar
  inQuery: typeof inQuery
  exists: typeof exists
  outer: typeof outer
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
  as<E extends SqlExprAst | ColumnRef, const N extends string>(
    expr: E,
    alias: N,
  ): {
    expr: E extends ColumnRef<string, string, infer V>
      ? ColumnExprAst & { readonly __value?: V; readonly __source?: E }
      : E
    alias: N
  }
}

const eb: ExpressionBuilder = {
  ref: colRef,
  scalar,
  inQuery,
  exists,
  outer,
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
  as: aliasExpression,
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
function cmp(column: ColumnRef | string, op: ComparisonOp, value: unknown): PredicateAst {
  return cmpLeaf(column, op, value)
}

type OuterExpression<T = unknown> = {
  readonly kind: 'outer'
  readonly ref: ColumnExprAst
  readonly __value?: T
}

type OperandValue<T> =
  T extends ColumnRef<string, string, infer V>
    ? V
    : T extends ScalarExpression<infer V> | OuterExpression<infer V>
      ? V
      : T

type Compatible<A, B> = unknown extends A | B
  ? never
  : [NonNullable<A>] extends [NonNullable<B>]
    ? unknown
    : [NonNullable<B>] extends [NonNullable<A>]
      ? unknown
      : never

type InvalidScalarPair<L, R> = L extends unknown
  ? R extends unknown
    ? L extends ScalarExpression
      ? Compatible<OperandValue<L>, OperandValue<R>> extends never
        ? true
        : never
      : R extends ScalarExpression
        ? Compatible<OperandValue<L>, OperandValue<R>> extends never
          ? true
          : never
        : never
    : never
  : never

type CompatibleOperands<L, R> = [InvalidScalarPair<L, R>] extends [never]
  ? unknown
  : never

const queryExpressions = new WeakSet()

function isExpression(value: unknown): value is SqlExprAst {
  return typeof value === 'object' && value !== null && queryExpressions.has(value)
}

function rememberExpression<T extends SqlExprAst>(expression: T): T {
  queryExpressions.add(expression)
  return expression
}

function operand(value: ColumnRef | string | SqlExprAst): SqlExprAst {
  return isExpression(value) ? value : colRef(value)
}

function scalar<Q extends SelectQuery>(
  query: Q & SingleProjection<Q>,
): ScalarExpression<ScalarValue<Q>> {
  return rememberExpression({ kind: 'scalar', query: nestedQuery(query) })
}

function exists(query: SelectQuery): PredicateAst {
  return { kind: 'exists', query: nestedQuery(query) }
}

function inQuery<C extends ColumnRef, Q extends SelectQuery>(
  column: C,
  query: Q & SingleProjection<Q> & Compatible<OperandValue<C>, ScalarValue<Q>>,
): PredicateAst {
  return { kind: 'inQuery', left: colRef(column), query: nestedQuery(query) }
}

function outer<C extends ColumnRef>(column: C): OuterExpression<OperandValue<C>> {
  return rememberExpression({ kind: 'outer', ref: colRef(column) })
}

function aliasExpression<E extends SqlExprAst | ColumnRef, const N extends string>(
  expr: E,
  alias: N,
): {
  expr: E extends ColumnRef<string, string, infer V>
    ? ColumnExprAst & { readonly __value?: V; readonly __source?: E }
    : E
  alias: N
}

function aliasExpression(
  expr: SqlExprAst | ColumnRef,
  alias: string,
): { expr: SqlExprAst; alias: string } {
  return { expr: isColumnRef(expr) ? colRef(expr) : expr, alias }
}

export { columnName, columnRelation, colRef, isColumnRef, toQualified }

export type { ExpressionBuilder, OuterExpression }

export {
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
  eb,
  cmp,
  scalar,
  exists,
  inQuery,
  outer,
}
