import { QueryError } from '@/utils/error'

import type {
  ComparisonOp,
  CompiledQuery,
  CreateTableAst,
  CreateTableColumnAst,
  DeleteAst,
  InsertAst,
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

import { assertSafeSqliteDataType, formatSqliteLiteral } from './validate'

const q = (name: string) => `"${name.replaceAll('"', '""')}"`
function foldAscii(value: string): string {
  let result = ''
  for (const c of value) {
    const code = c.charCodeAt(0)
    result += code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : c
  }
  return result
}
function isMain(schema: string | undefined): boolean {
  return schema === undefined || foldAscii(schema) === 'main'
}
function assertMain(schema: string | undefined, description: string): void {
  if (!isMain(schema))
    throw new QueryError({
      message: `SQLite only supports database main for ${description}`,
    })
}
const table = (schema: string | undefined, name: string) => (
  assertMain(schema, 'table'),
  `${q('main')}.${q(name)}`
)
const referenceTable = (schema: string | undefined, name: string) => {
  assertMain(schema, 'foreign-key references')
  return q(name)
}
const op = (value: ComparisonOp) =>
  ({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' })[value]
type Relation = { table: string; schema: string; alias: string }

function relationsFor(items: readonly { table: string; schema?: string }[]): Relation[] {
  for (const item of items) assertMain(item.schema, 'query relations')
  const names = items.map((x) => `${foldAscii(x.schema ?? 'main')}.${foldAscii(x.table)}`)
  const counts = new Map<string, number>()
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1)
  return items.map((x, i) => ({
    table: x.table,
    schema: x.schema ?? 'main',
    alias: counts.get(names[i]!) === 1 ? names[i]! : `__stratom_${i}`,
  }))
}
function aliasOf(rs: readonly Relation[], name: string, schema?: string): string {
  const found = rs.filter(
    (r) =>
      foldAscii(r.table) === foldAscii(name) &&
      (schema === undefined || foldAscii(r.schema) === foldAscii(schema)),
  )
  if (found.length === 1) return found[0]!.alias
  if (found.length === 0)
    throw new QueryError({
      message: `table reference "${schema ? `${schema}.` : ''}${name}" is not in query`,
    })
  throw new QueryError({
    message: `table reference "${name}" is ambiguous; specify its schema`,
  })
}
function col(c: QualifiedColumnAst, rs: readonly Relation[]): string {
  return c.table ? `${q(aliasOf(rs, c.table, c.schema))}.${q(c.column)}` : q(c.column)
}
function predicate(p: PredicateAst, params: unknown[], rs: readonly Relation[]): string {
  switch (p.kind) {
    case 'cmp': {
      const hasRight = p.right !== undefined
      const hasValue = p.value !== undefined
      if (hasRight === hasValue)
        throw new QueryError({
          message: 'comparison requires exactly one of right or value',
        })
      const left = col(
        {
          column: p.column,
          ...(p.table ? { table: p.table } : {}),
          ...(p.schema ? { schema: p.schema } : {}),
        },
        rs,
      )
      if (p.right) return `${left} ${op(p.op)} ${col(p.right, rs)}`
      if (p.value === null) {
        if (p.op === 'eq') return `${left} is null`
        if (p.op === 'neq') return `${left} is not null`
        throw new QueryError({ message: `comparison '${p.op}' does not accept null` })
      }
      params.push(p.value)
      return `${left} ${op(p.op)} ?`
    }
    case 'and':
      return p.preds.length === 0
        ? '1'
        : p.preds.length === 1
          ? predicate(p.preds[0]!, params, rs)
          : `(${p.preds.map((x) => predicate(x, params, rs)).join(' and ')})`
    case 'or':
      return p.preds.length === 0
        ? '0'
        : p.preds.length === 1
          ? predicate(p.preds[0]!, params, rs)
          : `(${p.preds.map((x) => predicate(x, params, rs)).join(' or ')})`
    case 'not':
      return `(not ${predicate(p.pred, params, rs)})`
  }
}
function expr(e: SqlExprAst, params: unknown[], rs: readonly Relation[]): string {
  switch (e.kind) {
    case 'column':
      return col(e, rs)
    case 'count_all':
      return 'count(*)'
    case 'count':
      return `count(${expr(e.arg, params, rs)})`
    case 'min':
    case 'max':
    case 'sum':
      return `${e.kind}(${expr(e.arg, params, rs)})`
    case 'lower':
    case 'upper':
    case 'length':
      return `${e.kind}(${expr(e.arg, params, rs)})`
    case 'now':
      return 'current_timestamp'
    case 'date_trunc':
      throw new QueryError({ message: 'SQLite does not support date_trunc' })
  }
}
function returning(r: ReturningAst | undefined): string {
  if (!r) return ''
  if (r.kind === 'all') return ' returning *'
  if (r.columns.length === 0)
    throw new QueryError({ message: 'returning columns must not be empty' })
  return ` returning ${r.columns.map(q).join(', ')}`
}
function selectItem(
  i: SelectItemAst,
  params: unknown[],
  rs: readonly Relation[],
): string {
  if (i.kind === 'all') return i.table ? `${q(aliasOf(rs, i.table, i.schema))}.*` : '*'
  if (i.kind === 'column') {
    const value = col(i, rs)
    return i.alias ? `${value} as ${q(i.alias)}` : value
  }
  return `${expr(i.expr, params, rs)} as ${q(i.alias)}`
}
function orderBy(
  values: readonly OrderByAst[] | undefined,
  rs: readonly Relation[],
): string {
  return !values?.length
    ? ''
    : ` order by ${values.map((x) => `${col(x, rs)} ${x.direction === 'desc' ? 'desc' : 'asc'}`).join(', ')}`
}
function compileSelect(n: SelectAst): CompiledQuery {
  if (!n.selection?.length)
    throw new QueryError({ message: 'select items must not be empty' })
  if ((n.joins ?? []).some((j) => j.type === 'right'))
    throw new QueryError({ message: 'SQLite baseline does not support right joins' })
  if (n.having && !n.groupBy?.length)
    throw new QueryError({ message: 'SQLite 3.37 requires GROUP BY when HAVING is used' })
  const rs = relationsFor([{ table: n.table, schema: n.schema }, ...(n.joins ?? [])])
  const params: unknown[] = []
  let sql = `select ${n.selection.map((x) => selectItem(x, params, rs)).join(', ')} from ${table(n.schema, n.table)} as ${q(rs[0]!.alias)}`
  for (let i = 0; i < (n.joins ?? []).length; i++) {
    const j = n.joins![i]!
    sql += ` ${j.type} join ${table(j.schema, j.table)} as ${q(rs[i + 1]!.alias)} on ${predicate(j.on, params, rs)}`
  }
  if (n.where) sql += ` where ${predicate(n.where, params, rs)}`
  if (n.groupBy?.length) sql += ` group by ${n.groupBy.map((x) => col(x, rs)).join(', ')}`
  if (n.having) sql += ` having ${predicate(n.having, params, rs)}`
  sql += orderBy(n.orderBy, rs)
  if (n.limit !== undefined) {
    if (!Number.isInteger(n.limit) || n.limit < 0)
      throw new QueryError({ message: 'limit must be a non-negative integer' })
    params.push(n.limit)
    sql += ' limit ?'
  }
  if (n.offset !== undefined) {
    if (!Number.isInteger(n.offset) || n.offset < 0)
      throw new QueryError({ message: 'offset must be a non-negative integer' })
    if (n.limit === undefined) {
      params.push(-1)
      sql += ' limit ?'
    }
    params.push(n.offset)
    sql += ' offset ?'
  }
  return { sql, params }
}
function compileInsert(n: InsertAst): CompiledQuery {
  if (!n.columns.length)
    throw new QueryError({ message: 'insert requires at least one column' })
  if (!n.values.length)
    throw new QueryError({ message: 'insert requires at least one values row' })
  for (const row of n.values)
    if (row.length !== n.columns.length)
      throw new QueryError({ message: 'insert values row length must match columns' })
  const params: unknown[] = []
  const rows = n.values.map(
    (row) =>
      `(${row
        .map((v) => {
          if (v === undefined)
            throw new QueryError({ message: 'insert values must not contain undefined' })
          params.push(v)
          return '?'
        })
        .join(', ')})`,
  )
  return {
    sql: `insert into ${table(n.schema, n.table)} (${n.columns.map(q).join(', ')}) values ${rows.join(', ')}${returning(n.returning)}`,
    params,
  }
}
function compileUpdate(n: UpdateAst): CompiledQuery {
  if (!n.set.length)
    throw new QueryError({ message: 'update requires at least one SET column' })
  if (!n.where && !n.allowAll)
    throw new QueryError({ message: 'update requires a where clause or allowAll' })
  const rs = relationsFor([n])
  const params: unknown[] = []
  let sql = `update ${table(n.schema, n.table)} as ${q(rs[0]!.alias)} set ${n.set
    .map((x) => {
      if (x.value === undefined)
        throw new QueryError({ message: 'update SET values must not contain undefined' })
      params.push(x.value)
      return `${q(x.column)} = ?`
    })
    .join(', ')}`
  if (n.where) sql += ` where ${predicate(n.where, params, rs)}`
  return { sql: sql + returning(n.returning), params }
}
function compileDelete(n: DeleteAst): CompiledQuery {
  if (!n.where && !n.allowAll)
    throw new QueryError({ message: 'delete requires a where clause or allowAll' })
  // SQLite 3.37 has no DELETE alias in this grammar. Use the table spelling
  // when an explicit single-table qualification appears in the predicate.
  const rs: Relation[] = [{ table: n.table, schema: n.schema ?? 'main', alias: n.table }]
  const params: unknown[] = []
  let sql = `delete from ${table(n.schema, n.table)}`
  if (n.where) sql += ` where ${predicate(n.where, params, rs)}`
  return { sql: sql + returning(n.returning), params }
}
function columnDef(c: CreateTableColumnAst, pk: boolean): string {
  const type = assertSafeSqliteDataType(c.dataType)
  if (c.generated !== undefined)
    throw new QueryError({
      message: 'SQLite generated columns are not supported on the 3.37 baseline',
    })
  if (c.uniqueConstraintName !== undefined)
    throw new QueryError({
      message: 'SQLite unique constraint names are not supported in column definitions',
    })
  if (c.defaultValue !== undefined && c.databaseDefault !== undefined)
    throw new QueryError({
      message: 'SQLite column cannot specify both defaultValue and databaseDefault',
    })
  let sql = `${q(c.name)} ${type}`
  if (c.autoIncrement) {
    if (!pk || !/^integer$/i.test(type))
      throw new QueryError({
        message: 'SQLite AUTOINCREMENT requires the sole INTEGER primary key',
      })
    sql += ' primary key autoincrement'
    if (c.defaultValue !== undefined || c.databaseDefault !== undefined)
      throw new QueryError({
        message: 'SQLite AUTOINCREMENT columns cannot specify a default',
      })
  } else if (pk && /^integer$/i.test(type)) sql += ' primary key'
  if (c.notNull) sql += ' not null'
  if (c.unique && !(pk && /^integer$/i.test(type))) sql += ' unique'
  if (c.databaseDefault) sql += ` default ${c.databaseDefault.sql}`
  else if (c.defaultValue !== undefined)
    sql += ` default ${formatSqliteLiteral(c.defaultValue)}`
  if (c.references) {
    sql += ` references ${referenceTable(c.references.schema, c.references.table)} (${q(c.references.column)})`
    if (c.references.onDelete) sql += ` on delete ${c.references.onDelete}`
    if (c.references.onUpdate) sql += ` on update ${c.references.onUpdate}`
  }
  return sql
}
function compileCreateTable(n: CreateTableAst): string {
  assertMain(n.schema, 'CREATE TABLE')
  if (!n.columns.length)
    throw new QueryError({ message: 'create table requires at least one column' })
  if (n.primaryKeyName !== undefined)
    throw new QueryError({
      message: 'SQLite primary key constraint names are not supported',
    })
  const names = new Set<string>()
  for (const column of n.columns) {
    if (!column.name)
      throw new QueryError({ message: 'create table column names must not be empty' })
    const key = foldAscii(column.name)
    if (names.has(key))
      throw new QueryError({
        message: `duplicate create table column ${JSON.stringify(column.name)}`,
      })
    names.add(key)
  }
  const primaryKeys = new Set<string>()
  for (const key of n.primaryKey) {
    if (!names.has(foldAscii(key)))
      throw new QueryError({
        message: `primary key column ${JSON.stringify(key)} is not defined`,
      })
    if (primaryKeys.has(foldAscii(key)))
      throw new QueryError({
        message: `duplicate primary key column ${JSON.stringify(key)}`,
      })
    primaryKeys.add(foldAscii(key))
  }
  const sole = n.primaryKey.length === 1
  const inline =
    sole &&
    n.columns.some(
      (c) =>
        foldAscii(c.name) === foldAscii(n.primaryKey[0]!) &&
        /^integer$/i.test(c.dataType),
    )
  const defs = n.columns.map((c) =>
    columnDef(c, inline && foldAscii(c.name) === foldAscii(n.primaryKey[0]!)),
  )
  if (!inline && n.primaryKey.length)
    defs.push(`primary key (${n.primaryKey.map(q).join(', ')})`)
  return `create table ${table(n.schema, n.table)} (${defs.join(', ')})`
}
export function compileSqlite(node: SqlAst): CompiledQuery {
  switch (node.kind) {
    case 'select':
      return compileSelect(node)
    case 'insert':
      return compileInsert(node)
    case 'update':
      return compileUpdate(node)
    case 'delete':
      return compileDelete(node)
    case 'create_table':
      return { sql: compileCreateTable(node), params: [] }
    case 'create_index': {
      if (!node.columns.length)
        throw new QueryError({ message: 'create index requires at least one column' })
      assertMain(node.schema, 'CREATE INDEX')
      if (!node.name)
        throw new QueryError({ message: 'create index name must not be empty' })
      if (!node.table)
        throw new QueryError({ message: 'create index table must not be empty' })
      return {
        sql: `create ${node.unique ? 'unique ' : ''}index ${q('main')}.${q(node.name)} on ${q(node.table)} (${node.columns.map(q).join(', ')})`,
        params: [],
      }
    }
    default:
      throw new QueryError({
        message: `SQLite does not support SQL AST node '${node.kind}' on the 3.37 baseline`,
      })
  }
}
