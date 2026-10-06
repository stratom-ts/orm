import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { QueryError } from '@/utils/error'

import type { DialectQueryResolution, SelectItemAst, SqlAst } from '../types'

/** Resolves a registered relation without silently selecting an ambiguous handle. */
function selectedHandle(
  query: DialectQueryResolution,
  relation: RelationIdentityInput,
): TableHandle | undefined {
  const matches = query.findRelationMatches(relation)

  if (matches.length > 1)
    throw new QueryError({ message: 'SQLite query relation is ambiguous' })

  return matches[0]
}

/** Expands one handle to explicit authored output names under SQLite column semantics. */
function handleColumns(
  query: DialectQueryResolution,
  handle: TableHandle,
): Extract<SelectItemAst, { kind: 'column' }>[] {
  return Object.keys(handle.getSchema().entries).map((column) => {
    if (query.findColumnMatches(handle, column).length !== 1)
      throw new QueryError({ message: 'SQLite query column is ambiguous' })

    return {
      kind: 'column',
      column,
      alias: column,
      relation: handle.getTableMetadata().relation,
    }
  })
}

/** Preserves authored result names for registered wildcard SELECT and RETURNING queries. */
export function projectSqliteQuery(query: DialectQueryResolution, node: SqlAst): SqlAst {
  if (node.kind !== 'select') {
    const handle = selectedHandle(query, node.relation)

    if (node.returning?.kind !== 'all' || !handle) return node

    const columns = handleColumns(query, handle).map((item) => item.column)

    return { ...node, returning: { kind: 'columns', columns } }
  }

  const relations = [node.relation, ...(node.joins ?? []).map((join) => join.relation)]
  const selection: SelectItemAst[] = node.selection.length
    ? [...node.selection]
    : [{ kind: 'all' }]

  const projected = selection.flatMap((item): SelectItemAst[] => {
    if (item.kind !== 'all') return [item]

    const handles = (item.relation ? [item.relation] : relations).map((relation) =>
      selectedHandle(query, relation),
    )

    if (handles.some((handle) => handle === undefined)) return [item]

    return handles.flatMap((handle) => handleColumns(query, handle!))
  })

  const names = projected.flatMap((item) =>
    item.kind === 'all'
      ? []
      : [item.alias ?? (item.kind === 'column' ? item.column : '')],
  )

  if (new Set(names).size !== names.length)
    throw new QueryError({ message: 'SQLite query output columns are ambiguous' })

  return { ...node, selection: projected }
}
