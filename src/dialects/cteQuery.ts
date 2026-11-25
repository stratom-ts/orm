import { QueryError } from '@/utils/error'

import type { CteRelationAst, SelectAst, SelectCteAst } from './types'

/** CTE addressing bypasses physical namespaces, registration defaults and session guards. */
function isCteRelation(value: unknown): value is CteRelationAst {
  return (
    typeof value === 'object' && value !== null && 'cte' in value && value.cte === true
  )
}

/** Emits definitions and the consuming SELECT into the same ordered binding stream. */
function compileWithSelect(
  node: SelectAst,
  compile: (query: SelectAst) => string,
  quote: (name: string) => string,
): string {
  const definitions = node.with!
  const names = new Set<string>()
  const clauses = definitions.map((definition) => {
    const { name, columns, initial, recursive } = definition

    if (!name.length || name.includes('\0') || names.has(name))
      throw new QueryError({
        message: 'CTE definition names must be nonempty and unique',
      })

    names.add(name)

    if (!columns.length || new Set(columns).size !== columns.length)
      throw new QueryError({ message: 'CTE output columns must be nonempty and unique' })

    if (recursive) validateRecursiveTerms(definition)

    const left = compile(initial)
    const body = recursive
      ? `${left} ${recursive.union === 'distinct' ? 'union' : 'union all'} ${compile(recursive.query)}`
      : left

    return `${quote(name)} (${columns.map(quote).join(', ')}) as (${body})`
  })

  const recursive = definitions.some((definition) => definition.recursive)
  const { with: _, ...body } = node
  return `with${recursive ? ' recursive' : ''} ${clauses.join(', ')} ${compile(body)}`
}

/** Rejects recursive shapes outside the shared PostgreSQL/SQLite SELECT subset. */
function validateRecursiveTerms(definition: SelectCteAst): void {
  const { initial, recursive, name } = definition

  if (!recursive) return

  for (const term of [initial, recursive.query]) {
    if (
      term.compound ||
      term.with?.length ||
      term.orderBy?.length ||
      term.limit !== undefined ||
      term.offset !== undefined
    )
      throw new QueryError({
        message:
          'Recursive CTE terms cannot use set operations, WITH, ordering or pagination',
      })
  }

  const isSelf = (value: unknown) => isCteRelation(value) && value.relation === name

  if (contains(initial, isSelf))
    throw new QueryError({ message: 'Recursive CTE initial term cannot reference self' })

  const query = recursive.query
  const sources = [query.relation, ...(query.joins ?? []).map((join) => join.relation)]

  if (sources.filter(isSelf).length !== 1)
    throw new QueryError({
      message: 'Recursive CTE term requires exactly one direct self source',
    })

  if (query.joins?.some((join) => join.type !== 'inner'))
    throw new QueryError({ message: 'Recursive CTE terms support inner joins only' })

  if (
    query.groupBy?.length ||
    query.having ||
    contains(
      query.selection,
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        'kind' in value &&
        ['count_all', 'count', 'sum', 'min', 'max'].includes(String(value.kind)),
    )
  )
    throw new QueryError({
      message: 'Recursive CTE terms cannot use grouping or aggregates',
    })

  if (
    contains(
      query,
      (value) => value !== query && isSelect(value) && contains(value, isSelf),
    )
  )
    throw new QueryError({ message: 'Recursive CTE self cannot occur in a subquery' })
}

function isSelect(value: unknown): value is SelectAst {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'select'
  )
}

/** Traverses SQL structure only; bound application values are opaque. */
function contains(value: unknown, matches: (value: unknown) => boolean): boolean {
  if (matches(value)) return true
  if (!value || typeof value !== 'object') return false

  return Object.entries(value).some(
    ([key, child]) => key !== 'value' && key !== 'values' && contains(child, matches),
  )
}

export { compileWithSelect, isCteRelation }
