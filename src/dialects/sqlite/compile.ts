import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import type { RelationIdentityInput } from '@/schemas'
import { InvariantError, QueryError } from '@/utils/error'

import type {
  ComparisonOp,
  CompiledQuery,
  DeleteAst,
  InsertAst,
  InsertConflictAst,
  JoinAst,
  OrderByAst,
  PredicateAst,
  ReturningAst,
  SelectAst,
  SelectItemAst,
  SqlAst,
  SqlExprAst,
  UpdateAst,
} from '../types'

import { asciiFoldSqliteIdentifier } from './identity'

/** Quotes an SQL identifier and escapes embedded double quotes. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/** Rejects values that cannot serve as nonempty SQL identifiers. */
function assertNonEmptyString(
  value: unknown,
  description: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QueryError({ message: `${description} must be a non-empty string` })
  }
}

/** Rejects malformed builder-owned identifiers while preserving the diagnostic. */
function assertAstNonEmptyString(
  value: unknown,
  description: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvariantError(`${description} must be a non-empty string`)
  }
}

/**
 * Rejects query namespaces outside SQLite's supported main database.
 *
 * @param value - Runtime value to validate, normalize, or map.
 * @param description - Diagnostic label that identifies invalid input.
 */
function assertMainNamespace(
  value: unknown,
  description: string,
): asserts value is readonly NamespaceIdentifierInput[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new QueryError({
      message: `${description} must contain exactly one database:main segment`,
    })
  }

  const segment: unknown = value[0]

  if (
    typeof segment !== 'object' ||
    segment === null ||
    !('role' in segment) ||
    !('spelling' in segment) ||
    segment.role !== 'database' ||
    typeof segment.spelling !== 'string' ||
    segment.spelling.length === 0 ||
    asciiFoldSqliteIdentifier(segment.spelling) !== 'main'
  ) {
    throw new QueryError({
      message: `${description} must contain exactly one database:main segment`,
    })
  }
}

/**
 * Validates authored SQLite query namespaces and applies the registration default.
 *
 * @param value - Runtime value to validate, normalize, or map.
 * @param registrationDefault - Explicit namespace default used before the session's
 *   writable default.
 */
function resolveSqliteQueryNamespace(
  value: unknown,
  registrationDefault?: readonly NamespaceIdentifierInput[],
): void {
  if (value !== undefined && !Array.isArray(value)) {
    throw new QueryError({ message: 'SQLite query relation namespace must be an array' })
  }

  const authored = value as readonly NamespaceIdentifierInput[] | undefined
  const selected = authored && authored.length > 0 ? authored : registrationDefault
  const namespace = selected ?? ([{ role: 'database', spelling: 'main' }] as const)
  assertMainNamespace(namespace, 'SQLite query relation namespace')
}

export type SqliteQueryRelation = Readonly<{
  database: 'main'
  table: string
  tableKey: string
}>

export type SqliteQueryRelationResolver = (
  relation: RelationIdentityInput,
) => SqliteQueryRelation

/** Binds SQLite query addressing to one validated client registration default. */
export function createSqliteQueryRelationResolver(
  registrationDefault?: readonly NamespaceIdentifierInput[],
): SqliteQueryRelationResolver {
  if (registrationDefault !== undefined) {
    assertMainNamespace(registrationDefault, 'SQLite query registration default')
  }

  return (relation) => resolveSqliteQueryRelation(relation, registrationDefault)
}

/** Resolves structured relation intent to SQLite's supported main database. */
export function resolveSqliteQueryRelation(
  relation: RelationIdentityInput,
  registrationDefault?: readonly NamespaceIdentifierInput[],
): SqliteQueryRelation {
  const input = relation as unknown

  if (typeof input !== 'object' || input === null) {
    throw new QueryError({ message: 'SQLite query relation must be an object' })
  }

  const candidate = input as { relation?: unknown; namespace?: unknown }
  assertNonEmptyString(candidate.relation, 'SQLite query relation name')
  resolveSqliteQueryNamespace(candidate.namespace, registrationDefault)

  return {
    database: 'main',
    table: candidate.relation,
    tableKey: asciiFoldSqliteIdentifier(candidate.relation),
  }
}

/** Quotes the resolved SQLite database and relation names for a query. */
function qualifySqliteQueryRelation(
  relation: RelationIdentityInput,
  resolveRelation: SqliteQueryRelationResolver,
): string {
  const resolved = resolveRelation(relation)
  return `${quoteIdentifier(resolved.database)}.${quoteIdentifier(resolved.table)}`
}

type SqliteRelation = SqliteQueryRelation & Readonly<{ alias: string }>

/**
 * Resolves query relations and assigns unambiguous aliases.
 *
 * @param inputs - Contract inputs keyed by the facets exercised by this shard.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns Query relations and assigns unambiguous aliases.
 */
function createRelationContext(
  inputs: readonly RelationIdentityInput[],
  resolveRelation: SqliteQueryRelationResolver,
): readonly SqliteRelation[] {
  const resolved = inputs.map(resolveRelation)
  const candidates = resolved.map((relation) => `${relation.database}.${relation.table}`)
  const counts = new Map<string, number>()

  for (const candidate of candidates) {
    const key = asciiFoldSqliteIdentifier(candidate)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return resolved.map((relation, index) => {
    const candidate = candidates[index]!
    const alias =
      counts.get(asciiFoldSqliteIdentifier(candidate)) === 1
        ? candidate
        : `__stratom_${index}`

    return {
      ...relation,
      alias:
        (inputs[index] as RelationIdentityInput & { queryAlias?: string }).queryAlias ??
        alias,
    }
  })
}

/**
 * Requires exactly one query alias for an authored relation reference.
 *
 * @param relations - Resolved query relations or requested catalog relations.
 * @param target - Identity or evidence required by the current reference or diagnostic.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The unique relation alias; absent or ambiguous matches throw.
 */
function resolveRelationAlias(
  relations: readonly SqliteRelation[],
  target: RelationIdentityInput,
  resolveRelation: SqliteQueryRelationResolver,
): string {
  const preparedAlias = (target as RelationIdentityInput & { queryAlias?: string })
    .queryAlias

  if (preparedAlias) return preparedAlias

  const resolved = resolveRelation(target)
  const matches = relations.filter((relation) => relation.tableKey === resolved.tableKey)

  if (matches.length === 1) return matches[0]!.alias

  if (matches.length === 0) {
    throw new QueryError({
      message: `relation reference "${resolved.table}" is not in query`,
    })
  }

  throw new QueryError({ message: `relation reference "${resolved.table}" is ambiguous` })
}

/**
 * Maps a portable comparison operator to its SQL spelling.
 *
 * @param op - SQL operator used by the fixture expression.
 *
 * @returns The SQL comparison fragment with parameters added in emitted order.
 */
function comparisonSql(op: ComparisonOp): string {
  switch (op) {
    case 'eq':
      return '='
    case 'neq':
      return '<>'
    case 'gt':
      return '>'
    case 'gte':
      return '>='
    case 'lt':
      return '<'
    case 'lte':
      return '<='
    default:
      throw new InvariantError(`unsupported SQLite comparison ${String(op)}`)
  }
}

/**
 * Compiles an optional returning clause and validates explicitly selected columns.
 *
 * @param returning - Requested returning columns, or undefined when the write returns no
 *   rows.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileReturning(returning: ReturningAst | undefined): string {
  if (!returning) return ''
  if (returning.kind === 'all') return ' returning *'

  if (returning.kind === 'projection')
    return ` returning ${returning.columns.map(({ column, alias }) => `${quoteIdentifier(column)} as ${quoteIdentifier(alias)}`).join(', ')}`

  const candidate = returning as {
    readonly kind?: unknown
    readonly columns?: readonly string[]
  }

  if (candidate.kind !== 'columns' || !candidate.columns?.length) {
    throw new InvariantError('returning columns must not be empty')
  }

  return ` returning ${candidate.columns
    .map((column) => {
      assertAstNonEmptyString(column, 'returning column')
      return `${quoteIdentifier(column)} as ${quoteIdentifier(column)}`
    })
    .join(', ')}`
}

/** Quotes a column and resolves its relation alias when one is supplied. */
function qualifyColumn(
  column: string,
  relations: readonly SqliteRelation[],
  relation: RelationIdentityInput | undefined,
  resolveRelation: SqliteQueryRelationResolver,
): string {
  assertAstNonEmptyString(column, 'SQLite query column')
  const quoted = quoteIdentifier(column)
  return relation
    ? `${quoteIdentifier(resolveRelationAlias(relations, relation, resolveRelation))}.${quoted}`
    : quoted
}

/**
 * Compiles comparison and logical predicates while appending bound values in SQL order.
 *
 * @param predicate - Predicate or predicate factory used to filter query results.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 * @param relations - Resolved query relations or requested catalog relations.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compilePredicate(
  predicate: PredicateAst,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  switch (predicate.kind) {
    case 'exists':
      return `exists (${compileSelect(predicate.query, resolveRelation, params).sql})`
    case 'inQuery':
      return `${compileExpression(predicate.left, params, relations, resolveRelation)} in (${compileSingleSubquery(predicate.query, resolveRelation, params)})`
    case 'exprCmp':
      return compileExpressionComparison(predicate, params, relations, resolveRelation)
    case 'cmp':
      return compileComparison(predicate, params, relations, resolveRelation)
    case 'and':
      if (!Array.isArray(predicate.preds as unknown)) {
        throw new InvariantError('and predicate requires a predicate array')
      }

      if (predicate.preds.length === 0) {
        throw new InvariantError('and predicate must not be empty')
      }

      if (predicate.preds.length === 1)
        return compilePredicate(predicate.preds[0]!, params, relations, resolveRelation)

      return `(${predicate.preds
        .map((item) => compilePredicate(item, params, relations, resolveRelation))
        .join(' and ')})`
    case 'or':
      if (!Array.isArray(predicate.preds as unknown)) {
        throw new InvariantError('or predicate requires a predicate array')
      }

      if (predicate.preds.length === 0) {
        throw new InvariantError('or predicate must not be empty')
      }

      if (predicate.preds.length === 1)
        return compilePredicate(predicate.preds[0]!, params, relations, resolveRelation)

      return `(${predicate.preds
        .map((item) => compilePredicate(item, params, relations, resolveRelation))
        .join(' or ')})`
    case 'not':
      return `(not ${compilePredicate(predicate.pred, params, relations, resolveRelation)})`
    default:
      throw new InvariantError('unsupported SQLite predicate')
  }
}

/** Compiles an optional WHERE clause and preserves its parameter order. */
function compileWhereClause(
  where: PredicateAst | undefined,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  return where
    ? ` where ${compilePredicate(where, params, relations, resolveRelation)}`
    : ''
}

/**
 * Compiles supported scalar expressions and rejects unsupported dialect functions.
 *
 * @param expression - Scalar SQL expression or default expression being processed.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 * @param relations - Resolved query relations or requested catalog relations.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileExpression(
  expression: SqlExprAst,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  switch (expression.kind) {
    case 'scalar':
      return `(${compileSingleSubquery(expression.query, resolveRelation, params)})`
    case 'outer':
      throw new QueryError({ message: 'Unresolved outer reference' })
    case 'column':
      return qualifyColumn(
        expression.column,
        relations,
        expression.relation,
        resolveRelation,
      )
    case 'count_all':
      return 'count(*)'
    case 'count':
    case 'min':
    case 'max':
    case 'sum':
    case 'lower':
    case 'upper':
    case 'length':
      return `${expression.kind}(${compileExpression(expression.arg, params, relations, resolveRelation)})`
    case 'now':
      return 'CURRENT_TIMESTAMP'
    case 'date_trunc':
      throw new QueryError({ message: 'SQLite 3.37 does not support date_trunc' })
    default:
      throw new InvariantError('unsupported SQLite expression')
  }
}

/**
 * Compiles a selected column, expression, or all-columns item with its alias.
 *
 * @param item - Current member or pending reference under evaluation.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 * @param relations - Resolved query relations or requested catalog relations.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileSelectItem(
  item: SelectItemAst,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  switch (item.kind) {
    case 'all':
      return item.relation
        ? `${quoteIdentifier(resolveRelationAlias(relations, item.relation, resolveRelation))}.*`
        : '*'
    case 'column': {
      const column = qualifyColumn(item.column, relations, item.relation, resolveRelation)

      const alias = item.alias ?? item.column
      assertAstNonEmptyString(alias, 'select alias')
      return `${column} as ${quoteIdentifier(alias)}`
    }
    case 'expr':
      assertAstNonEmptyString(item.alias, 'select alias')
      return `${compileExpression(item.expr, params, relations, resolveRelation)} as ${quoteIdentifier(item.alias)}`
    default:
      throw new InvariantError('unsupported SQLite select item')
  }
}

/**
 * Compiles ordered columns after validating their sort directions.
 *
 * @param orderBy - Ordered sort expressions used by the compilation scenario.
 * @param relations - Resolved query relations or requested catalog relations.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileOrderBy(
  orderBy: readonly OrderByAst[] | undefined,
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  if (!orderBy || orderBy.length === 0) return ''

  return ` order by ${orderBy
    .map((item) => {
      const direction = (item as { readonly direction?: unknown }).direction

      if (direction !== 'asc' && direction !== 'desc') {
        throw new InvariantError('order direction must be asc or desc')
      }

      const nulls: unknown = item.nulls

      if (nulls !== undefined && nulls !== 'first' && nulls !== 'last') {
        throw new InvariantError('null placement must be first or last')
      }

      return `${qualifyColumn(item.column, relations, item.relation, resolveRelation)} ${direction}${item.nulls === undefined ? '' : ` nulls ${item.nulls}`}`
    })
    .join(', ')}`
}

/**
 * Compiles a supported join and its ON predicate using resolved relation aliases.
 *
 * @param join - Join kind, relation, and ON predicate to compile.
 * @param relation - Authored or canonical relation addressed by this operation.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 * @param relations - Resolved query relations or requested catalog relations.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileJoin(
  join: JoinAst,
  relation: SqliteRelation,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  const type =
    join.type === 'inner' ? 'inner join' : join.type === 'left' ? 'left join' : undefined

  if (!type) {
    throw new QueryError({ message: 'SQLite 3.37 does not support right joins' })
  }

  return ` ${type} ${qualifySqliteQueryRelation(join.relation, resolveRelation)} as ${quoteIdentifier(relation.alias)} on ${compilePredicate(join.on, params, relations, resolveRelation)}`
}

/** Rejects row limits or offsets that are negative or unsafe integers. */
function assertPagination(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QueryError({
      message: `${description} must be a non-negative safe integer`,
    })
  }
}

/**
 * Compiles a select AST with resolved aliases and ordered bound parameters.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns Compiled SQL and bound values in emitted order.
 */
function compileSelect(
  node: SelectAst,
  resolveRelation: SqliteQueryRelationResolver,
  params: unknown[] = [],
): CompiledQuery {
  if (!Array.isArray(node.selection as unknown)) {
    throw new InvariantError('select items must be an array')
  }

  const relations = createRelationContext(
    [node.relation, ...(node.joins ?? []).map((join) => join.relation)],
    resolveRelation,
  )

  const selection =
    node.selection.length === 0
      ? '*'
      : node.selection
          .map((item) => compileSelectItem(item, params, relations, resolveRelation))
          .join(', ')

  let sql = `select ${selection} from ${qualifySqliteQueryRelation(node.relation, resolveRelation)} as ${quoteIdentifier(relations[0]!.alias)}`

  for (const [index, join] of (node.joins ?? []).entries()) {
    sql += compileJoin(join, relations[index + 1]!, params, relations, resolveRelation)
  }

  sql += compileWhereClause(node.where, params, relations, resolveRelation)

  sql = compileSelectTail(node, sql, relations, resolveRelation, params)

  return { sql, params }
}

/**
 * Adds grouping, HAVING, ordering, and pagination to a compiled select prefix.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param sql - Native SQL text being scanned, compiled, or observed.
 * @param relations - Resolved query relations or requested catalog relations.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileSelectTail(
  node: SelectAst,
  sql: string,
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
  params: unknown[],
) {
  if (node.groupBy && node.groupBy.length > 0) {
    sql += ` group by ${node.groupBy
      .map((column) =>
        qualifyColumn(column.column, relations, column.relation, resolveRelation),
      )
      .join(', ')}`
  }

  if (node.having) {
    sql += ` having ${compilePredicate(node.having, params, relations, resolveRelation)}`
  }

  sql += compileOrderBy(node.orderBy, relations, resolveRelation)

  if (node.limit !== undefined) {
    assertPagination(node.limit, 'limit')
    params.push(node.limit)
    sql += ' limit ?'
  }

  if (node.offset !== undefined) {
    assertPagination(node.offset, 'offset')

    if (node.limit === undefined) sql += ' limit -1'

    params.push(node.offset)
    sql += ' offset ?'
  }

  return sql
}

/**
 * Compiles insert rows and an optional returning clause with ordered parameters.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns Compiled SQL and bound values in emitted order.
 */
function compileInsert(
  node: InsertAst,
  resolveRelation: SqliteQueryRelationResolver,
): CompiledQuery {
  if (
    !Array.isArray(node.columns) ||
    !Array.isArray(node.values as unknown) ||
    node.values.length === 0
  ) {
    throw new InvariantError('insert requires at least one values row')
  }

  const table = qualifySqliteQueryRelation(node.relation, resolveRelation)

  if (node.columns.length === 0) {
    if (node.values.length !== 1 || node.values[0]?.length !== 0) {
      throw new InvariantError(
        'SQLite supports empty insert columns only as one DEFAULT VALUES row',
      )
    }

    if (node.conflict) {
      throw new QueryError({
        message: 'SQLite does not support an insert conflict clause with DEFAULT VALUES',
      })
    }

    return {
      sql: `insert into ${table} default values${compileReturning(node.returning)}`,
      params: [],
    }
  }

  const columns = node.columns.map((column) => {
    assertAstNonEmptyString(column, 'insert column')
    return quoteIdentifier(column)
  })

  const params: unknown[] = []
  const values = compileInsertValues(node, params)
  const conflict = compileInsertConflict(node.conflict, params)

  return {
    sql: `insert into ${table} (${columns.join(', ')}) values ${values.join(', ')}${conflict}${compileReturning(node.returning)}`,
    params,
  }
}

/** Compiles a structured SQLite insert conflict clause. */
function compileInsertConflict(
  conflict: InsertConflictAst | undefined,
  params: unknown[],
): string {
  if (!conflict) return ''

  if (!Array.isArray(conflict.target) || conflict.target.length === 0) {
    throw new InvariantError('insert conflict target must not be empty')
  }

  const target = conflict.target
    .map((column) => {
      assertAstNonEmptyString(column, 'insert conflict target column')
      return quoteIdentifier(column)
    })
    .join(', ')

  if (new Set(conflict.target).size !== conflict.target.length) {
    throw new InvariantError('insert conflict target contains duplicate columns')
  }

  const action = (conflict as { readonly action?: unknown }).action

  if (typeof action !== 'object' || action === null || !('kind' in action)) {
    throw new InvariantError('insert conflict requires an action')
  }

  if (action.kind === 'doNothing') {
    return ` on conflict (${target}) do nothing`
  }

  if (action.kind !== 'doUpdate' || !('set' in action) || !Array.isArray(action.set)) {
    throw new InvariantError('unsupported insert conflict action')
  }

  if (action.set.length === 0) {
    throw new InvariantError('insert conflict update requires at least one SET column')
  }

  const set = action.set
    .map((assignment) => compileInsertConflictAssignment(assignment, params))
    .join(', ')

  return ` on conflict (${target}) do update set ${set}`
}

/** Compiles one validated SQLite conflict update assignment. */
function compileInsertConflictAssignment(input: unknown, params: unknown[]): string {
  if (typeof input !== 'object' || input === null) {
    throw new InvariantError('insert conflict update assignment is invalid')
  }

  const assignment = input as { readonly column?: unknown; readonly value?: unknown }
  assertAstNonEmptyString(assignment.column, 'insert conflict update column')

  const value = assignment.value

  if (typeof value !== 'object' || value === null) {
    throw new InvariantError('insert conflict update value is invalid')
  }

  const structuredValue = value as {
    readonly kind?: unknown
    readonly column?: unknown
    readonly value?: unknown
  }

  if (structuredValue.kind === 'excluded') {
    assertAstNonEmptyString(structuredValue.column, 'excluded column')
    return `${quoteIdentifier(assignment.column)} = excluded.${quoteIdentifier(structuredValue.column)}`
  }

  if (structuredValue.kind !== 'value') {
    throw new InvariantError('unsupported insert conflict update value')
  }

  params.push(structuredValue.value)
  return `${quoteIdentifier(assignment.column)} = ?`
}

/**
 * Validates insert row widths and emits parameter placeholders in row order.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileInsertValues(node: InsertAst, params: unknown[]) {
  return node.values.map((row) => {
    if (!Array.isArray(row) || row.length !== node.columns.length) {
      throw new InvariantError('insert row width must match its columns')
    }

    return `(${row
      .map((value) => {
        if (value === undefined) {
          throw new QueryError({
            message: 'SQLite does not support DEFAULT as an individual VALUES expression',
          })
        }

        params.push(value)
        return '?'
      })
      .join(', ')})`
  })
}

/**
 * Compiles assignments and enforces a filter or explicit full-table permission.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns Compiled SQL and bound values in emitted order.
 */
function compileUpdate(
  node: UpdateAst,
  resolveRelation: SqliteQueryRelationResolver,
): CompiledQuery {
  if (!Array.isArray(node.set as unknown) || node.set.length === 0) {
    throw new InvariantError('update requires at least one SET column')
  }

  if (!node.where && node.allowAll !== true) {
    throw new QueryError({ message: 'full-table update requires allowAll' })
  }

  const relations = createRelationContext([node.relation], resolveRelation)
  const params: unknown[] = []

  const assignments = node.set
    .map((item) => {
      assertAstNonEmptyString(item.column, 'update column')
      params.push(item.value)
      return `${quoteIdentifier(item.column)} = ?`
    })
    .join(', ')

  const where = compileWhereClause(node.where, params, relations, resolveRelation)

  return {
    sql: `update ${qualifySqliteQueryRelation(node.relation, resolveRelation)} as ${quoteIdentifier(relations[0]!.alias)} set ${assignments}${where}${compileReturning(node.returning)}`,
    params,
  }
}

/**
 * Compiles deletion and enforces a filter or explicit full-table permission.
 *
 * @param node - AST node or dependency-graph node being processed.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns Compiled SQL and bound values in emitted order.
 */
function compileDelete(
  node: DeleteAst,
  resolveRelation: SqliteQueryRelationResolver,
): CompiledQuery {
  if (!node.where && node.allowAll !== true) {
    throw new QueryError({ message: 'full-table delete requires allowAll' })
  }

  const relations = createRelationContext([node.relation], resolveRelation)
  const params: unknown[] = []
  const where = compileWhereClause(node.where, params, relations, resolveRelation)

  return {
    sql: `delete from ${qualifySqliteQueryRelation(node.relation, resolveRelation)} as ${quoteIdentifier(relations[0]!.alias)}${where}${compileReturning(node.returning)}`,
    params,
  }
}

/** Compiles SQLite 3.37's supported public query AST forms. */
export function compileSqliteQuery(
  node: SqlAst,
  resolveRelation: SqliteQueryRelationResolver = createSqliteQueryRelationResolver(),
): CompiledQuery {
  switch (node.kind) {
    case 'select':
      return compileSelect(node, resolveRelation)
    case 'insert':
      return compileInsert(node, resolveRelation)
    case 'update':
      return compileUpdate(node, resolveRelation)
    case 'delete':
      return compileDelete(node, resolveRelation)
    default:
      throw new InvariantError('unsupported SQLite query AST')
  }
}

/**
 * Compiles column or value comparisons, including SQL's special null predicates.
 *
 * @param predicate - Predicate or predicate factory used to filter query results.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 * @param relations - Resolved query relations or requested catalog relations.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileComparison(
  predicate: Extract<PredicateAst, { kind: 'cmp' }>,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  const left = qualifyColumn(
    predicate.column,
    relations,
    predicate.relation,
    resolveRelation,
  )

  const op = comparisonSql(predicate.op)

  if (predicate.right !== undefined && Object.hasOwn(predicate, 'value')) {
    throw new InvariantError('comparison cannot contain both right and value')
  }

  if (predicate.right !== undefined) {
    return `${left} ${op} ${qualifyColumn(predicate.right.column, relations, predicate.right.relation, resolveRelation)}`
  }

  if (predicate.value !== null) {
    params.push(predicate.value)
    return `${left} ${op} ?`
  }

  const nullComparison =
    predicate.op === 'eq'
      ? `${left} is null`
      : predicate.op === 'neq'
        ? `${left} is not null`
        : undefined

  if (nullComparison) return nullComparison

  throw new QueryError({
    message: `comparison '${predicate.op}' does not accept null`,
  })
}

function compileExpressionComparison(
  predicate: Extract<PredicateAst, { kind: 'exprCmp' }>,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  const left = compileExpression(predicate.left, params, relations, resolveRelation)

  if (predicate.right.kind === 'value') {
    if (
      predicate.right.value === null &&
      (predicate.op === 'eq' || predicate.op === 'neq')
    )
      return `${left} is ${predicate.op === 'neq' ? 'not ' : ''}null`

    params.push(predicate.right.value)
    return `${left} ${comparisonSql(predicate.op)} ?`
  }

  return `${left} ${comparisonSql(predicate.op)} ${compileExpression(predicate.right, params, relations, resolveRelation)}`
}

function compileSingleSubquery(
  node: SelectAst,
  resolveRelation: SqliteQueryRelationResolver,
  params: unknown[],
): string {
  if (node.selection.length !== 1)
    throw new QueryError({
      message: 'Scalar and IN subqueries require exactly one projected value',
    })

  return compileSelect(node, resolveRelation, params).sql
}
