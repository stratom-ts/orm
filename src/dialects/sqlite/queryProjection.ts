import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { QueryError } from '@/utils/error'

import type {
  DialectQueryResolution,
  PredicateAst,
  SelectAst,
  SelectItemAst,
  SqlAst,
  SqlExprAst,
} from '../types'

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
export function projectSqliteQuery(
  query: DialectQueryResolution,
  authored: SqlAst,
): SqlAst {
  const node = projectNestedQueries(query, authored)

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

/** Applies the same authored output-name rules in every nested select. */
function projectNestedQueries(query: DialectQueryResolution, node: SqlAst): SqlAst {
  if (node.kind === 'insert') return node

  const where = node.where ? projectPredicate(query, node.where) : undefined

  if (node.kind !== 'select') return { ...node, ...(where ? { where } : {}) }

  return {
    ...node,
    selection: node.selection.map((item) =>
      item.kind === 'expr'
        ? { ...item, expr: projectExpression(query, item.expr) }
        : item,
    ),
    ...(where ? { where } : {}),
    ...(node.having ? { having: projectPredicate(query, node.having) } : {}),
    ...(node.joins
      ? {
          joins: node.joins.map((join) => ({
            ...join,
            on: projectPredicate(query, join.on),
          })),
        }
      : {}),
  }
}

function projectExpression(query: DialectQueryResolution, expr: SqlExprAst): SqlExprAst {
  return expr.kind === 'scalar'
    ? { ...expr, query: projectSqliteQuery(query, expr.query) as SelectAst }
    : expr
}

function projectPredicate(
  query: DialectQueryResolution,
  pred: PredicateAst,
): PredicateAst {
  if (pred.kind === 'exists' || pred.kind === 'inQuery')
    return { ...pred, query: projectSqliteQuery(query, pred.query) as SelectAst }

  if (pred.kind === 'and' || pred.kind === 'or')
    return { ...pred, preds: pred.preds.map((p) => projectPredicate(query, p)) }

  if (pred.kind === 'not') return { ...pred, pred: projectPredicate(query, pred.pred) }

  if (pred.kind === 'exprCmp')
    return {
      ...pred,
      left: projectExpression(query, pred.left),
      right:
        pred.right.kind === 'value' ? pred.right : projectExpression(query, pred.right),
    }

  return pred
}
