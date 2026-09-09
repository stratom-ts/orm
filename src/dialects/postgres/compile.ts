import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import type { RelationIdentityInput } from '@/schemas'
import { QueryError } from '@/utils/error'

import type {
  ComparisonOp,
  CompiledQuery,
  DeleteAst,
  InsertAst,
  JoinAst,
  OrderByAst,
  PredicateAst,
  QualifiedColumnAst,
  ReturningAst,
  SelectAst,
  SelectItemAst,
  SqlExprAst,
  UpdateAst,
} from '../types'

import type {
  PostgresAst,
  PostgresCreateTableAst,
  PostgresCreateTableColumnAst,
} from './migration/ast'
import { assertSafePostgresDataType, formatPostgresDefault } from './validate'

/**
 * Wraps an identifier in double quotes, escaping any internal quotes.
 *
 * @param ident - The identifier to quote (e.g. table name, column name)
 *
 * @returns Quoted identifier safe for SQL
 */
function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`
}

/**
 * Qualifies a table name with its schema, defaulting to `public`.
 *
 * @param schema - Schema/namespace name (defaults to `public`)
 * @param table - Table name.
 *
 * @returns Qualified table reference (e.g. `"public"."users"`)
 */
function qualifyPostgresTable(schema: string | undefined, table: string): string {
  const schemaName = schema ?? 'public'
  return `${quoteIdent(schemaName)}.${quoteIdent(table)}`
}

export type PostgresQueryRelation = {
  database?: string
  schema?: string
  table: string
}

export type PostgresQueryRelationResolver = (
  relation: RelationIdentityInput,
) => PostgresQueryRelation

/** Binds PostgreSQL query addressing to one client registration default. */
export function createPostgresQueryRelationResolver(
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
export function resolvePostgresQueryRelation(
  relation: RelationIdentityInput,
  registrationDefault?: readonly NamespaceIdentifierInput[],
): PostgresQueryRelation {
  if (typeof relation !== 'object' || relation === null) {
    throw new QueryError({
      message: 'PostgreSQL query relation must be an object',
    })
  }

  const candidate = relation as {
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
    return { schema: namespace[0]!.spelling, table: candidate.relation }
  }

  return {
    database: namespace[0]!.spelling,
    schema: namespace[1]!.spelling,
    table: candidate.relation,
  }
}

/** Qualifies a structured query relation after PostgreSQL namespace resolution. */
function qualifyPostgresQueryRelation(
  relation: RelationIdentityInput,
  resolveRelation: PostgresQueryRelationResolver,
): string {
  const resolved = resolveRelation(relation)
  return resolved.schema
    ? `${quoteIdent(resolved.schema)}.${quoteIdent(resolved.table)}`
    : quoteIdent(resolved.table)
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
    const candidate = candidates[index]!
    const alias =
      counts.get(candidate) === 1 && utf8ByteLength(candidate) <= 63
        ? candidate
        : `__stratom_${index}`
    return {
      ...(relation.database === undefined ? {} : { database: relation.database }),
      ...(relation.schema === undefined ? {} : { schema: relation.schema }),
      table: relation.table,
      alias,
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
  const resolved = resolveRelation(target)
  const exactMatches = relations.filter(
    (relation) =>
      relation.database === resolved.database &&
      relation.schema === resolved.schema &&
      relation.table === resolved.table,
  )
  if (exactMatches.length === 1) return exactMatches[0]!.alias

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
  if (matches.length === 1) return matches[0]!.alias

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

  if (returning.columns.length === 0) {
    throw new QueryError({ message: 'returning columns must not be empty' })
  }

  return ` returning ${returning.columns.map((c) => quoteIdent(c)).join(', ')}`
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
  const col = quoteIdent(column)
  return relation
    ? `${quoteIdent(resolveRelationAlias(relations, relation, resolveRelation))}.${col}`
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
    case 'cmp': {
      const left = qualifyColumn(pred.column, relations, pred.relation, resolveRelation)
      const op = comparisonSql(pred.op)

      if (pred.right) {
        return `${left} ${op} ${compileQualifiedColumn(pred.right, relations, resolveRelation)}`
      }

      if (pred.value === null) {
        if (pred.op === 'eq') return `${left} is null`
        if (pred.op === 'neq') return `${left} is not null`

        throw new QueryError({ message: `comparison '${pred.op}' does not accept null` })
      }

      params.push(pred.value)
      return `${left} ${op} $${params.length}`
    }
    case 'and': {
      if (pred.preds.length === 0) return 'true'

      if (pred.preds.length === 1)
        return compilePredicate(pred.preds[0]!, params, relations, resolveRelation)
      return `(${pred.preds.map((p) => compilePredicate(p, params, relations, resolveRelation)).join(' and ')})`
    }
    case 'or': {
      if (pred.preds.length === 0) return 'false'

      if (pred.preds.length === 1)
        return compilePredicate(pred.preds[0]!, params, relations, resolveRelation)
      return `(${pred.preds.map((p) => compilePredicate(p, params, relations, resolveRelation)).join(' or ')})`
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
function compileExpr(
  expr: SqlExprAst,
  params: unknown[],
  relations: readonly PostgresRelation[],
  resolveRelation: PostgresQueryRelationResolver,
): string {
  switch (expr.kind) {
    case 'column':
      return qualifyColumn(expr.column, relations, expr.relation, resolveRelation)
    case 'count_all':
      return 'count(*)'
    case 'count':
      return `count(${compileExpr(expr.arg, params, relations, resolveRelation)})`
    case 'min':
      return `min(${compileExpr(expr.arg, params, relations, resolveRelation)})`
    case 'max':
      return `max(${compileExpr(expr.arg, params, relations, resolveRelation)})`
    case 'sum':
      return `sum(${compileExpr(expr.arg, params, relations, resolveRelation)})`
    case 'lower':
      return `lower(${compileExpr(expr.arg, params, relations, resolveRelation)})`
    case 'upper':
      return `upper(${compileExpr(expr.arg, params, relations, resolveRelation)})`
    case 'length':
      return `length(${compileExpr(expr.arg, params, relations, resolveRelation)})`
    case 'now':
      return 'now()'
    case 'date_trunc': {
      params.push(expr.unit)
      const unitParam = `$${params.length}`
      return `date_trunc(${unitParam}, ${compileExpr(expr.arg, params, relations, resolveRelation)})`
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
        ? `${quoteIdent(resolveRelationAlias(relations, item.relation, resolveRelation))}.*`
        : '*'
    case 'column': {
      const col = qualifyColumn(item.column, relations, item.relation, resolveRelation)
      return item.alias ? `${col} as ${quoteIdent(item.alias)}` : col
    }
    case 'expr':
      return `${compileExpr(item.expr, params, relations, resolveRelation)} as ${quoteIdent(item.alias)}`
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

  const parts = orderBy.map(
    (o) =>
      `${qualifyColumn(o.column, relations, o.relation, resolveRelation)} ${o.direction === 'desc' ? 'desc' : 'asc'}`,
  )
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
  const tableAlias = quoteIdent(relation.alias)

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
): CompiledQuery {
  const tableSql = qualifyPostgresQueryRelation(node.relation, resolveRelation)
  const relations = createRelationContext(
    [node.relation, ...(node.joins ?? []).map((join) => join.relation)],
    resolveRelation,
  )
  const tableAlias = quoteIdent(relations[0]!.alias)
  const params: unknown[] = []

  if (!node.selection || node.selection.length === 0) {
    throw new QueryError({ message: 'select items must not be empty' })
  }

  const selection = node.selection
    .map((item) => compileSelectItem(item, params, relations, resolveRelation))
    .join(', ')
  let sql = `select ${selection} from ${tableSql} as ${tableAlias}`

  if (node.joins) {
    for (const [index, join] of node.joins.entries()) {
      sql += compileJoin(join, relations[index + 1]!, params, relations, resolveRelation)
    }
  }

  sql += compileWhereClause(node.where, params, relations, resolveRelation)

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

  return { sql, params }
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
  const tableSql = qualifyPostgresQueryRelation(node.relation, resolveRelation)
  const cols = node.columns.map((c) => quoteIdent(c)).join(', ')
  const params: unknown[] = []
  const rowSql = node.values.map((row) => {
    const placeholders = row.map((value) => {
      if (value === undefined) return 'default'

      params.push(value)
      return `$${params.length}`
    })
    return `(${placeholders.join(', ')})`
  })
  const sql = `insert into ${tableSql} (${cols}) values ${rowSql.join(', ')}${compileReturning(node.returning)}`
  return { sql, params }
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
  const tableAlias = quoteIdent(relations[0]!.alias)
  const params: unknown[] = []

  if (node.set.length === 0) {
    throw new QueryError({ message: 'update requires at least one SET column' })
  }

  const setSql = node.set
    .map((item) => {
      params.push(item.value)
      return `${quoteIdent(item.column)} = $${params.length}`
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
  const tableAlias = quoteIdent(relations[0]!.alias)
  const params: unknown[] = []
  const whereSql = compileWhereClause(node.where, params, relations, resolveRelation)
  const sql = `delete from ${tableSql} as ${tableAlias}${whereSql}${compileReturning(node.returning)}`
  return { sql, params }
}

/** Adds the database precondition carried by explicitly database-qualified relations. */
function queryExpressionRelations(expression: SqlExprAst): RelationIdentityInput[] {
  if (expression.kind === 'now') return []

  if (expression.kind === 'column') {
    return expression.relation === undefined ? [] : [expression.relation]
  }

  if (expression.kind === 'count_all') return []

  return expression.arg.relation === undefined ? [] : [expression.arg.relation]
}

function queryPredicateRelations(
  predicate: PredicateAst | undefined,
): RelationIdentityInput[] {
  if (predicate === undefined) return []

  if (predicate.kind === 'not') return queryPredicateRelations(predicate.pred)

  if (predicate.kind === 'and' || predicate.kind === 'or') {
    return predicate.preds.flatMap(queryPredicateRelations)
  }

  return [
    ...(predicate.relation === undefined ? [] : [predicate.relation]),
    ...(predicate.right?.relation === undefined ? [] : [predicate.right.relation]),
  ]
}

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

function guardQuerySession(
  compiled: CompiledQuery,
  physicalRelations: readonly RelationIdentityInput[],
  references: readonly RelationIdentityInput[] = [],
  resolveRelation: PostgresQueryRelationResolver,
): CompiledQuery {
  const resolvedPhysical = physicalRelations.map(resolveRelation)
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

    if (matches.length === 1) {
      const requirement = matches[0]!

      if (requirement.database !== undefined || requirement.schema !== undefined) {
        requirements.set(JSON.stringify(requirement), requirement)
      }
    }
  }

  if (requirements.size === 0) return compiled

  return {
    ...compiled,
    assertSession(identity) {
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
 * Formats a referential action (ON DELETE / ON UPDATE) to uppercase SQL.
 *
 * @param action - Action string (e.g. `cascade`, `restrict`)
 *
 * @returns Uppercase action for DDL
 */
function formatReferentialAction(action: string): string {
  return action.toUpperCase()
}

/**
 * Compiles a single column definition for CREATE TABLE DDL.
 *
 * @param col - Column AST node.
 * @param isPrimaryKey - Whether this column is the primary key.
 *
 * @returns SQL column definition fragment
 */
function compileColumnDefinition(
  col: PostgresCreateTableColumnAst,
  isPrimaryKey = false,
): string {
  const safeType = assertSafePostgresDataType(col.dataType)
  const parts: string[] = [quoteIdent(col.name), safeType]

  if (col.generated === 'always') {
    parts.push('generated always as identity')
  } else if (col.generated === 'byDefault') {
    parts.push('generated by default as identity')
  } else if (col.autoIncrement) {
    parts.push('generated by default as identity')
  }

  if (col.notNull) parts.push('not null')
  if (isPrimaryKey) parts.push('primary key')

  if (col.unique) {
    if (col.uniqueConstraintName) {
      parts.push(`constraint ${quoteIdent(col.uniqueConstraintName)} unique`)
    } else {
      parts.push('unique')
    }
  }

  if (col.databaseDefault !== undefined && !col.generated && !col.autoIncrement) {
    parts.push(`default ${col.databaseDefault.sql}`)
  } else if (col.defaultValue !== undefined && !col.generated && !col.autoIncrement) {
    parts.push(`default ${formatPostgresDefault(col.defaultValue)}`)
  }

  if (col.references) {
    const refTable = qualifyPostgresTable(col.references.schema, col.references.table)
    const refCol = quoteIdent(col.references.column)
    let ref = `references ${refTable} (${refCol})`

    if (col.references.onDelete) {
      ref += ` on delete ${formatReferentialAction(col.references.onDelete)}`
    }

    if (col.references.onUpdate) {
      ref += ` on update ${formatReferentialAction(col.references.onUpdate)}`
    }

    parts.push(ref)
  }

  return parts.join(' ')
}

/**
 * Compiles a CREATE TABLE AST node to DDL SQL.
 *
 * @param node - Create table AST node.
 *
 * @returns CREATE TABLE DDL statement
 */
function compileCreateTable(node: PostgresCreateTableAst): string {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const primaryKey = [...node.primaryKey]
  const singlePk = primaryKey.length === 1 ? primaryKey[0] : undefined

  const columnSql = node.columns.map((col) => {
    if (singlePk && col.name === singlePk) {
      if (node.primaryKeyName) {
        return compileColumnDefinition(col)
      }

      return compileColumnDefinition(col, true)
    }

    return compileColumnDefinition(col)
  })

  if (primaryKey.length > 1 || node.primaryKeyName) {
    const name = node.primaryKeyName
      ? `constraint ${quoteIdent(node.primaryKeyName)} `
      : ''
    columnSql.push(
      `${name}primary key (${primaryKey.map((c) => quoteIdent(c)).join(', ')})`,
    )
  }

  return `create table ${tableSql} (${columnSql.join(', ')})`
}

/**
 * Compiles a CREATE INDEX AST node to DDL SQL.
 *
 * @param node - Index definition.
 *
 * @returns CREATE INDEX DDL statement
 */
function compileCreateIndex(node: {
  schema?: string
  table: string
  name: string
  columns: readonly string[]
  unique: boolean
}): string {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const unique = node.unique ? 'unique ' : ''
  const cols = node.columns.map((c) => quoteIdent(c)).join(', ')
  return `create ${unique}index ${quoteIdent(node.name)} on ${tableSql} (${cols})`
}

/**
 * Compiles an ADD COLUMN AST node to DDL SQL.
 *
 * @param node - Add column definition.
 *
 * @returns ALTER TABLE ADD COLUMN DDL statement
 */
function compileAddColumn(node: {
  schema?: string
  table: string
  column: PostgresCreateTableColumnAst
}): string {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  return `alter table ${tableSql} add column ${compileColumnDefinition(node.column)}`
}

/**
 * Compiles an ADD FOREIGN KEY AST node to DDL SQL.
 *
 * @example
 *   compileAddForeignKey({ table: 'posts', column: 'author_id', references: { table: 'users', column: 'id' } })
 *
 * @param node - Add foreign key definition.
 *
 * @returns ALTER TABLE ADD FOREIGN KEY DDL statement
 */
function compileAddForeignKey(node: {
  schema?: string
  table: string
  column: string
  name?: string
  references: {
    schema?: string
    table: string
    column: string
    onDelete?: string
    onUpdate?: string
  }
}): string {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const referenceTableSql = qualifyPostgresTable(
    node.references.schema,
    node.references.table,
  )
  const constraint = node.name ? `constraint ${quoteIdent(node.name)} ` : ''
  let sql = `alter table ${tableSql} add ${constraint}foreign key (${quoteIdent(node.column)}) references ${referenceTableSql} (${quoteIdent(node.references.column)})`

  if (node.references.onDelete) {
    sql += ` on delete ${formatReferentialAction(node.references.onDelete)}`
  }

  if (node.references.onUpdate) {
    sql += ` on update ${formatReferentialAction(node.references.onUpdate)}`
  }

  return sql
}

/**
 * Compiles an ADD UNIQUE CONSTRAINT AST node to DDL SQL.
 *
 * @param node - Unique constraint definition.
 */
function compileAddUniqueConstraint(node: {
  schema?: string
  table: string
  column: string
  name: string
}): string {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  return `alter table ${tableSql} add constraint ${quoteIdent(node.name)} unique (${quoteIdent(node.column)})`
}

/**
 * Compiles a PostgreSQL AST node to a parameterized SQL query.
 *
 * @example
 *   compilePostgres({
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
export function compilePostgres(
  node: PostgresAst,
  resolveRelation: PostgresQueryRelationResolver = createPostgresQueryRelationResolver(),
): CompiledQuery {
  switch (node.kind) {
    case 'select':
      return guardQuerySession(
        compileSelect(node, resolveRelation),
        [node.relation, ...(node.joins ?? []).map((join) => join.relation)],
        selectRelationReferences(node),
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
    case 'create_schema':
      return {
        sql: `create schema if not exists ${quoteIdent(node.schema)}`,
        params: [],
      }
    case 'create_table':
      return { sql: compileCreateTable(node), params: [] }
    case 'create_index':
      return { sql: compileCreateIndex(node), params: [] }
    case 'add_column':
      return { sql: compileAddColumn(node), params: [] }
    case 'add_unique_constraint':
      return { sql: compileAddUniqueConstraint(node), params: [] }
    case 'add_foreign_key':
      return { sql: compileAddForeignKey(node), params: [] }
    case 'alter_column_type': {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      const safeType = assertSafePostgresDataType(node.dataType)
      return {
        sql: `alter table ${tableSql} alter column ${quoteIdent(node.column)} type ${safeType}`,
        params: [],
      }
    }
    case 'set_not_null': {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return {
        sql: `alter table ${tableSql} alter column ${quoteIdent(node.column)} set not null`,
        params: [],
      }
    }
    case 'drop_not_null': {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return {
        sql: `alter table ${tableSql} alter column ${quoteIdent(node.column)} drop not null`,
        params: [],
      }
    }
    case 'drop_column': {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return {
        sql: `alter table ${tableSql} drop column ${quoteIdent(node.column)}`,
        params: [],
      }
    }
    case 'drop_table': {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return {
        sql: `drop table ${tableSql}`,
        params: [],
      }
    }
    case 'drop_index': {
      const schemaName = node.schema ?? 'public'
      return {
        sql: `drop index ${quoteIdent(schemaName)}.${quoteIdent(node.index)}`,
        params: [],
      }
    }
    default: {
      const _exhaustive: never = node
      return _exhaustive
    }
  }
}
