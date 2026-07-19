import type { ColumnRef } from '@/types'
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
  return table
    ? { column: columnName(column), table }
    : { column: columnName(column) }
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

/** Comparison predicate: `eq(User.email, 'a@b.com')` or `eq(Post.userId, User.id)`. */
export function eq(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'eq', value)
}

export function neq(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'neq', value)
}

export function gt(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'gt', value)
}

export function gte(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'gte', value)
}

export function lt(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'lt', value)
}

export function lte(column: ColumnRef | string, value: unknown): PredicateAst {
  return cmpLeaf(column, 'lte', value)
}

/** Combine predicates with AND. */
export function and(...preds: PredicateAst[]): PredicateAst {
  if (preds.length === 0) {
    throw new Error('and() requires at least one predicate')
  }
  if (preds.length === 1) return preds[0]!
  return { kind: 'and', preds }
}

/** Combine predicates with OR. */
export function or(...preds: PredicateAst[]): PredicateAst {
  if (preds.length === 0) {
    throw new Error('or() requires at least one predicate')
  }
  if (preds.length === 1) return preds[0]!
  return { kind: 'or', preds }
}

/** Negate a predicate. */
export function not(pred: PredicateAst): PredicateAst {
  return { kind: 'not', pred }
}

/** `count(*)` aggregate. */
export function countAll(): AggregateExprAst {
  return { kind: 'count_all' }
}

/** `count(column)` aggregate. */
export function count(column: ColumnRef | string): AggregateExprAst {
  return { kind: 'count', arg: colRef(column) }
}

export function min(column: ColumnRef | string): AggregateExprAst {
  return { kind: 'min', arg: colRef(column) }
}

export function max(column: ColumnRef | string): AggregateExprAst {
  return { kind: 'max', arg: colRef(column) }
}

export function sum(column: ColumnRef | string): AggregateExprAst {
  return { kind: 'sum', arg: colRef(column) }
}

export function lower(column: ColumnRef | string): StringFnExprAst {
  return { kind: 'lower', arg: colRef(column) }
}

export function upper(column: ColumnRef | string): StringFnExprAst {
  return { kind: 'upper', arg: colRef(column) }
}

export function length(column: ColumnRef | string): StringFnExprAst {
  return { kind: 'length', arg: colRef(column) }
}

export function now(): DateFnExprAst {
  return { kind: 'now' }
}

export function dateTrunc(
  unit: string,
  column: ColumnRef | string,
): DateFnExprAst {
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

/** Build a comparison leaf from column/op/value (value may be a column ref). */
export function cmp(
  column: ColumnRef | string,
  op: ComparisonOp,
  value: unknown,
): PredicateAst {
  return cmpLeaf(column, op, value)
}

export { columnName, columnTable, colRef, isColumnRef, toQualified }
