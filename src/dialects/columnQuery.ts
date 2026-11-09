import { outputAliases, prepareSelectProjection } from '@/query/projection'
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

/**
 * Lowers application columns and compiles SQL without changing the input AST.
 *
 * @example
 *   compileColumnQuery(resolved, selectAst)
 *
 * @param query - Resolved relation lookup and dialect compilation operations.
 * @param node - Query AST with logical column references.
 *
 * @returns Dialect SQL, parameters, and any output-name restoration metadata.
 */
function compileColumnQuery(query: DialectQueryResolution, node: SqlAst): CompiledQuery {
  const projection: { sqlName: string; outputName: string }[] = []
  const lowered = new ColumnQuery(query).statement(node, projection)
  const compiled = query.compile(lowered)
  return projection.length ? { ...compiled, resultProjection: projection } : compiled
}

class ColumnQuery {
  /**
   * Binds physical column lowering to one resolved dialect context.
   *
   * @example
   *   const lowering = new ColumnQuery(resolved)
   *
   * @param query - Resolved relation lookup and dialect compilation operations.
   */
  constructor(readonly query: DialectQueryResolution) {}

  /**
   * Resolves a prepared occurrence or registered relation to its source handle.
   *
   * @example
   *   lowering.handle(selectAst.relation)
   *
   * @param relation - Prepared occurrence or authored relation to resolve.
   *
   * @returns The registered handle, or undefined when the relation is unknown.
   */
  handle(relation: RelationIdentityInput): TableHandle | undefined {
    const source = queryRelationSource(relation)

    if (source) return source

    const matches = this.query.findRelationMatches(relation)

    if (matches.length > 1)
      throw new QueryError({ message: 'Query relation is ambiguous' })

    return matches[0]
  }

  /**
   * Replaces a known application column name with its physical SQL name.
   *
   * @example
   *   lowering.column({ column: 'displayName' }, usersRelation)
   *
   * @param ref - Logical column reference, including any explicit relation.
   * @param relation - Default relation for unqualified column references.
   *
   * @returns A lowered reference, or the original for an unknown relation.
   */
  column<T extends QualifiedColumnAst>(ref: T, relation: RelationIdentityInput): T {
    const handle = this.handle(ref.relation ?? relation)

    if (!handle) return ref

    if (!Object.hasOwn(handle.getSchema().entries, ref.column)) {
      throw new QueryError({
        message: `Unknown application column ${JSON.stringify(ref.column)}`,
      })
    }

    return { ...ref, column: physicalColumnName(handle, ref.column) }
  }

  /**
   * Lowers column references and nested selects within an expression.
   *
   * @example
   *   lowering.expression({ kind: 'column', column: 'id' }, usersRelation)
   *
   * @param expr - Expression with application column names.
   * @param relation - Default relation for unqualified column references.
   *
   * @returns An expression ready for dialect SQL generation.
   */
  expression(expr: SqlExprAst, relation: RelationIdentityInput): SqlExprAst {
    if (expr.kind === 'column') return this.column(expr, relation)
    if (expr.kind === 'outer') return { ...expr, ref: this.column(expr.ref, relation) }

    if (expr.kind === 'scalar')
      return { ...expr, query: this.statement(expr.query) as SelectAst }

    if ('arg' in expr) return { ...expr, arg: this.column(expr.arg, relation) }

    return expr
  }

  /**
   * Lowers predicate columns and nested queries without remapping parameter values.
   *
   * @example
   *   lowering.predicate(whereAst, selectAst.relation)
   *
   * @param pred - Prepared predicate with already mapped parameter values.
   * @param relation - Default relation for unqualified column references.
   *
   * @returns The predicate with physical column references.
   */
  predicate(pred: PredicateAst, relation: RelationIdentityInput): PredicateAst {
    if (pred.kind === 'and' || pred.kind === 'or')
      return { ...pred, preds: pred.preds.map((p) => this.predicate(p, relation)) }

    if (pred.kind === 'not') return { ...pred, pred: this.predicate(pred.pred, relation) }

    if (pred.kind === 'exists')
      return { ...pred, query: this.statement(pred.query, undefined, true) as SelectAst }

    if (pred.kind === 'inQuery') {
      return {
        ...pred,
        left: this.expression(pred.left, relation),
        query: this.statement(pred.query) as SelectAst,
      }
    }

    if (pred.kind === 'exprCmp') {
      return {
        ...pred,
        left: this.expression(pred.left, relation),
        right:
          pred.right.kind === 'value'
            ? pred.right
            : this.expression(pred.right, relation),
      }
    }

    return {
      ...this.column(pred, relation),
      ...(pred.right ? { right: this.column(pred.right, relation) } : {}),
    }
  }

  /**
   * Builds physical RETURNING columns using the shared output alias decisions.
   *
   * @example
   *   lowering.returning({ kind: 'all' }, usersRelation, resultNames)
   *
   * @param returning - Authored RETURNING selection or an already lowered projection.
   * @param relation - Default relation for unqualified column references.
   * @param projection - Optional collector for SQL names that require result-name
   *   restoration.
   *
   * @returns Physical RETURNING columns, or the unchanged selection for an unknown
   *   relation.
   */
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

    const outputs = outputAliases(names)
    projection?.push(
      ...outputs.filter(({ sqlName, outputName }) => sqlName !== outputName),
    )

    return {
      kind: 'projection',
      columns: names.map((column, index) => ({
        column: this.column({ column }, relation).column,
        alias: outputs[index].sqlName,
      })),
    }
  }

  /**
   * Lowers insert, conflict, and RETURNING column references together.
   *
   * @example
   *   lowering.insert(insertAst, resultNames)
   *
   * @param node - Insert AST with application column names.
   * @param projection - Optional collector for SQL names that require result-name
   *   restoration.
   *
   * @returns An insert AST ready for dialect SQL generation.
   */
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

  /**
   * Lowers a statement while collecting restoration metadata only for its own outputs.
   *
   * @example
   *   lowering.statement(selectAst, resultNames)
   *
   * @param node - Prepared query or write AST to lower.
   * @param projection - Optional collector for SQL names that require result-name
   *   restoration.
   * @param discard - Permit duplicate select outputs when compiling an EXISTS query.
   *
   * @returns The statement with physical column references.
   */
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

  /**
   * Lowers a selected expression and applies its prepared SQL alias when needed.
   *
   * @example
   *   lowering.selectItem(item, '__stratom_c0', usersRelation)
   *
   * @param item - Expanded selection item with application column names.
   * @param alias - SQL output name chosen by projection preparation.
   * @param relation - Default relation for unqualified column references.
   *
   * @returns A physical selection item with the prepared alias.
   */
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

  /**
   * Lowers a select using shared projection names and source expansion.
   *
   * @example
   *   lowering.select(selectAst, resultNames)
   *
   * @param node - Select AST with application column names.
   * @param projection - Optional collector for SQL names that require result-name
   *   restoration.
   * @param discard - Permit duplicate outputs when the select only supplies EXISTS.
   *
   * @returns The select with physical columns and prepared SQL output aliases.
   */
  select(
    node: SelectAst,
    projection?: { sqlName: string; outputName: string }[],
    discard = false,
  ): SelectAst {
    const relation = node.relation
    const where = node.where ? this.predicate(node.where, relation) : undefined
    const prepared = prepareSelectProjection(
      node,
      this.query,
      discard ? 'discarded' : 'rows',
    )

    projection?.push(...prepared.resultNames)
    return {
      ...node,
      selection: prepared.node.selection.map((item, index) =>
        this.selectItem(item, prepared.outputs[index].sqlName, relation),
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

export { compileColumnQuery }
