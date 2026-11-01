import { queryRelationSource } from '@/query/sourceRelation'
import type { RelationIdentityInput } from '@/schemas'
import { physicalColumnName } from '@/schemas/physicalColumn'
import type { TableHandle } from '@/types'
import { QueryError } from '@/utils/error'

import type {
  CompiledQuery,
  DialectQueryResolution,
  InsertAst,
  PredicateAst,
  QualifiedColumnAst,
  ReturningAst,
  SelectAst,
  SelectItemAst,
  SqlAst,
  SqlExprAst,
} from './types'

/** Binds logical addressing to one compilation, leaving the builder AST unchanged. */
export function compileColumnQuery(
  query: DialectQueryResolution,
  node: SqlAst,
): CompiledQuery {
  const projection: { sqlName: string; outputName: string }[] = []
  const lowered = new ColumnQuery(query).statement(node, projection)
  const compiled = query.compile(lowered)
  return projection.length ? { ...compiled, resultProjection: projection } : compiled
}

class ColumnQuery {
  constructor(readonly query: DialectQueryResolution) {}

  handle(relation: RelationIdentityInput): TableHandle | undefined {
    const source = queryRelationSource(relation)

    if (source) return source

    const matches = this.query.findRelationMatches(relation)

    if (matches.length > 1)
      throw new QueryError({ message: 'Query relation is ambiguous' })

    return matches[0]
  }

  column<T extends QualifiedColumnAst>(ref: T, relation: RelationIdentityInput): T {
    const handle = this.handle(ref.relation ?? relation)

    if (!handle) return ref

    if (!Object.hasOwn(handle.getSchema().entries, ref.column))
      throw new QueryError({
        message: `Unknown application column ${JSON.stringify(ref.column)}`,
      })

    return { ...ref, column: physicalColumnName(handle, ref.column) }
  }

  expression(expr: SqlExprAst, relation: RelationIdentityInput): SqlExprAst {
    if (expr.kind === 'column') return this.column(expr, relation)
    if (expr.kind === 'outer') return { ...expr, ref: this.column(expr.ref, relation) }

    if (expr.kind === 'scalar')
      return { ...expr, query: this.statement(expr.query) as SelectAst }

    if ('arg' in expr) return { ...expr, arg: this.column(expr.arg, relation) }

    return expr
  }

  predicate(pred: PredicateAst, relation: RelationIdentityInput): PredicateAst {
    if (pred.kind === 'and' || pred.kind === 'or')
      return { ...pred, preds: pred.preds.map((p) => this.predicate(p, relation)) }

    if (pred.kind === 'not') return { ...pred, pred: this.predicate(pred.pred, relation) }

    if (pred.kind === 'exists')
      return { ...pred, query: this.statement(pred.query, undefined, true) as SelectAst }

    if (pred.kind === 'inQuery')
      return {
        ...pred,
        left: this.expression(pred.left, relation),
        query: this.statement(pred.query) as SelectAst,
      }

    if (pred.kind === 'exprCmp')
      return {
        ...pred,
        left: this.expression(pred.left, relation),
        right:
          pred.right.kind === 'value'
            ? pred.right
            : this.expression(pred.right, relation),
      }

    return {
      ...this.column(pred, relation),
      ...(pred.right ? { right: this.column(pred.right, relation) } : {}),
    }
  }

  selection(node: SelectAst): SelectItemAst[] {
    const relations = [node.relation, ...(node.joins ?? []).map((join) => join.relation)]
    return (node.selection.length ? node.selection : [{ kind: 'all' as const }]).flatMap(
      (item): SelectItemAst[] => {
        if (item.kind !== 'all') return [item]

        const selected = item.relation ? [item.relation] : relations
        const handles = selected.map((relation) => this.handle(relation))

        if (handles.some((handle) => !handle)) return [item]

        return handles.flatMap((handle, index) =>
          Object.keys(handle!.getSchema().entries).map((column) => ({
            kind: 'column' as const,
            relation: selected[index],
            column,
            alias: column,
          })),
        )
      },
    )
  }

  /** Uses a conservative SQL output bound; application names have no storage limit. */
  aliases(
    names: readonly string[],
    projection?: { sqlName: string; outputName: string }[],
    discard = false,
  ): string[] {
    if (!discard && new Set(names).size !== names.length)
      throw new QueryError({
        message: 'Query output columns are ambiguous; supply explicit aliases',
      })

    const reserved = new Set(names)
    let sequence = 0
    return names.map((outputName) => {
      let sqlName = outputName

      if (
        outputName.length === 0 ||
        new TextEncoder().encode(outputName).length > 63 ||
        outputName.includes('\0') ||
        new TextDecoder().decode(new TextEncoder().encode(outputName)) !== outputName
      ) {
        do {
          sqlName = `__stratom_c${sequence++}`
        } while (reserved.has(sqlName))

        reserved.add(sqlName)
        projection?.push({ sqlName, outputName })
      }

      return sqlName
    })
  }

  returning(
    returning: ReturningAst,
    relation: RelationIdentityInput,
    projection?: { sqlName: string; outputName: string }[],
  ): ReturningAst {
    if (returning.kind === 'projection') return returning

    const handle = this.handle(relation)

    if (!handle) return returning

    const names =
      returning.kind === 'all'
        ? Object.keys(handle.getSchema().entries)
        : [...returning.columns]

    const aliases = this.aliases(names, projection)
    return {
      kind: 'projection',
      columns: names.map((column, index) => ({
        column: this.column({ column }, relation).column,
        alias: aliases[index]!,
      })),
    }
  }

  insert(
    node: InsertAst,
    projection?: { sqlName: string; outputName: string }[],
  ): InsertAst {
    const relation = node.relation
    return {
      ...node,
      columns: node.columns.map((column) => this.column({ column }, relation).column),
      ...(node.conflict
        ? {
            conflict: {
              target: node.conflict.target.map(
                (column) => this.column({ column }, relation).column,
              ),
              action:
                node.conflict.action.kind === 'doNothing'
                  ? node.conflict.action
                  : {
                      ...node.conflict.action,
                      set: node.conflict.action.set.map((assignment) => ({
                        ...assignment,
                        column: this.column(assignment, relation).column,
                        value:
                          assignment.value.kind === 'excluded'
                            ? this.column(assignment.value, relation)
                            : assignment.value,
                      })),
                    },
            },
          }
        : {}),
      ...(node.returning
        ? { returning: this.returning(node.returning, relation, projection) }
        : {}),
    }
  }

  statement(
    node: SqlAst,
    projection?: { sqlName: string; outputName: string }[],
    discard = false,
  ): SqlAst {
    const relation = node.relation

    if (node.kind === 'insert') return this.insert(node, projection)

    if (node.kind === 'select') return this.select(node, projection, discard)

    const where = node.where ? this.predicate(node.where, relation) : undefined

    return {
      ...node,
      ...(node.kind === 'update'
        ? {
            set: node.set.map((item) =>
              item.addition
                ? {
                    ...this.column(item, relation),
                    addition: {
                      ...item.addition,
                      source: this.column({ column: item.addition.source }, relation)
                        .column,
                    },
                  }
                : this.column(item, relation),
            ),
          }
        : {}),
      ...(where ? { where } : {}),
      ...(node.returning
        ? { returning: this.returning(node.returning, relation, projection) }
        : {}),
    }
  }

  selectItem(
    item: SelectItemAst,
    alias: string,
    relation: RelationIdentityInput,
  ): SelectItemAst {
    if (item.kind === 'all') return item

    if (item.kind === 'expr')
      return { ...item, expr: this.expression(item.expr, relation), alias }

    const physical = this.column(item, relation)
    return {
      ...physical,
      ...(item.alias !== undefined ||
      physical.column !== item.column ||
      alias !== item.column
        ? { alias }
        : {}),
    }
  }

  select(
    node: SelectAst,
    projection?: { sqlName: string; outputName: string }[],
    discard = false,
  ): SelectAst {
    const relation = node.relation
    const where = node.where ? this.predicate(node.where, relation) : undefined
    const selection = this.selection(node)
    const names = selection.map((item) =>
      item.kind === 'all'
        ? '*'
        : (item.alias ?? (item.kind === 'column' ? item.column : '')),
    )

    const aliases = this.aliases(names, projection, discard)
    return {
      ...node,
      selection: selection.map((item, index) =>
        this.selectItem(item, aliases[index]!, relation),
      ),
      ...(where ? { where } : {}),
      ...(node.joins
        ? {
            joins: node.joins.map((join) => ({
              ...join,
              on: this.predicate(join.on, relation),
            })),
          }
        : {}),
      ...(node.orderBy
        ? { orderBy: node.orderBy.map((item) => this.column(item, relation)) }
        : {}),
      ...(node.groupBy
        ? { groupBy: node.groupBy.map((item) => this.column(item, relation)) }
        : {}),
      ...(node.having ? { having: this.predicate(node.having, relation) } : {}),
    }
  }
}
