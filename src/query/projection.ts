import { baseTable, isTableHandle } from '@/defineTable'
import type {
  DialectQueryResolution,
  SelectAst,
  SelectItemAst,
  SqlExprAst,
} from '@/dialects'
import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'
import { cteAliases } from '@/types/cte'
import type { ReadSource } from '@/types/tableHandle'
import { QueryError } from '@/utils/error'

import type { ValueMapper } from './mapping'
import { queryRelationSource } from './sourceRelation'
import { nestedDefinitions, selectDefinitions } from './subquery'

const cteOutputNames = new WeakMap<object, readonly OutputName[]>()
const cteOutputSources = new WeakMap<object, readonly (ResultColumn | undefined)[]>()
function mappingSource(handle: ReadSource, column: string): ResultColumn | undefined {
  const alias = cteAliases.get(handle)

  if (alias) return mappingSource(alias, column)

  const source =
    cteOutputSources.get(handle)?.[
      Object.keys(handle.getSchema().entries).indexOf(column)
    ]

  if (source) return source
  if (isTableHandle(handle)) return { handle, column }

  return undefined
}

type ResultColumn = { handle: TableHandle; column: string; scalar?: boolean }
type ProjectionUse = 'rows' | 'single' | 'discarded'

type OutputName = { sqlName: string; outputName: string }

const projections = new WeakMap<SelectAst, SelectProjection>()

/**
 * Chooses bounded SQL names without colliding with authored output names.
 *
 * @example
 *   outputAliases(['', '__stratom_c0']) // SQL names: __stratom_c1, __stratom_c0
 *
 * @param names - Application output names in selection order.
 * @param discard - Allow duplicate names when the caller ignores projected values.
 *
 * @returns SQL and application name pairs in selection order.
 */
function outputAliases(names: readonly string[], discard = false): OutputName[] {
  const reserved = new Set(names)

  if (!discard && reserved.size !== names.length) {
    const duplicate = names.find((name, index) => names.indexOf(name) !== index)
    throw new QueryError({
      message: `Query output columns are ambiguous; select output column "${duplicate}" is ambiguous; alias one of the selected columns`,
    })
  }

  const folded = names.map((name) => name.replace(/[A-Z]/g, (char) => char.toLowerCase()))
  const reservedSqlNames = new Set(folded)
  const emitted = new Set<string>()
  let sequence = 0
  return names.map((outputName, index) => {
    let sqlName = outputName
    const encoded = new TextEncoder().encode(outputName)

    if (
      emitted.has(folded[index]) ||
      outputName.length === 0 ||
      encoded.length > 63 ||
      outputName.includes('\0') ||
      new TextDecoder().decode(encoded) !== outputName
    ) {
      do {
        sqlName = `__stratom_c${sequence++}`
      } while (reservedSqlNames.has(sqlName))

      reservedSqlNames.add(sqlName)
    }

    emitted.add(sqlName === outputName ? folded[index] : sqlName)
    return { sqlName, outputName }
  })
}

/**
 * Finds a selected relation source before physical column lowering.
 *
 * @example
 *   sourceHandle(query, node.relation)
 *
 * @param query - Resolved relation lookup and dialect compilation operations.
 * @param relation - Prepared relation occurrence or authored relation to resolve.
 *
 * @returns The registered source, or undefined for an unregistered relation.
 */
function sourceHandle(
  query: DialectQueryResolution,
  relation: RelationIdentityInput,
): ReadSource | undefined {
  const source = queryRelationSource(relation)

  if (source) return source
  if ('cte' in relation && relation.cte === true) return undefined

  const matches = query.findRelationMatches(relation)

  if (matches.length > 1) throw new QueryError({ message: 'Query relation is ambiguous' })

  return matches[0]
}

/**
 * Follows column and nested scalar outputs to their original source column.
 *
 * @example
 *   projectionSource({ kind: 'scalar', query: inner }, query)
 *
 * @param expr - Resolved expression whose value may need source-column mapping.
 * @param query - Resolved relation lookup and dialect compilation operations.
 * @param relation - Fallback relation for an unqualified column expression.
 *
 * @returns Source metadata, or undefined for expressions without a column source.
 */
function projectionSource(
  expr: SqlExprAst,
  query: DialectQueryResolution,
  relation?: RelationIdentityInput,
): ResultColumn | undefined {
  if (expr.kind === 'scalar') {
    const builder = nestedDefinitions.get(expr.query)
    const authored = builder && selectDefinitions.get(builder)
    return prepareSelectProjection(authored ? authored.build() : expr.query, query).source
  }

  if (expr.kind !== 'column') return undefined

  const selected = expr.relation ?? relation
  const handle = selected && sourceHandle(query, selected)

  if (!handle) return undefined
  if (!isTableHandle(handle)) return mappingSource(handle, expr.column)

  return { handle, column: expr.column }
}

/**
 * Expands registered wildcard sources while preserving unknown dialect relations.
 *
 * @example
 *   expandSelection({ ...node, selection: [{ kind: 'all' }] }, query)
 *
 * @param node - Select AST with application column names.
 * @param query - Resolved relation lookup and dialect compilation operations.
 *
 * @returns Selection items with known wildcards replaced by application columns.
 */
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

      if (!handles.every((handle) => handle !== undefined)) return [item]

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
  readonly sources: readonly (ResultColumn | undefined)[]
  private readonly columns = new Map<string, ResultColumn>()

  /**
   * Prepares output names and source mappings together for one select.
   *
   * @example
   *   const projection = new SelectProjection(node, query, 'single')
   *
   * @param node - Select AST with application column names.
   * @param query - Resolved relation lookup and dialect compilation operations.
   * @param use - Rows require unique names, single requires one output, and discarded
   *   permits duplicates.
   */
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

    this.sources = sources
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

  /**
   * Maps each selected source once and preserves NULL from absent scalar results.
   *
   * @example
   *   projection.mapRows(mapper, [{ latest: null }]) // Keeps the scalar NULL.
   *
   * @param mapper - Client value mapper for the original source columns.
   * @param rows - Executed rows whose SQL output names have already been restored.
   *
   * @returns Mapped rows, with scalar NULLs and non-object values preserved.
   */
  mapRows(mapper: ValueMapper, rows: unknown[]): unknown[] {
    return rows.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return row

      return Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          const source = this.columns.get(key)
          return [
            key,
            source && !((source.scalar || this.node.compound) && value === null)
              ? mapper.mapResultValue(baseTable(source.handle), source.column, value)
              : value,
          ]
        }),
      )
    })
  }
}

/**
 * Reuses projection decisions for prepared copies without caching caller-authored ASTs.
 *
 * @example
 *   const projection = prepareSelectProjection(node, query, 'rows')
 *
 * @param node - Select AST with application column names.
 * @param query - Resolved relation lookup and dialect compilation operations.
 * @param use - Rows require unique names, single requires one output, and discarded
 *   permits duplicates.
 *
 * @returns Projection decisions shared by scope preparation, lowering, and execution.
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

export {
  outputAliases,
  prepareSelectProjection,
  projectionSource,
  cteOutputNames,
  cteOutputSources,
}
