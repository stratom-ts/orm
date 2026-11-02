import type { PredicateAst } from '@/dialects'
import type { ColumnRef } from '@/types'
import { QueryError } from '@/utils/error'

import { and, eq, gt, isColumnRef, lt, neq, or } from './expressions'

/** One keyset sort term. Match its direction and null placement in ORDER BY. */
type OrderTerm = {
  readonly column: ColumnRef | string
  readonly direction: 'asc' | 'desc'
  readonly nulls: 'first' | 'last'
}

/**
 * Selects rows strictly after a cursor. Include a unique, nonnullable tie-breaker.
 *
 * @param order - Sort terms matching the query's ORDER BY clauses.
 * @param values - Application cursor values in sort-term order.
 */
function after(order: readonly OrderTerm[], values: readonly unknown[]): PredicateAst {
  return keysetBoundary(order, values, true)
}

/**
 * Selects rows strictly before a cursor without reversing the query's ordering.
 *
 * @param order - Sort terms including a unique, nonnullable tie-breaker.
 * @param values - Application cursor values in sort-term order.
 */
function before(order: readonly OrderTerm[], values: readonly unknown[]): PredicateAst {
  return keysetBoundary(order, values, false)
}

/** Builds a lexicographic boundary from ordinary mapped comparison predicates. */
function keysetBoundary(
  order: readonly OrderTerm[],
  values: readonly unknown[],
  after: boolean,
): PredicateAst {
  if (order.length === 0 || order.length !== values.length) {
    throw new QueryError({
      message: 'Keyset order must be nonempty and match the cursor length',
    })
  }

  const branches: PredicateAst[] = []
  const prefix: PredicateAst[] = []
  for (let index = 0; index < order.length; index++) {
    const term = order[index]
    const value = values[index]
    validateTerm(term, value)

    const strict = strictBoundary(term, value, after)

    if (strict) branches.push(and(...prefix, strict))

    prefix.push(eq(term.column, value))
  }

  if (branches.length > 0) return or(...branches)

  const column = order[0].column
  return and(eq(column, null), neq(column, null))
}

/** Validates descriptors that can arrive from JavaScript callers. */
function validateTerm(term: unknown, value: unknown): asserts term is OrderTerm {
  if (
    typeof term !== 'object' ||
    term === null ||
    !('column' in term) ||
    !(typeof term.column === 'string'
      ? term.column.length > 0
      : isColumnRef(term.column)) ||
    !('direction' in term) ||
    (term.direction !== 'asc' && term.direction !== 'desc') ||
    !('nulls' in term) ||
    (term.nulls !== 'first' && term.nulls !== 'last') ||
    value === undefined
  ) {
    throw new QueryError({
      message:
        'Keyset terms require a column, direction, null placement, and defined cursor value',
    })
  }
}

/**
 * Builds one strict comparison, including the null partition when it lies beyond the
 * cursor.
 */
function strictBoundary(
  term: OrderTerm,
  value: unknown,
  after: boolean,
): PredicateAst | undefined {
  const nullOnBoundarySide = after === (term.nulls === 'last')

  if (value === null) return nullOnBoundarySide ? undefined : neq(term.column, null)

  const comparison = (after === (term.direction === 'asc') ? gt : lt)(term.column, value)

  return nullOnBoundarySide ? or(comparison, eq(term.column, null)) : comparison
}

export type { OrderTerm }

export { after, before }
