import { baseTable } from '@/defineTable'
import type {
  DialectQueryResolution,
  SelectAst,
  SelectItemAst,
  SqlExprAst,
} from '@/dialects'
import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { QueryError } from '@/utils/error'

import type { ValueMapper } from './mapping'
import { queryRelationSource } from './sourceRelation'

type ResultColumn = { handle: TableHandle; column: string; scalar?: boolean }
type ProjectionUse = 'rows' | 'single' | 'discarded'

type OutputName = { sqlName: string; outputName: string }

const projections = new WeakMap<SelectAst, SelectProjection>()

/** Chooses bounded SQL names without colliding with authored output names. */
function outputAliases(names: readonly string[], discard = false): OutputName[] {
  const reserved = new Set(names)

  if (!discard && reserved.size !== names.length) {
    const duplicate = names.find((name, index) => names.indexOf(name) !== index)
    throw new QueryError({
      message: `Query output columns are ambiguous; select output column "${duplicate}" is ambiguous; alias one of the selected columns`,
    })
  }

  let sequence = 0
  return names.map((outputName) => {
    let sqlName = outputName
    const encoded = new TextEncoder().encode(outputName)

    if (
      outputName.length === 0 ||
      encoded.length > 63 ||
      outputName.includes('\0') ||
      new TextDecoder().decode(encoded) !== outputName
    ) {
      do {
        sqlName = `__stratom_c${sequence++}`
      } while (reserved.has(sqlName))

      reserved.add(sqlName)
    }

    return { sqlName, outputName }
  })
}

/** Finds source provenance before physical column names replace application names. */
function sourceHandle(query: DialectQueryResolution, relation: RelationIdentityInput) {
  const source = queryRelationSource(relation)

  if (source) return source

  const matches = query.findRelationMatches(relation)

  if (matches.length > 1) throw new QueryError({ message: 'Query relation is ambiguous' })

  return matches[0]
}

/** Reads the original column through nested scalar projections and resolved outer refs. */
function projectionSource(
  expr: SqlExprAst,
  query: DialectQueryResolution,
  relation?: RelationIdentityInput,
): ResultColumn | undefined {
  if (expr.kind === 'scalar') return prepareSelectProjection(expr.query, query).source
  if (expr.kind !== 'column') return undefined

  const selected = expr.relation ?? relation
  const handle = selected && sourceHandle(query, selected)
  return handle ? { handle, column: expr.column } : undefined
}

/** Expands known wildcard sources while preserving unregistered dialect ASTs. */
function expandSelection(
  node: SelectAst,
  query: DialectQueryResolution,
): SelectItemAst[] {
  const relations = [node.relation, ...(node.joins ?? []).map((join) => join.relation)]
  return (node.selection.length ? node.selection : [{ kind: 'all' as const }]).flatMap(
    (item): SelectItemAst[] => {
      if (item.kind !== 'all') return [item]

      const selected = item.relation ? [item.relation] : relations
      const handles = selected.map((relation) => sourceHandle(query, relation))

      if (handles.some((handle) => !handle)) return [item]

      return handles.flatMap((handle, index) =>
        Object.keys(handle.getSchema().entries).map((column) => ({
          kind: 'column' as const,
          relation: selected[index],
          column,
          alias: column,
        })),
      )
    },
  )
}

/** One projection owns expansion, source provenance, SQL names and result conversion. */
class SelectProjection {
  readonly node: SelectAst
  readonly outputs: OutputName[]
  readonly resultNames: OutputName[]
  readonly source: ResultColumn | undefined
  private readonly columns = new Map<string, ResultColumn>()

  constructor(node: SelectAst, query: DialectQueryResolution, use: ProjectionUse) {
    const selection = expandSelection(node, query)

    if (use === 'single' && selection.length !== 1)
      throw new QueryError({
        message: 'Scalar and IN subqueries require exactly one projected value',
      })

    this.node = { ...node, selection }
    this.outputs = outputAliases(
      selection.map((item) =>
        item.kind === 'all'
          ? '*'
          : (item.alias ?? (item.kind === 'column' ? item.column : '')),
      ),
      use === 'discarded',
    )
    this.resultNames = this.outputs.filter(
      ({ sqlName, outputName }) => sqlName !== outputName,
    )
    const sources = selection.map((item) =>
      item.kind === 'all'
        ? undefined
        : projectionSource(
            item.kind === 'column' ? item : item.expr,
            query,
            node.relation,
          ),
    )

    this.source = sources[0]

    for (const [index, source] of sources.entries()) {
      if (!source) continue

      const item = selection[index]
      this.columns.set(
        this.outputs[index].outputName,
        item.kind === 'expr' && item.expr.kind === 'scalar'
          ? { ...source, scalar: true }
          : source,
      )
    }
  }

  /** Applies each selected source mapper once, leaving absent scalar values as NULL. */
  mapRows(mapper: ValueMapper, rows: unknown[]): unknown[] {
    return rows.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return row

      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          const source = this.columns.get(key)
          return [
            key,
            source && !(source.scalar && value === null)
              ? mapper.mapResultValue(baseTable(source.handle), source.column, value)
              : value,
          ]
        }),
      )
    })
  }
}

/**
 * Reuses projection decisions for internal prepared copies. Caller-authored ASTs are
 * never cached, so direct compilation can reuse them across query resolutions.
 */
function prepareSelectProjection(
  node: SelectAst,
  query: DialectQueryResolution,
  use: ProjectionUse = 'rows',
): SelectProjection {
  let projection = projections.get(node)

  if (!projection) {
    projection = new SelectProjection(node, query, use)
    projections.set(projection.node, projection)
  }

  return projection
}

export type { ProjectionUse }

export { outputAliases, prepareSelectProjection, projectionSource }
