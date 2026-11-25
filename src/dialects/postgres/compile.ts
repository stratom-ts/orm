import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import type { RelationIdentityInput } from '@/schemas'
import { InvariantError, QueryError } from '@/utils/error'

import { compileCompoundSelect } from '../compoundQuery'
import { compileWithSelect, isCteRelation } from '../cteQuery'
import type {
  ComparisonOp,
  CompiledQuery,
  DeleteAst,
  InsertAst,
  InsertConflictAst,
  JoinAst,
  OrderByAst,
  PredicateAst,
  QualifiedColumnAst,
  ReturningAst,
  SelectAst,
  SelectItemAst,
  SqlAst,
  SqlExprAst,
  UpdateAst,
} from '../types'

/**
 * Wraps an identifier in double quotes, escaping any internal quotes.
 *
 * @param identifier - The identifier to quote (e.g. table name, column name)
 *
 * @returns Quoted identifier safe for SQL
 */
function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

/** Rejects values that cannot serve as SQL identifiers. */
function assertIdentifier(value: unknown, description: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvariantError(`${description} must be a non-empty string`)
  }
}

type PostgresQueryRelation = {
  database?: string
  schema?: string
  table: string
}

type PostgresQueryRelationResolver = (
  relation: RelationIdentityInput,
) => PostgresQueryRelation

/** Binds PostgreSQL query addressing to one client registration default. */
function createPostgresQueryRelationResolver(
  registrationDefault?: readonly NamespaceIdentifierInput[],
): PostgresQueryRelationResolver {
  return (relation) => resolvePostgresQueryRelation(relation, registrationDefault)
}

/** Validates the value shape shared by every authored query namespace segment. */
function assertPostgresQueryNamespaceSegments(
  namespace: readonly unknown[],
): asserts namespace is readonly NamespaceIdentifierInput[] {
  for (const segment of namespace) {
    if (typeof segment !== 'object' || segment === null) {
      throw new QueryError({
        message: 'PostgreSQL query namespace segment must be an object',
      })
    }

    if (
      !('spelling' in segment) ||
      typeof segment.spelling !== 'string' ||
      segment.spelling.length === 0
    ) {
      throw new QueryError({
        message: 'PostgreSQL query namespace names must be non-empty strings',
      })
    }
  }
}

/** Validates and resolves the namespace accepted by PostgreSQL query addressing. */
function resolvePostgresQueryNamespace(
  value: unknown,
  registrationDefault?: readonly NamespaceIdentifierInput[],
): readonly NamespaceIdentifierInput[] {
  if (value !== undefined && !Array.isArray(value)) {
    throw new QueryError({
      message: 'PostgreSQL query relation namespace must be an array',
    })
  }

  const authoredNamespace = (value ?? []) as unknown[]
  const namespace =
    authoredNamespace.length === 0 && registrationDefault !== undefined
      ? registrationDefault
      : authoredNamespace

  if (namespace.length > 2) {
    throw new QueryError({
      message:
        'PostgreSQL query relation namespace must be omitted, schema-only, or database plus schema',
    })
  }

  assertPostgresQueryNamespaceSegments(namespace)

  const schemaOnly = namespace.length === 1 && namespace[0]?.role === 'schema'
  const databaseAndSchema =
    namespace.length === 2 &&
    namespace[0]?.role === 'database' &&
    namespace[1]?.role === 'schema'

  if (namespace.length > 0 && !schemaOnly && !databaseAndSchema) {
    throw new QueryError({
      message:
        'PostgreSQL query relation namespace must be omitted, schema-only, or database plus schema',
    })
  }

  return namespace
}

/** Resolves authored relation intent according to PostgreSQL query semantics. */
function resolvePostgresQueryRelation(
  relation: RelationIdentityInput,
  registrationDefault?: readonly NamespaceIdentifierInput[],
): PostgresQueryRelation {
  const input = relation as unknown

  if (typeof input !== 'object' || input === null) {
    throw new QueryError({
      message: 'PostgreSQL query relation must be an object',
    })
  }

  const candidate = input as {
    relation?: unknown
    namespace?: unknown
  }

  if (typeof candidate.relation !== 'string' || candidate.relation.length === 0) {
    throw new QueryError({
      message: 'PostgreSQL query relation name must be a non-empty string',
    })
  }

  const namespace = resolvePostgresQueryNamespace(
    candidate.namespace,
    registrationDefault,
  )

  if (namespace.length === 0) return { table: candidate.relation }

  if (namespace.length === 1) {
    return { schema: namespace[0].spelling, table: candidate.relation }
  }

  return {
    database: namespace[0].spelling,
    schema: namespace[1].spelling,
    table: candidate.relation,
  }
}

/** Qualifies a structured query relation after PostgreSQL namespace resolution. */
function qualifyPostgresQueryRelation(
  relation: RelationIdentityInput,
  resolveRelation: PostgresQueryRelationResolver,
): string {
  if (isCteRelation(relation)) return quoteIdentifier(relation.relation)

  const resolved = resolveRelation(relation)
  return resolved.schema
    ? `${quoteIdentifier(resolved.schema)}.${quoteIdentifier(resolved.table)}`
    : quoteIdentifier(resolved.table)
}

/**
 * Builds the canonical alias candidate for a PostgreSQL table.
 *
 * @param database - Explicit authored database, when present.
 * @param schema - Explicit authored schema, when present.
 * @param table - Table name.
 */
function postgresTableAlias(
  database: string | undefined,
  schema: string | undefined,
  table: string,
): string {
  return [database, schema, table].filter((part) => part !== undefined).join('.')
}

type PostgresRelation = {
  database?: string
  schema?: string
  table: string
  alias: string
}

/**
 * Measures a string using PostgreSQL's UTF-8 identifier byte limit.
 *
 * @param value - String to measure.
 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Resolves deterministic, unambiguous aliases for query relations.
 *
 * @param relations - Relations participating in the query.
 */
function createRelationContext(
  relations: readonly RelationIdentityInput[],
  resolveRelation: PostgresQueryRelationResolver,
): PostgresRelation[] {
  const resolved = relations.map(resolveRelation)
  const candidates = resolved.map((relation) =>
    postgresTableAlias(relation.database, relation.schema, relation.table),
  )

  const counts = new Map<string, number>()

  for (const candidate of candidates) {
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
  }

  return resolved.map((relation, index) => {
    const candidate = candidates[index]
    const alias =
      counts.get(candidate) === 1 && utf8ByteLength(candidate) <= 63
        ? candidate
        : `__stratom_${index}`

    return {
      ...(relation.database === undefined ? {} : { database: relation.database }),
      ...(relation.schema === undefined ? {} : { schema: relation.schema }),
      table: relation.table,
      alias:
        (relations[index] as RelationIdentityInput & { queryAlias?: string })
          .queryAlias ?? alias,
    }
  })
}

/**
 * Finds the alias for a table reference in the query relation context.
 *
 * @param relations - Relations participating in the query.
 * @param target - Authored relation target.
 */
function resolveRelationAlias(
  relations: readonly PostgresRelation[],
  target: RelationIdentityInput,
  resolveRelation: PostgresQueryRelationResolver,
): string {
  const preparedAlias = (target as RelationIdentityInput & { queryAlias?: string })
    .queryAlias

  if (preparedAlias) return preparedAlias

  const resolved = resolveRelation(target)
  const exactMatches = relations.filter(
    (relation) =>
      relation.database === resolved.database &&
      relation.schema === resolved.schema &&
      relation.table === resolved.table,
  )

  if (exactMatches.length === 1) return exactMatches[0].alias

  const matches = relations.filter(
    (relation) =>
      relation.table === resolved.table &&
      !(
        relation.database !== undefined &&
        resolved.database !== undefined &&
        relation.database !== resolved.database
      ) &&
      !(
        relation.schema !== undefined &&
        resolved.schema !== undefined &&
        relation.schema !== resolved.schema
      ),
  )

  if (matches.length === 1) return matches[0].alias

  if (matches.length === 0) {
    throw new QueryError({
      message: `relation reference "${target.relation}" is not in query`,
    })
  }

  throw new QueryError({
    message: `relation reference "${target.relation}" is ambiguous`,
  })
}

/**
 * Maps a comparison operator to its SQL symbol.
 *
 * @param op - Comparison operator from the AST.
 *
 * @returns SQL operator string
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
    default: {
      const _exhaustive: never = op
      return _exhaustive
    }
  }
}

/**
 * Compiles a `RETURNING` clause from the AST.
 *
 * @param returning - Returning AST node, or `undefined` for no clause.
 *
 * @returns SQL returning clause, or empty string
 */
function compileReturning(returning: ReturningAst | undefined): string {
  if (!returning) return ''
  if (returning.kind === 'all') return ' returning *'

  if (returning.kind === 'projection')
    return ` returning ${returning.columns.map(({ column, alias }) => (alias === column ? quoteIdentifier(column) : `${quoteIdentifier(column)} as ${quoteIdentifier(alias)}`)).join(', ')}`

  if (!Array.isArray(returning.columns) || returning.columns.length === 0) {
    throw new InvariantError('returning columns must not be empty')
  }

  return ` returning ${(returning.columns as readonly string[]).map((c) => quoteIdentifier(c)).join(', ')}`
}

/**
 * Qualifies a column name with an optional table prefix.
 *
 * @param column - Column name.
 * @param relations - Relations participating in the query.
 * @param relation - Optional authored relation intent.
 *
 * @returns Qualified column reference (e.g. `"users"."id"`)
 */
function qualifyColumn(
  column: string,
  relations: readonly PostgresRelation[],
  relation: RelationIdentityInput | undefined,
  resolveRelation: PostgresQueryRelationResolver,
): string {
  const col = quoteIdentifier(column)
  return relation
    ? `${quoteIdentifier(resolveRelationAlias(relations, relation, resolveRelation))}.${col}`
    : col
}

/**
 * Compiles a qualified column AST node to SQL.
 *
 * @param col - Qualified column AST node.
 * @param relations - Relations participating in the query.
 *
 * @returns SQL column reference
 */
function compileQualifiedColumn(
  col: QualifiedColumnAst,
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  return qualifyColumn(col.column, relations, col.relation, resolveRelation)
}

/**
 * Compiles a predicate AST node to a SQL WHERE / ON condition.
 *
 * @param pred - Predicate AST node.
 * @param params - Accumulator for parameterized values.
 * @param relations - Relations participating in the query.
 *
 * @returns SQL condition string
 */
function compilePredicate(
  pred: PredicateAst,
  params: unknown[],
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  switch (pred.kind) {
    case 'exists':
      return `exists (${compileSelect(pred.query, resolveRelation, params).sql})`
    case 'inQuery':
      return `${compileExpression(pred.left, params, relations, resolveRelation)} in (${compileSingleSubquery(pred.query, resolveRelation, params)})`
    case 'exprCmp':
      return compileExpressionComparison(pred, params, relations, resolveRelation)
    case 'cmp':
      return compileComparison(pred, params, relations, resolveRelation)
    case 'and': {
      if (!Array.isArray(pred.preds))
        throw new InvariantError('and predicate requires a predicate array')

      const predicates = pred.preds as readonly PredicateAst[]

      if (predicates.length === 0) return 'true'

      if (predicates.length === 1)
        return compilePredicate(predicates[0], params, relations, resolveRelation)

      return `(${predicates.map((p) => compilePredicate(p, params, relations, resolveRelation)).join(' and ')})`
    }
    case 'or': {
      if (!Array.isArray(pred.preds))
        throw new InvariantError('or predicate requires a predicate array')

      const predicates = pred.preds as readonly PredicateAst[]

      if (predicates.length === 0) return 'false'

      if (predicates.length === 1)
        return compilePredicate(predicates[0], params, relations, resolveRelation)

      return `(${predicates.map((p) => compilePredicate(p, params, relations, resolveRelation)).join(' or ')})`
    }
    case 'not':
      return `(not ${compilePredicate(pred.pred, params, relations, resolveRelation)})`
    default: {
      const _exhaustive: never = pred
      return _exhaustive
    }
  }
}

/**
 * Compiles an optional WHERE clause.
 *
 * @param where - Where predicate AST node.
 * @param params - Accumulator for parameterized values.
 * @param relations - Relations participating in the query.
 *
 * @returns SQL where clause, or empty string
 */
function compileWhereClause(
  where: PredicateAst | undefined,
  params: unknown[],
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  if (!where) return ''

  return ` where ${compilePredicate(where, params, relations, resolveRelation)}`
}

/**
 * Compiles a scalar SQL expression (select list, having, etc.).
 *
 * @param expr - Expression AST node.
 * @param params - Accumulator for parameterized values.
 * @param relations - Relations participating in the query.
 *
 * @returns SQL expression string
 */
function compileExpression(
  expr: SqlExprAst,
  params: unknown[],
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  switch (expr.kind) {
    case 'scalar':
      return `(${compileSingleSubquery(expr.query, resolveRelation, params)})`
    case 'outer':
      throw new QueryError({ message: 'Unresolved outer reference' })
    case 'column':
      return qualifyColumn(expr.column, relations, expr.relation, resolveRelation)
    case 'count_all':
      return 'count(*)'
    case 'count':
      return `count(${compileExpression(expr.arg, params, relations, resolveRelation)})`
    case 'min':
      return `min(${compileExpression(expr.arg, params, relations, resolveRelation)})`
    case 'max':
      return `max(${compileExpression(expr.arg, params, relations, resolveRelation)})`
    case 'sum':
      return `sum(${compileExpression(expr.arg, params, relations, resolveRelation)})`
    case 'lower':
      return `lower(${compileExpression(expr.arg, params, relations, resolveRelation)})`
    case 'upper':
      return `upper(${compileExpression(expr.arg, params, relations, resolveRelation)})`
    case 'length':
      return `length(${compileExpression(expr.arg, params, relations, resolveRelation)})`
    case 'now':
      return 'now()'
    case 'date_trunc': {
      params.push(expr.unit)
      const unitParam = `$${params.length}`
      return `date_trunc(${unitParam}, ${compileExpression(expr.arg, params, relations, resolveRelation)})`
    }
    default: {
      const _exhaustive: never = expr
      return _exhaustive
    }
  }
}

/**
 * Compiles a single select list item to SQL.
 *
 * @param item - Select item AST node.
 * @param params - Accumulator for parameterized values.
 * @param relations - Relations participating in the query.
 *
 * @returns SQL select item expression
 */
function compileSelectItem(
  item: SelectItemAst,
  params: unknown[],
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  switch (item.kind) {
    case 'all':
      return item.relation
        ? `${quoteIdentifier(resolveRelationAlias(relations, item.relation, resolveRelation))}.*`
        : '*'
    case 'column': {
      const col = qualifyColumn(item.column, relations, item.relation, resolveRelation)
      return item.alias ? `${col} as ${quoteIdentifier(item.alias)}` : col
    }
    case 'expr':
      return `${compileExpression(item.expr, params, relations, resolveRelation)} as ${quoteIdentifier(item.alias)}`
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}

/**
 * Compiles an ORDER BY clause.
 *
 * @param orderBy - Order-by AST nodes.
 * @param relations - Relations participating in the query.
 *
 * @returns SQL order by clause, or empty string
 */
function compileOrderBy(
  orderBy: readonly OrderByAst[] | undefined,
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  if (!orderBy || orderBy.length === 0) return ''

  const parts = orderBy.map((o) => {
    const nulls: unknown = o.nulls

    if (nulls !== undefined && nulls !== 'first' && nulls !== 'last') {
      throw new InvariantError('null placement must be first or last')
    }

    return `${qualifyColumn(o.column, relations, o.relation, resolveRelation)} ${o.direction === 'desc' ? 'desc' : 'asc'}${o.nulls === undefined ? '' : ` nulls ${o.nulls}`}`
  })

  return ` order by ${parts.join(', ')}`
}

/**
 * Compiles a JOIN clause.
 *
 * @param join - Join AST node.
 * @param relation - Resolved relation for the joined table.
 * @param params - Accumulator for parameterized values.
 * @param relations - Relations participating in the query.
 *
 * @returns SQL join clause
 */
function compileJoin(
  join: JoinAst,
  relation: PostgresRelation,
  params: unknown[],
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  const tableSql = qualifyPostgresQueryRelation(join.relation, resolveRelation)
  const tableAlias = quoteIdentifier(relation.alias)

  let type: string

  switch (join.type) {
    case 'inner':
      type = 'inner join'
      break
    case 'left':
      type = 'left join'
      break
    case 'right':
      type = 'right join'
      break
  }

  return ` ${type} ${tableSql} as ${tableAlias} on ${compilePredicate(join.on, params, relations, resolveRelation)}`
}

/**
 * Compiles a SELECT AST node to a parameterized query.
 *
 * @param node - Select AST node.
 *
 * @returns Compiled query with SQL string and parameters
 */
function compileSelect(
  node: SelectAst,
  resolveRelation: PostgresQueryRelationResolver,
  params: unknown[] = [],
): CompiledQuery {
  if (node.with?.length)
    return {
      sql: compileWithSelect(
        node,
        (query) => compileSelect(query, resolveRelation, params).sql,
        quoteIdentifier,
      ),
      params,
    }

  if (node.compound)
    return compileCompoundSelect(
      node,
      (operand) => compileSelect(operand, resolveRelation, params).sql,
      params,
      'postgresql',
    )

  const tableSql = qualifyPostgresQueryRelation(node.relation, resolveRelation)
  const relations = createRelationContext(
    [node.relation, ...(node.joins ?? []).map((join) => join.relation)],
    resolveRelation,
  )

  const tableAlias = quoteIdentifier(relations[0].alias)
  const selection = (node as Partial<SelectAst>).selection

  if (!Array.isArray(selection) || selection.length === 0) {
    throw new InvariantError('select items must not be empty')
  }

  const selectionSql = (selection as readonly SelectItemAst[])
    .map((item) => compileSelectItem(item, params, relations, resolveRelation))
    .join(', ')

  let sql = `select ${selectionSql} from ${tableSql} as ${tableAlias}`

  if (node.joins) {
    for (const [index, join] of node.joins.entries()) {
      sql += compileJoin(join, relations[index + 1], params, relations, resolveRelation)
    }
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
  relations: PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
  params: unknown[],
) {
  if (node.groupBy && node.groupBy.length > 0) {
    sql += ` group by ${node.groupBy.map((c) => compileQualifiedColumn(c, relations, resolveRelation)).join(', ')}`
  }

  if (node.having) {
    sql += ` having ${compilePredicate(node.having, params, relations, resolveRelation)}`
  }

  sql += compileOrderBy(node.orderBy, relations, resolveRelation)

  if (node.limit !== undefined) {
    params.push(node.limit)
    sql += ` limit $${params.length}`
  }

  if (node.offset !== undefined) {
    params.push(node.offset)
    sql += ` offset $${params.length}`
  }

  return sql
}

/**
 * Compiles an INSERT AST node to a parameterized query.
 *
 * @param node - Insert AST node.
 *
 * @returns Compiled query with SQL string and parameters
 */
function compileInsert(
  node: InsertAst,
  resolveRelation: PostgresQueryRelationResolver,
): CompiledQuery {
  if (
    !Array.isArray(node.columns) ||
    !Array.isArray(node.values) ||
    node.values.length === 0
  ) {
    throw new InvariantError('insert requires at least one values row')
  }

  const tableSql = qualifyPostgresQueryRelation(node.relation, resolveRelation)
  const values: InsertAst['values'] = node.values

  if (node.columns.length === 0) {
    if (values.length !== 1 || values[0]?.length !== 0) {
      throw new InvariantError(
        'PostgreSQL supports empty insert columns only as one DEFAULT VALUES row',
      )
    }

    const params: unknown[] = []
    const conflict = compileInsertConflict(node.conflict, params)

    return {
      sql: `insert into ${tableSql} default values${conflict}${compileReturning(node.returning)}`,
      params,
    }
  }

  const cols = node.columns
    .map((column) => {
      assertIdentifier(column, 'insert column')
      return quoteIdentifier(column)
    })
    .join(', ')

  const params: unknown[] = []
  const rowSql = values.map((row) => {
    const placeholders = row.map((value) => {
      if (value === undefined) return 'default'

      params.push(value)
      return `$${params.length}`
    })

    return `(${placeholders.join(', ')})`
  })

  const conflict = compileInsertConflict(node.conflict, params)
  const sql = `insert into ${tableSql} (${cols}) values ${rowSql.join(', ')}${conflict}${compileReturning(node.returning)}`
  return { sql, params }
}

/** Compiles a structured PostgreSQL insert conflict clause. */
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
      assertIdentifier(column, 'insert conflict target column')
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

/** Compiles one validated PostgreSQL conflict update assignment. */
function compileInsertConflictAssignment(input: unknown, params: unknown[]): string {
  if (typeof input !== 'object' || input === null) {
    throw new InvariantError('insert conflict update assignment is invalid')
  }

  const assignment = input as { readonly column?: unknown; readonly value?: unknown }
  assertIdentifier(assignment.column, 'insert conflict update column')

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
    assertIdentifier(structuredValue.column, 'excluded column')
    return `${quoteIdentifier(assignment.column)} = excluded.${quoteIdentifier(structuredValue.column)}`
  }

  if (structuredValue.kind !== 'value') {
    throw new InvariantError('unsupported insert conflict update value')
  }

  params.push(structuredValue.value)
  return `${quoteIdentifier(assignment.column)} = $${params.length}`
}

/**
 * Compiles an UPDATE AST node to a parameterized query.
 *
 * @param node - Update AST node.
 *
 * @returns Compiled query with SQL string and parameters
 *
 * @throws Error when SET clause is empty
 */
function compileUpdate(
  node: UpdateAst,
  resolveRelation: PostgresQueryRelationResolver,
): CompiledQuery {
  const tableSql = qualifyPostgresQueryRelation(node.relation, resolveRelation)
  const relations = createRelationContext([node.relation], resolveRelation)
  const tableAlias = quoteIdentifier(relations[0].alias)
  const params: unknown[] = []

  if (!Array.isArray(node.set) || node.set.length === 0) {
    throw new InvariantError('update requires at least one SET column')
  }

  const setSql = (node.set as UpdateAst['set'])
    .map((item) => {
      if (item.addition) {
        params.push(item.addition.delta)
        return `${quoteIdentifier(item.column)} = ${quoteIdentifier(relations[0].alias)}.${quoteIdentifier(item.addition.source)} + cast($${params.length} as numeric)`
      }

      params.push(item.value)
      return `${quoteIdentifier(item.column)} = $${params.length}`
    })
    .join(', ')

  const whereSql = compileWhereClause(node.where, params, relations, resolveRelation)
  const sql = `update ${tableSql} as ${tableAlias} set ${setSql}${whereSql}${compileReturning(node.returning)}`
  return { sql, params }
}

/**
 * Compiles a DELETE AST node to a parameterized query.
 *
 * @param node - Delete AST node.
 *
 * @returns Compiled query with SQL string and parameters
 */
function compileDelete(
  node: DeleteAst,
  resolveRelation: PostgresQueryRelationResolver,
): CompiledQuery {
  const tableSql = qualifyPostgresQueryRelation(node.relation, resolveRelation)
  const relations = createRelationContext([node.relation], resolveRelation)
  const tableAlias = quoteIdentifier(relations[0].alias)
  const params: unknown[] = []
  const whereSql = compileWhereClause(node.where, params, relations, resolveRelation)
  const sql = `delete from ${tableSql} as ${tableAlias}${whereSql}${compileReturning(node.returning)}`
  return { sql, params }
}

/** Adds the database precondition carried by explicitly database-qualified relations. */
function queryExpressionRelations(expression: SqlExprAst): RelationIdentityInput[] {
  if (expression.kind === 'scalar') return []
  if (expression.kind === 'outer') return []
  if (expression.kind === 'now') return []

  if (expression.kind === 'column') {
    return expression.relation === undefined ? [] : [expression.relation]
  }

  if (expression.kind === 'count_all') return []

  return expression.arg.relation === undefined ? [] : [expression.arg.relation]
}

/**
 * Collects relation references from nested query predicates.
 *
 * @param predicate - Predicate or predicate factory used to filter query results.
 *
 * @returns Relation references appearing in the predicate tree.
 */
function queryPredicateRelations(
  predicate: PredicateAst | undefined,
): RelationIdentityInput[] {
  if (predicate === undefined) return []

  if (predicate.kind === 'exists' || predicate.kind === 'inQuery')
    return predicate.kind === 'inQuery' ? queryExpressionRelations(predicate.left) : []

  if (predicate.kind === 'exprCmp')
    return [
      ...queryExpressionRelations(predicate.left),
      ...(predicate.right.kind === 'value'
        ? []
        : queryExpressionRelations(predicate.right)),
    ]

  if (predicate.kind === 'not') return queryPredicateRelations(predicate.pred)

  if (predicate.kind === 'and' || predicate.kind === 'or') {
    return predicate.preds.flatMap(queryPredicateRelations)
  }

  return [
    ...(predicate.relation === undefined ? [] : [predicate.relation]),
    ...(predicate.right?.relation === undefined ? [] : [predicate.right.relation]),
  ]
}

/**
 * Collects explicit relation references from select expressions and predicates.
 *
 * @param node - AST node or dependency-graph node being processed.
 *
 * @returns Relation references used by the select clauses.
 */
function selectRelationReferences(node: SelectAst): RelationIdentityInput[] {
  return [
    ...node.selection.flatMap((item) => {
      if (item.kind === 'all') return item.relation === undefined ? [] : [item.relation]

      if (item.kind === 'column') {
        return item.relation === undefined ? [] : [item.relation]
      }

      return queryExpressionRelations(item.expr)
    }),
    ...(node.joins ?? []).flatMap((join) => queryPredicateRelations(join.on)),
    ...queryPredicateRelations(node.where),
    ...(node.orderBy ?? []).flatMap((item) =>
      item.relation === undefined ? [] : [item.relation],
    ),
    ...(node.groupBy ?? []).flatMap((item) =>
      item.relation === undefined ? [] : [item.relation],
    ),
    ...queryPredicateRelations(node.having),
  ]
}

/**
 * Finds database and namespace evidence required for a query relation to be valid.
 *
 * @param physical - Observed physical namespace or relation-name reservation.
 * @param reference - Foreign-key target and referential actions.
 *
 * @returns The native namespace requirement for the resolved relation, when needed.
 */
function relationSessionRequirement(
  physical: PostgresQueryRelation,
  reference: PostgresQueryRelation,
): Readonly<{ database?: string; schema?: string }> | undefined {
  if (physical.table !== reference.table) return undefined

  if (
    physical.database !== undefined &&
    reference.database !== undefined &&
    physical.database !== reference.database
  ) {
    return undefined
  }

  if (
    physical.schema !== undefined &&
    reference.schema !== undefined &&
    physical.schema !== reference.schema
  ) {
    return undefined
  }

  return {
    ...(physical.database === undefined && reference.database !== undefined
      ? { database: reference.database }
      : reference.database === undefined && physical.database !== undefined
        ? { database: physical.database }
        : {}),
    ...(physical.schema === undefined && reference.schema !== undefined
      ? { schema: reference.schema }
      : reference.schema === undefined && physical.schema !== undefined
        ? { schema: physical.schema }
        : {}),
  }
}

/** Keeps prepared references with their owning occurrence's session requirements. */
function isLocalReference(
  reference: RelationIdentityInput,
  physicalRelations: readonly RelationIdentityInput[],
): boolean {
  const alias = (reference as RelationIdentityInput & { queryAlias?: string }).queryAlias
  return (
    alias === undefined ||
    physicalRelations.some(
      (physical) =>
        (physical as RelationIdentityInput & { queryAlias?: string }).queryAlias ===
        alias,
    )
  )
}

/**
 * Adds physical-session preconditions to a compiled PostgreSQL query.
 *
 * @param compiled - Compiled SQL, bound parameters, and optional session preconditions.
 * @param physicalRelations - Native relation inventory used for physical-name
 *   reservation.
 * @param references - Foreign-key references used by the fixture schema.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The compiled query with any required physical-session identity guard attached.
 */
function guardQuerySession(
  compiled: CompiledQuery,
  physicalRelations: readonly RelationIdentityInput[],
  references: readonly RelationIdentityInput[] = [],
  resolveRelation: PostgresQueryRelationResolver,
): CompiledQuery {
  const resolvedPhysical = physicalRelations
    .filter((relation) => !isCteRelation(relation))
    .map(resolveRelation)

  const requirements = collectSessionRequirements(
    resolvedPhysical,
    references.filter(
      (reference) =>
        !isCteRelation(reference) && isLocalReference(reference, physicalRelations),
    ),
    resolveRelation,
  )

  if (requirements.size === 0) return compiled

  return {
    ...compiled,
    /**
     * Rejects execution on a session that does not satisfy the compiled query's identity
     * requirements.
     */
    assertSession(identity) {
      compiled.assertSession?.(identity)
      const namespace = identity.namespaceContext?.writableDefault
      const database =
        namespace?.find((segment) => segment.role === 'database')?.spelling ??
        identity.database

      const schema = namespace?.find((segment) => segment.role === 'schema')?.spelling

      for (const requirement of requirements.values()) {
        if (requirement.database !== undefined && requirement.database !== database) {
          throw new QueryError({
            message: `PostgreSQL query database ${JSON.stringify(requirement.database)} does not match executing database ${JSON.stringify(database)}`,
          })
        }

        if (requirement.schema !== undefined && requirement.schema !== schema) {
          throw new QueryError({
            message: `PostgreSQL query schema ${JSON.stringify(requirement.schema)} does not match executing current schema ${JSON.stringify(schema)}`,
          })
        }
      }
    },
  }
}

/**
 * Collects and checks identity requirements introduced by resolved query relations.
 *
 * @param resolvedPhysical - Validated physical-name and namespace evidence.
 * @param references - Foreign-key references used by the fixture schema.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns And checks identity requirements introduced by resolved query relations.
 */
function collectSessionRequirements(
  resolvedPhysical: PostgresQueryRelation[],
  references: readonly Readonly<{
    namespace?: readonly NamespaceIdentifierInput[]
    relation: string
  }>[],
  resolveRelation: PostgresQueryRelationResolver,
) {
  const requirements = new Map<string, Readonly<{ database?: string; schema?: string }>>()

  for (const relation of resolvedPhysical) {
    if (relation.database !== undefined) {
      const requirement = { database: relation.database }
      requirements.set(JSON.stringify(requirement), requirement)
    }
  }

  for (const input of references) {
    const reference = resolveRelation(input)
    const matches = resolvedPhysical.flatMap((physical) => {
      const requirement = relationSessionRequirement(physical, reference)
      return requirement === undefined ? [] : [requirement]
    })

    const requirement = matches.length === 1 ? matches[0] : undefined

    if (
      requirement &&
      (requirement.database !== undefined || requirement.schema !== undefined)
    ) {
      requirements.set(JSON.stringify(requirement), requirement)
    }
  }

  return requirements
}

/** Preserves general and inferred-reference identity requirements for one select scope. */
function guardSelectSession(
  compiled: CompiledQuery,
  node: SelectAst,
  resolveRelation: PostgresQueryRelationResolver,
): CompiledQuery {
  if (node.compound) {
    return guardSelectSession(
      guardSelectSession(compiled, node.compound.left, resolveRelation),
      node.compound.right,
      resolveRelation,
    )
  }

  let guarded = guardQuerySession(
    compiled,
    [node.relation, ...(node.joins ?? []).map((join) => join.relation)],
    selectRelationReferences(node),
    resolveRelation,
  )

  for (const join of node.joins ?? []) {
    if (!join.reference) continue

    guarded = guardQuerySession(
      guarded,
      [join.reference.occurrence],
      [join.reference.relation],
      resolveRelation,
    )
  }

  return guarded
}

/**
 * Compiles a PostgreSQL AST node to a parameterized SQL query.
 *
 * @example
 *   compilePostgresQuery({
 *     kind: 'select',
 *     relation: { relation: 'users' },
 *     selection: [{ kind: 'all' }],
 *   })
 *   // { sql: 'select * from "public"."users"', params: [] }
 *
 * @param node - SQL AST node.
 *
 * @returns Compiled query with SQL string and bound parameters
 */
function compilePostgresQueryNode(
  node: SqlAst,
  resolveRelation: PostgresQueryRelationResolver = createPostgresQueryRelationResolver(),
): CompiledQuery {
  switch (node.kind) {
    case 'select':
      return guardSelectSession(
        compileSelect(node, resolveRelation),
        node,
        resolveRelation,
      )
    case 'insert':
      return guardQuerySession(
        compileInsert(node, resolveRelation),
        [node.relation],
        [],
        resolveRelation,
      )
    case 'update':
      return guardQuerySession(
        compileUpdate(node, resolveRelation),
        [node.relation],
        [...queryPredicateRelations(node.where)],
        resolveRelation,
      )
    case 'delete':
      return guardQuerySession(
        compileDelete(node, resolveRelation),
        [node.relation],
        [...queryPredicateRelations(node.where)],
        resolveRelation,
      )
  }
}

/**
 * Compiles column or value comparisons, including SQL's special null predicates.
 *
 * @param pred - Predicate whose values and relation references are being resolved.
 * @param params - Mutable bound-value list extended in emitted SQL order.
 * @param relations - Resolved query relations or requested catalog relations.
 * @param resolveRelation - Resolves authored relation intent under the selected query
 *   namespace rules.
 *
 * @returns The SQL fragment with bindings appended in emitted order.
 */
function compileComparison(
  pred: Extract<PredicateAst, { kind: 'cmp' }>,
  params: unknown[],
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  const left = qualifyColumn(pred.column, relations, pred.relation, resolveRelation)
  const op = comparisonSql(pred.op)

  if (pred.right) {
    return `${left} ${op} ${compileQualifiedColumn(pred.right, relations, resolveRelation)}`
  }

  if (pred.value !== null) {
    params.push(pred.value)
    return `${left} ${op} $${params.length}`
  }

  const nullComparison =
    pred.op === 'eq'
      ? `${left} is null`
      : pred.op === 'neq'
        ? `${left} is not null`
        : undefined

  if (nullComparison) return nullComparison

  throw new QueryError({ message: `comparison '${pred.op}' does not accept null` })
}

/** Compiles the complete statement and snapshots every nested session requirement. */
function compilePostgresQuery(
  node: SqlAst,
  resolveRelation: PostgresQueryRelationResolver = createPostgresQueryRelationResolver(),
): CompiledQuery {
  const compiled = compilePostgresQueryNode(node, resolveRelation)
  const guards: NonNullable<CompiledQuery['assertSession']>[] = compiled.assertSession
    ? [compiled.assertSession]
    : []

  collectNestedGuards(node, guards, resolveRelation)
  return guards.length
    ? {
        ...compiled,
        assertSession(identity) {
          for (const guard of guards) guard(identity)
        },
      }
    : compiled
}

function compileExpressionComparison(
  pred: Extract<PredicateAst, { kind: 'exprCmp' }>,
  params: unknown[],
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  const left = compileExpression(pred.left, params, relations, resolveRelation)

  if (pred.right.kind === 'value') {
    if (pred.right.value === null && (pred.op === 'eq' || pred.op === 'neq'))
      return `${left} is ${pred.op === 'neq' ? 'not ' : ''}null`

    params.push(pred.right.value)
    return `${left} ${comparisonSql(pred.op)} $${params.length}`
  }

  return `${left} ${comparisonSql(pred.op)} ${compileExpression(pred.right, params, relations, resolveRelation)}`
}

function collectNestedGuards(
  value: unknown,
  guards: NonNullable<CompiledQuery['assertSession']>[],
  resolveRelation: PostgresQueryRelationResolver,
): void {
  if (!value || typeof value !== 'object') return

  for (const [key, child] of Object.entries(value) as [string, unknown][]) {
    if (key === 'value' || key === 'values') continue

    if (
      child &&
      typeof child === 'object' &&
      'kind' in child &&
      child.kind === 'select'
    ) {
      const select = child as SelectAst
      const guard = guardSelectSession(
        { sql: '', params: [] },
        select,
        resolveRelation,
      ).assertSession

      guards.push(...(guard ? [guard] : []))
    }

    if (Array.isArray(child))
      child.forEach((value) => collectNestedGuards(value, guards, resolveRelation))
    else collectNestedGuards(child, guards, resolveRelation)
  }
}

function compileSingleSubquery(
  node: SelectAst,
  resolveRelation: PostgresQueryRelationResolver,
  params: unknown[],
): string {
  if (node.selection.length !== 1)
    throw new QueryError({
      message: 'Scalar and IN subqueries require exactly one projected value',
    })

  return compileSelect(node, resolveRelation, params).sql
}

export type { PostgresQueryRelation, PostgresQueryRelationResolver }

export {
  quoteIdentifier,
  createPostgresQueryRelationResolver,
  resolvePostgresQueryRelation,
  compilePostgresQuery,
}
