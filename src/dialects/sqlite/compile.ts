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
  ReturningAst,
  SelectAst,
  SelectItemAst,
  SqlAst,
  SqlExprAst,
  UpdateAst,
} from '../types'

import { asciiFoldSqliteIdentifier } from './identity'

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function assertNonEmptyString(
  value: unknown,
  description: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new QueryError({ message: `${description} must be a non-empty string` })
  }
}

function assertMainNamespace(
  value: unknown,
  description: string,
): asserts value is readonly NamespaceIdentifierInput[] {
  if (!Array.isArray(value) || value.length !== 1) {
    throw new QueryError({
      message: `${description} must contain exactly one database:main segment`,
    })
  }

  const segment = value[0]

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
  if (typeof relation !== 'object' || relation === null) {
    throw new QueryError({ message: 'SQLite query relation must be an object' })
  }

  const candidate = relation as { relation?: unknown; namespace?: unknown }
  assertNonEmptyString(candidate.relation, 'SQLite query relation name')
  resolveSqliteQueryNamespace(candidate.namespace, registrationDefault)

  return {
    database: 'main',
    table: candidate.relation,
    tableKey: asciiFoldSqliteIdentifier(candidate.relation),
  }
}

function qualifySqliteQueryRelation(
  relation: RelationIdentityInput,
  resolveRelation: SqliteQueryRelationResolver,
): string {
  const resolved = resolveRelation(relation)
  return `${quoteIdentifier(resolved.database)}.${quoteIdentifier(resolved.table)}`
}

type SqliteRelation = SqliteQueryRelation & Readonly<{ alias: string }>

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
    return { ...relation, alias }
  })
}

function resolveRelationAlias(
  relations: readonly SqliteRelation[],
  target: RelationIdentityInput,
  resolveRelation: SqliteQueryRelationResolver,
): string {
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
      throw new QueryError({ message: `unsupported SQLite comparison ${String(op)}` })
  }
}

function compileReturning(returning: ReturningAst | undefined): string {
  if (!returning) return ''
  if (returning.kind === 'all') return ' returning *'

  if (returning.kind !== 'columns' || returning.columns.length === 0) {
    throw new QueryError({ message: 'returning columns must not be empty' })
  }

  return ` returning ${returning.columns
    .map((column) => {
      assertNonEmptyString(column, 'returning column')
      return quoteIdentifier(column)
    })
    .join(', ')}`
}

function qualifyColumn(
  column: string,
  relations: readonly SqliteRelation[],
  relation: RelationIdentityInput | undefined,
  resolveRelation: SqliteQueryRelationResolver,
): string {
  assertNonEmptyString(column, 'SQLite query column')
  const quoted = quoteIdentifier(column)
  return relation
    ? `${quoteIdentifier(resolveRelationAlias(relations, relation, resolveRelation))}.${quoted}`
    : quoted
}

function compilePredicate(
  predicate: PredicateAst,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  switch (predicate.kind) {
    case 'cmp': {
      const left = qualifyColumn(
        predicate.column,
        relations,
        predicate.relation,
        resolveRelation,
      )
      const op = comparisonSql(predicate.op)

      if (predicate.right !== undefined) {
        if (Object.hasOwn(predicate, 'value')) {
          throw new QueryError({
            message: 'comparison cannot contain both right and value',
          })
        }

        return `${left} ${op} ${qualifyColumn(predicate.right.column, relations, predicate.right.relation, resolveRelation)}`
      }

      if (predicate.value === null) {
        if (predicate.op === 'eq') return `${left} is null`
        if (predicate.op === 'neq') return `${left} is not null`

        throw new QueryError({
          message: `comparison '${predicate.op}' does not accept null`,
        })
      }

      params.push(predicate.value)
      return `${left} ${op} ?`
    }
    case 'and':
      if (!Array.isArray(predicate.preds)) {
        throw new QueryError({ message: 'and predicate requires a predicate array' })
      }

      if (predicate.preds.length === 0) {
        throw new QueryError({ message: 'and predicate must not be empty' })
      }

      if (predicate.preds.length === 1)
        return compilePredicate(predicate.preds[0]!, params, relations, resolveRelation)

      return `(${predicate.preds
        .map((item) => compilePredicate(item, params, relations, resolveRelation))
        .join(' and ')})`
    case 'or':
      if (!Array.isArray(predicate.preds)) {
        throw new QueryError({ message: 'or predicate requires a predicate array' })
      }

      if (predicate.preds.length === 0) {
        throw new QueryError({ message: 'or predicate must not be empty' })
      }

      if (predicate.preds.length === 1)
        return compilePredicate(predicate.preds[0]!, params, relations, resolveRelation)

      return `(${predicate.preds
        .map((item) => compilePredicate(item, params, relations, resolveRelation))
        .join(' or ')})`
    case 'not':
      return `(not ${compilePredicate(predicate.pred, params, relations, resolveRelation)})`
    default:
      throw new QueryError({ message: 'unsupported SQLite predicate' })
  }
}

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

function compileExpression(
  expression: SqlExprAst,
  params: unknown[],
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  switch (expression.kind) {
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
      throw new QueryError({ message: 'unsupported SQLite expression' })
  }
}

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

      if (item.alias === undefined) return column

      assertNonEmptyString(item.alias, 'select alias')
      return `${column} as ${quoteIdentifier(item.alias)}`
    }
    case 'expr':
      assertNonEmptyString(item.alias, 'select alias')
      return `${compileExpression(item.expr, params, relations, resolveRelation)} as ${quoteIdentifier(item.alias)}`
    default:
      throw new QueryError({ message: 'unsupported SQLite select item' })
  }
}

function compileOrderBy(
  orderBy: readonly OrderByAst[] | undefined,
  relations: readonly SqliteRelation[],
  resolveRelation: SqliteQueryRelationResolver,
): string {
  if (!orderBy || orderBy.length === 0) return ''

  return ` order by ${orderBy
    .map((item) => {
      if (item.direction !== 'asc' && item.direction !== 'desc') {
        throw new QueryError({ message: 'order direction must be asc or desc' })
      }

      return `${qualifyColumn(item.column, relations, item.relation, resolveRelation)} ${item.direction}`
    })
    .join(', ')}`
}

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

function assertPagination(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new QueryError({
      message: `${description} must be a non-negative safe integer`,
    })
  }
}

function compileSelect(
  node: SelectAst,
  resolveRelation: SqliteQueryRelationResolver,
): CompiledQuery {
  if (!Array.isArray(node.selection)) {
    throw new QueryError({ message: 'select items must be an array' })
  }

  const relations = createRelationContext(
    [node.relation, ...(node.joins ?? []).map((join) => join.relation)],
    resolveRelation,
  )
  const params: unknown[] = []
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

  return { sql, params }
}

function compileInsert(
  node: InsertAst,
  resolveRelation: SqliteQueryRelationResolver,
): CompiledQuery {
  if (
    !Array.isArray(node.columns) ||
    !Array.isArray(node.values) ||
    node.values.length === 0
  ) {
    throw new QueryError({ message: 'insert requires at least one values row' })
  }

  const table = qualifySqliteQueryRelation(node.relation, resolveRelation)

  if (node.columns.length === 0) {
    if (node.values.length !== 1 || node.values[0]?.length !== 0) {
      throw new QueryError({
        message: 'SQLite supports empty insert columns only as one DEFAULT VALUES row',
      })
    }

    return {
      sql: `insert into ${table} default values${compileReturning(node.returning)}`,
      params: [],
    }
  }

  const columns = node.columns.map((column) => {
    assertNonEmptyString(column, 'insert column')
    return quoteIdentifier(column)
  })
  const params: unknown[] = []
  const values = node.values.map((row) => {
    if (!Array.isArray(row) || row.length !== node.columns.length) {
      throw new QueryError({ message: 'insert row width must match its columns' })
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

  return {
    sql: `insert into ${table} (${columns.join(', ')}) values ${values.join(', ')}${compileReturning(node.returning)}`,
    params,
  }
}

function compileUpdate(
  node: UpdateAst,
  resolveRelation: SqliteQueryRelationResolver,
): CompiledQuery {
  if (!Array.isArray(node.set) || node.set.length === 0) {
    throw new QueryError({ message: 'update requires at least one SET column' })
  }

  if (!node.where && node.allowAll !== true) {
    throw new QueryError({ message: 'full-table update requires allowAll' })
  }

  const relations = createRelationContext([node.relation], resolveRelation)
  const params: unknown[] = []

  const assignments = node.set
    .map((item) => {
      assertNonEmptyString(item.column, 'update column')
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
export function compileSqlite(
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
      throw new QueryError({ message: 'unsupported SQLite query AST' })
  }
}
