import type {
  ComparisonOp,
  CompiledQuery,
  CreateTableAst,
  CreateTableColumnAst,
  DeleteAst,
  InsertAst,
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

function postgresTableAlias(schema: string | undefined, table: string): string {
  return `${schema ?? 'public'}.${table}`
}

type PostgresRelation = {
  schema: string
  table: string
  alias: string
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

function createRelationContext(
  relations: readonly { schema?: string; table: string }[],
): PostgresRelation[] {
  const candidates = relations.map((relation) =>
    postgresTableAlias(relation.schema, relation.table),
  )
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    counts.set(candidate, (counts.get(candidate) ?? 0) + 1)
  }

  return relations.map((relation, index) => {
    const candidate = candidates[index]!
    const alias =
      counts.get(candidate) === 1 && utf8ByteLength(candidate) <= 63
        ? candidate
        : `__stratom_${index}`
    return {
      schema: relation.schema ?? 'public',
      table: relation.table,
      alias,
    }
  })
}

function resolveRelationAlias(
  relations: readonly PostgresRelation[],
  table: string,
  schema?: string,
): string {
  const matches = relations.filter(
    (relation) =>
      relation.table === table && (schema === undefined || relation.schema === schema),
  )
  if (matches.length === 1) return matches[0]!.alias
  if (matches.length === 0) {
    throw new Error(
      `table reference "${schema ? `${schema}.` : ''}${table}" is not in query`,
    )
  }
  throw new Error(`table reference "${table}" is ambiguous; specify its schema`)
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
    throw new Error('returning columns must not be empty')
  }
  return ` returning ${returning.columns.map((c) => quoteIdent(c)).join(', ')}`
}

/**
 * Qualifies a column name with an optional table prefix.
 *
 * @param column - Column name.
 * @param table - Optional table name.
 *
 * @returns Qualified column reference (e.g. `"users"."id"`)
 */
function qualifyColumn(
  column: string,
  relations: readonly PostgresRelation[],
  table?: string,
  schema?: string,
): string {
  const col = quoteIdent(column)
  return table
    ? `${quoteIdent(resolveRelationAlias(relations, table, schema))}.${col}`
    : col
}

/**
 * Compiles a qualified column AST node to SQL.
 *
 * @param col - Qualified column AST node.
 *
 * @returns SQL column reference
 */
function compileQualifiedColumn(
  col: QualifiedColumnAst,
  relations: readonly PostgresRelation[],
): string {
  return qualifyColumn(col.column, relations, col.table, col.schema)
}

/**
 * Compiles a predicate AST node to a SQL WHERE / ON condition.
 *
 * @param pred - Predicate AST node.
 * @param params - Accumulator for parameterized values.
 *
 * @returns SQL condition string
 */
function compilePredicate(
  pred: PredicateAst,
  params: unknown[],
  relations: readonly PostgresRelation[],
): string {
  switch (pred.kind) {
    case 'cmp': {
      const left = qualifyColumn(pred.column, relations, pred.table, pred.schema)
      const op = comparisonSql(pred.op)
      if (pred.right) {
        return `${left} ${op} ${compileQualifiedColumn(pred.right, relations)}`
      }
      if (pred.value === null) {
        if (pred.op === 'eq') return `${left} is null`
        if (pred.op === 'neq') return `${left} is not null`
        throw new Error(`comparison '${pred.op}' does not accept null`)
      }
      params.push(pred.value)
      return `${left} ${op} $${params.length}`
    }
    case 'and': {
      if (pred.preds.length === 0) return 'true'
      if (pred.preds.length === 1)
        return compilePredicate(pred.preds[0]!, params, relations)
      return `(${pred.preds.map((p) => compilePredicate(p, params, relations)).join(' and ')})`
    }
    case 'or': {
      if (pred.preds.length === 0) return 'false'
      if (pred.preds.length === 1)
        return compilePredicate(pred.preds[0]!, params, relations)
      return `(${pred.preds.map((p) => compilePredicate(p, params, relations)).join(' or ')})`
    }
    case 'not':
      return `(not ${compilePredicate(pred.pred, params, relations)})`
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
 *
 * @returns SQL where clause, or empty string
 */
function compileWhereClause(
  where: PredicateAst | undefined,
  params: unknown[],
  relations: readonly PostgresRelation[],
): string {
  if (!where) return ''
  return ` where ${compilePredicate(where, params, relations)}`
}

/**
 * Compiles a scalar SQL expression (select list, having, etc.).
 *
 * @param expr - Expression AST node.
 * @param params - Accumulator for parameterized values.
 *
 * @returns SQL expression string
 */
function compileExpr(
  expr: SqlExprAst,
  params: unknown[],
  relations: readonly PostgresRelation[],
): string {
  switch (expr.kind) {
    case 'column':
      return qualifyColumn(expr.column, relations, expr.table, expr.schema)
    case 'count_all':
      return 'count(*)'
    case 'count':
      return `count(${compileExpr(expr.arg, params, relations)})`
    case 'min':
      return `min(${compileExpr(expr.arg, params, relations)})`
    case 'max':
      return `max(${compileExpr(expr.arg, params, relations)})`
    case 'sum':
      return `sum(${compileExpr(expr.arg, params, relations)})`
    case 'lower':
      return `lower(${compileExpr(expr.arg, params, relations)})`
    case 'upper':
      return `upper(${compileExpr(expr.arg, params, relations)})`
    case 'length':
      return `length(${compileExpr(expr.arg, params, relations)})`
    case 'now':
      return 'now()'
    case 'date_trunc': {
      params.push(expr.unit)
      const unitParam = `$${params.length}`
      return `date_trunc(${unitParam}, ${compileExpr(expr.arg, params, relations)})`
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
 *
 * @returns SQL select item expression
 */
function compileSelectItem(
  item: SelectItemAst,
  params: unknown[],
  relations: readonly PostgresRelation[],
): string {
  switch (item.kind) {
    case 'all':
      return item.table
        ? `${quoteIdent(resolveRelationAlias(relations, item.table, item.schema))}.*`
        : '*'
    case 'column': {
      const col = qualifyColumn(item.column, relations, item.table, item.schema)
      return item.alias ? `${col} as ${quoteIdent(item.alias)}` : col
    }
    case 'expr':
      return `${compileExpr(item.expr, params, relations)} as ${quoteIdent(item.alias)}`
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
 *
 * @returns SQL order by clause, or empty string
 */
function compileOrderBy(
  orderBy: readonly OrderByAst[] | undefined,
  relations: readonly PostgresRelation[],
): string {
  if (!orderBy || orderBy.length === 0) return ''
  const parts = orderBy.map(
    (o) =>
      `${qualifyColumn(o.column, relations, o.table, o.schema)} ${o.direction === 'desc' ? 'desc' : 'asc'}`,
  )
  return ` order by ${parts.join(', ')}`
}

/**
 * Compiles a JOIN clause.
 *
 * @param join - Join AST node.
 * @param params - Accumulator for parameterized values.
 *
 * @returns SQL join clause
 */
function compileJoin(
  join: JoinAst,
  relation: PostgresRelation,
  params: unknown[],
  relations: readonly PostgresRelation[],
): string {
  const tableSql = qualifyPostgresTable(join.schema, join.table)
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

  return ` ${type} ${tableSql} as ${tableAlias} on ${compilePredicate(join.on, params, relations)}`
}

/**
 * Compiles a SELECT AST node to a parameterized query.
 *
 * @param node - Select AST node.
 *
 * @returns Compiled query with SQL string and parameters
 */
function compileSelect(node: SelectAst): CompiledQuery {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const relations = createRelationContext([
    { table: node.table, ...(node.schema !== undefined ? { schema: node.schema } : {}) },
    ...(node.joins ?? []),
  ])
  const tableAlias = quoteIdent(relations[0]!.alias)
  const params: unknown[] = []
  if (!node.selection || node.selection.length === 0) {
    throw new Error('select items must not be empty')
  }
  const selection = node.selection
    .map((item) => compileSelectItem(item, params, relations))
    .join(', ')
  let sql = `select ${selection} from ${tableSql} as ${tableAlias}`
  if (node.joins) {
    for (const [index, join] of node.joins.entries()) {
      sql += compileJoin(join, relations[index + 1]!, params, relations)
    }
  }
  sql += compileWhereClause(node.where, params, relations)
  if (node.groupBy && node.groupBy.length > 0) {
    sql += ` group by ${node.groupBy.map((c) => compileQualifiedColumn(c, relations)).join(', ')}`
  }
  if (node.having) {
    sql += ` having ${compilePredicate(node.having, params, relations)}`
  }
  sql += compileOrderBy(node.orderBy, relations)
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
function compileInsert(node: InsertAst): CompiledQuery {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
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
function compileUpdate(node: UpdateAst): CompiledQuery {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const relations = createRelationContext([node])
  const tableAlias = quoteIdent(relations[0]!.alias)
  const params: unknown[] = []
  if (node.set.length === 0) {
    throw new Error('update requires at least one SET column')
  }
  const setSql = node.set
    .map((item) => {
      params.push(item.value)
      return `${quoteIdent(item.column)} = $${params.length}`
    })
    .join(', ')
  const whereSql = compileWhereClause(node.where, params, relations)
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
function compileDelete(node: DeleteAst): CompiledQuery {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const relations = createRelationContext([node])
  const tableAlias = quoteIdent(relations[0]!.alias)
  const params: unknown[] = []
  const whereSql = compileWhereClause(node.where, params, relations)
  const sql = `delete from ${tableSql} as ${tableAlias}${whereSql}${compileReturning(node.returning)}`
  return { sql, params }
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
  col: CreateTableColumnAst,
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

  if (col.defaultValue !== undefined && !col.generated && !col.autoIncrement) {
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
function compileCreateTable(node: CreateTableAst): string {
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
  column: CreateTableColumnAst
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
 *   compilePostgres({ kind: 'select', table: 'users', selection: [{ kind: 'all' }] })
 *   // { sql: 'select * from "public"."users"', params: [] }
 *
 * @param node - SQL AST node.
 *
 * @returns Compiled query with SQL string and bound parameters
 */
export function compilePostgres(node: SqlAst): CompiledQuery {
  switch (node.kind) {
    case 'select':
      return compileSelect(node)
    case 'insert':
      return compileInsert(node)
    case 'update':
      return compileUpdate(node)
    case 'delete':
      return compileDelete(node)
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
