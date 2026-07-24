import {
  getBaseSchema,
  getNumberConstraints,
  getStringConstraints,
} from '@/schemas'
import type { NumberConstraints, StringConstraints } from '@/types/constraints'
import { isNumber } from '@/utils'
import { SchemaError } from '@/utils/error'
import type {
  BaseIssue,
  BaseSchema,
  ErrorMessage,
  Literal,
  LiteralSchema,
} from 'valibot'
import type {
  CatalogColumn,
  CatalogIndex,
  CatalogSnapshot,
  CatalogTable,
  ComparisonOp,
  CompiledQuery,
  CreateTableAst,
  CreateTableColumnAst,
  DeleteAst,
  Dialect,
  InsertAst,
  JoinAst,
  OrderByAst,
  PredicateAst,
  QualifiedColumnAst,
  SqlDataType,
  ReturningAst,
  SelectAst,
  SelectItemAst,
  SqlAst,
  SqlExprAst,
  UpdateAst,
} from './types'

type IntrospectExecutor = {
  execute(query: CompiledQuery): Promise<unknown[]>
}

/**
 * Maps string length constraints to a PostgreSQL string type.
 *
 * A `maxLength` up to 255 becomes `varchar(n)`; anything larger (or unbounded)
 * becomes `text`. We deliberately do not infer `char(n)` for equal min/max
 * length — `char` is blank-padded with surprising comparison semantics, so an
 * exact-length column is better expressed as `varchar(n)`.
 *
 * @param constraints - min/max length from the schema pipe
 * @returns `varchar(n)` or `text`
 */
function inferPostgresStringType(constraints: StringConstraints): SqlDataType {
  if (constraints.maxLength === undefined) return 'text'
  if (constraints.maxLength <= 255) return `varchar(${constraints.maxLength})`
  return 'text'
}

const INT16_MIN = -32768
const INT16_MAX = 32767
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

/**
 * Maps number constraints to a PostgreSQL numeric type.
 *
 * A JavaScript `number` is a double, so a plain `number()` (no `integer()`)
 * maps to `double precision` — `real` would silently lose precision. Integer
 * types require an `integer()` constraint (otherwise a bounded float range
 * could be truncated). An integer defaults to `integer`, narrows to `smallint`
 * only when both bounds sit inside the int16 range, and widens to `bigint` only
 * when a declared bound falls outside the int32 range.
 *
 * @param constraints - min/max value and integer flags
 * @returns `smallint`, `integer`, `bigint`, or `double precision`
 */
function inferPostgresNumberType(constraints: NumberConstraints): SqlDataType {
  if (!constraints.isInteger) return 'double precision'

  const { minValue: min, maxValue: max } = constraints

  if (
    (isNumber(min) && min < INT32_MIN) ||
    (isNumber(max) && max > INT32_MAX)
  ) {
    return 'bigint'
  }
  if (isNumber(min) && min >= INT16_MIN && isNumber(max) && max <= INT16_MAX) {
    return 'smallint'
  }
  return 'integer'
}

/**
 * Maps a Valibot literal value to a PostgreSQL column type.
 *
 * @param literal - Literal value from the schema
 * @returns Inferred column type for the literal
 */
function inferPostgresLiteralType(literal: Literal) {
  if (typeof literal === 'string') return 'text'
  if (typeof literal === 'number')
    return Number.isInteger(literal) ? 'integer' : 'double precision'
  if (typeof literal === 'boolean') return 'boolean'
  return 'text'
}

/** Valibot base schema types that hold JSON-shaped data → `jsonb`. */
const JSON_SHAPED_SCHEMA_TYPES = new Set([
  'object',
  'loose_object',
  'strict_object',
  'object_with_rest',
  'record',
  'array',
  'tuple',
  'loose_tuple',
  'strict_tuple',
  'tuple_with_rest',
])

/**
 * Infers a PostgreSQL column type from a Valibot schema.
 *
 * @param schema - Column schema (may be wrapped or piped)
 * @returns PostgreSQL column data type
 *
 * @example
 * ```ts
 * inferPostgresColumnType(string()) // 'text'
 * inferPostgresColumnType(pipe(string(), maxLength(50))) // 'varchar(50)'
 * ```
 */
export function inferPostgresColumnType(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): SqlDataType {
  const baseSchema = getBaseSchema(schema)
  switch (baseSchema.type) {
    case 'string': {
      const constraints = getStringConstraints(schema)
      return inferPostgresStringType(constraints)
    }
    case 'number': {
      const constraints = getNumberConstraints(schema)
      return inferPostgresNumberType(constraints)
    }
    case 'literal': {
      const literalSchema = baseSchema as LiteralSchema<
        Literal,
        ErrorMessage<BaseIssue<unknown>>
      >
      return inferPostgresLiteralType(literalSchema.literal)
    }
    // A JS Date is a UTC instant; timestamptz preserves that, timestamp drops it.
    case 'date':
      return 'timestamptz'
    // Store the label as text; the allowed set is still enforced by Valibot.
    case 'enum':
    case 'picklist':
      return 'text'
    case 'bigint':
      return 'bigint'
    case 'boolean':
      return 'boolean'
    default:
      if (JSON_SHAPED_SCHEMA_TYPES.has(baseSchema.type)) return 'jsonb'
      // Fail loudly rather than silently defaulting to text: an unmapped type
      // (union, record of scalars, custom, unknown, …) needs an explicit type.
      throw new SchemaError({
        message: `cannot infer a SQL column type for a "${baseSchema.type}" schema; specify it explicitly with column({ type: ... })`,
      })
  }
}

/**
 * Normalizes PostgreSQL type names and aliases for comparison.
 *
 * @param dataType - Raw type string (e.g. `int4`, `character varying`)
 * @returns Canonical type (e.g. `integer`, `varchar`)
 */
function normalizePostgresDataType(dataType: string): string {
  const normalized = dataType.toLowerCase().trim()
  const typeMappings: Record<string, string> = {
    bool: 'boolean',
    boolean: 'boolean',
    int4: 'integer',
    integer: 'integer',
    int2: 'smallint',
    smallint: 'smallint',
    int8: 'bigint',
    bigint: 'bigint',
    float8: 'real',
    float4: 'real',
    real: 'real',
    doubleprecision: 'real',
    'double precision': 'real',
    timestamptz: 'timestamptz',
    timestamp: 'timestamp',
    timestampwithouttimezone: 'timestamp',
    timestampwithtimezone: 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    char: 'char',
    character: 'char',
    'character varying': 'varchar',
    varchar: 'varchar',
    text: 'text',
    uuid: 'uuid',
    json: 'json',
    jsonb: 'jsonb',
  }
  const withoutLength = normalized.replace(/\(\d+\)/, '').trim()
  const lengthMatch = normalized.match(/\((\d+)\)/)
  if (typeMappings[withoutLength]) {
    return lengthMatch
      ? `${typeMappings[withoutLength]}(${lengthMatch[1]})`
      : typeMappings[withoutLength]
  }
  return normalized
}

type ColumnRow = {
  schema?: string
  table_name?: string
  column_name?: string
  data_type?: string
  udt_name?: string
  character_maximum_length?: number | string | null
  numeric_precision?: number | string | null
  numeric_scale?: number | string | null
  is_nullable?: string
  column_default?: string | null
  is_identity?: string
}

type IndexRow = {
  schema?: string
  table_name?: string
  index_name?: string
  is_unique?: boolean | string | number
  columns?: unknown
}

function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function formatPostgresCatalogDataType(row: ColumnRow): string {
  const dataType = (row.data_type ?? row.udt_name ?? 'text').toLowerCase()
  const udt = (row.udt_name ?? '').toLowerCase()
  const maxLen = toNumberOrNull(row.character_maximum_length)
  const precision = toNumberOrNull(row.numeric_precision)
  const scale = toNumberOrNull(row.numeric_scale)

  if (
    dataType === 'character varying' ||
    dataType === 'varchar' ||
    udt === 'varchar'
  ) {
    return maxLen !== null ? `varchar(${maxLen})` : 'varchar'
  }
  if (dataType === 'character' || dataType === 'char' || udt === 'bpchar') {
    return maxLen !== null ? `char(${maxLen})` : 'char'
  }
  if (dataType === 'numeric' || dataType === 'decimal') {
    if (precision !== null && scale !== null)
      return `numeric(${precision},${scale})`
    if (precision !== null) return `numeric(${precision})`
    return 'numeric'
  }
  if (udt === 'int2') return 'smallint'
  if (udt === 'int4') return 'integer'
  if (udt === 'int8') return 'bigint'
  if (udt === 'bool') return 'boolean'
  if (udt === 'float4') return 'real'
  if (udt === 'float8') return 'real'
  if (udt === 'timestamptz') return 'timestamptz'
  if (udt === 'timestamp') return 'timestamp'
  if (udt === 'uuid') return 'uuid'
  if (udt === 'text') return 'text'
  if (udt === 'json') return 'json'
  if (udt === 'jsonb') return 'jsonb'

  if (dataType === 'timestamp without time zone') return 'timestamp'
  if (dataType === 'timestamp with time zone') return 'timestamptz'
  if (dataType === 'double precision') return 'real'

  return dataType
}

function parseIndexColumns(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      const inner = trimmed.slice(1, -1)
      if (!inner) return []
      return inner.split(',').map((part) => part.replaceAll('"', '').trim())
    }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (Array.isArray(parsed)) {
          return parsed.filter((v): v is string => typeof v === 'string')
        }
      } catch {
        // fall through
      }
    }
  }
  return []
}

function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    return lower === 'yes' || lower === 'true' || lower === 't' || lower === '1'
  }
  return false
}

/**
 * PostgreSQL dialect plugin for the db0 stack.
 */
export const postgresDialect: Dialect = {
  id: 'postgres',

  inferColumnType(schema) {
    return inferPostgresColumnType(schema)
  },

  normalizeDataType(dataType) {
    return normalizePostgresDataType(dataType)
  },

  async introspect(executor: unknown): Promise<CatalogSnapshot> {
    const exec = executor as IntrospectExecutor

    const tableRows = (await exec.execute({
      sql: `
        select table_schema as schema, table_name as name
        from information_schema.tables
        where table_type = 'BASE TABLE'
          and table_schema not in ('pg_catalog', 'information_schema')
      `,
      params: [],
    })) as Array<{ schema?: string; name?: string }>

    const columnRows = (await exec.execute({
      sql: `
        select
          c.table_schema as schema,
          c.table_name as table_name,
          c.column_name as column_name,
          c.data_type as data_type,
          c.udt_name as udt_name,
          c.character_maximum_length as character_maximum_length,
          c.numeric_precision as numeric_precision,
          c.numeric_scale as numeric_scale,
          c.is_nullable as is_nullable,
          c.column_default as column_default,
          c.is_identity as is_identity
        from information_schema.columns c
        join information_schema.tables t
          on c.table_schema = t.table_schema
         and c.table_name = t.table_name
        where t.table_type = 'BASE TABLE'
          and c.table_schema not in ('pg_catalog', 'information_schema')
        order by c.table_schema, c.table_name, c.ordinal_position
      `,
      params: [],
    })) as ColumnRow[]

    const indexRows = (await exec.execute({
      sql: `
        select
          n.nspname as schema,
          tbl.relname as table_name,
          idx.relname as index_name,
          i.indisunique as is_unique,
          (
            select coalesce(array_agg(a.attname order by x.ordinality), '{}')
            from unnest(i.indkey) with ordinality as x(attnum, ordinality)
            join pg_attribute a
              on a.attrelid = tbl.oid
             and a.attnum = x.attnum
          ) as columns
        from pg_index i
        join pg_class idx on idx.oid = i.indexrelid
        join pg_class tbl on tbl.oid = i.indrelid
        join pg_namespace n on n.oid = tbl.relnamespace
        where n.nspname not in ('pg_catalog', 'information_schema')
          and tbl.relkind = 'r'
          and not i.indisprimary
      `,
      params: [],
    })) as IndexRow[]

    const tables = new Map<string, CatalogTable>()

    for (const row of tableRows) {
      if (typeof row.name !== 'string') continue
      const schema = typeof row.schema === 'string' ? row.schema : 'public'
      const key = `${schema}.${row.name}`
      tables.set(key, {
        name: row.name,
        schema,
        columns: [],
        indexes: [],
      })
    }

    for (const row of columnRows) {
      if (
        typeof row.table_name !== 'string' ||
        typeof row.column_name !== 'string'
      ) {
        continue
      }
      const schema = typeof row.schema === 'string' ? row.schema : 'public'
      const key = `${schema}.${row.table_name}`
      let table = tables.get(key)
      if (!table) {
        table = {
          name: row.table_name,
          schema,
          columns: [],
          indexes: [],
        }
        tables.set(key, table)
      }

      const column: CatalogColumn = {
        name: row.column_name,
        dataType: formatPostgresCatalogDataType(row),
        isNullable: (row.is_nullable ?? 'YES').toUpperCase() === 'YES',
        hasDefault: row.column_default != null,
        isIdentity: (row.is_identity ?? 'NO').toUpperCase() === 'YES',
      }
      table.columns.push(column)
    }

    for (const row of indexRows) {
      if (
        typeof row.table_name !== 'string' ||
        typeof row.index_name !== 'string'
      ) {
        continue
      }
      const schema = typeof row.schema === 'string' ? row.schema : 'public'
      const key = `${schema}.${row.table_name}`
      let table = tables.get(key)
      if (!table) {
        table = {
          name: row.table_name,
          schema,
          columns: [],
          indexes: [],
        }
        tables.set(key, table)
      }
      const index: CatalogIndex = {
        name: row.index_name,
        columns: parseIndexColumns(row.columns),
        unique: isTruthyFlag(row.is_unique),
      }
      table.indexes = table.indexes ?? []
      table.indexes.push(index)
    }

    return {
      tables: [...tables.values()],
    }
  },

  compile(node: SqlAst): CompiledQuery {
    if (node.kind === 'select_all') {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return { sql: `select * from ${tableSql}`, params: [] }
    }
    if (node.kind === 'select') {
      return compileSelect(node)
    }
    if (node.kind === 'insert') {
      return compileInsert(node)
    }
    if (node.kind === 'update') {
      return compileUpdate(node)
    }
    if (node.kind === 'delete') {
      return compileDelete(node)
    }
    if (node.kind === 'create_schema') {
      return {
        sql: `create schema if not exists ${quoteIdent(node.schema)}`,
        params: [],
      }
    }
    if (node.kind === 'create_table') {
      return { sql: compileCreateTable(node), params: [] }
    }
    if (node.kind === 'create_index') {
      return { sql: compileCreateIndex(node), params: [] }
    }
    if (node.kind === 'add_column') {
      return { sql: compileAddColumn(node), params: [] }
    }
    if (node.kind === 'alter_column_type') {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      const safeType = assertSafePostgresDataType(node.dataType)
      return {
        sql: `alter table ${tableSql} alter column ${quoteIdent(node.column)} type ${safeType}`,
        params: [],
      }
    }
    if (node.kind === 'set_not_null') {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return {
        sql: `alter table ${tableSql} alter column ${quoteIdent(node.column)} set not null`,
        params: [],
      }
    }
    if (node.kind === 'drop_not_null') {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return {
        sql: `alter table ${tableSql} alter column ${quoteIdent(node.column)} drop not null`,
        params: [],
      }
    }
    if (node.kind === 'drop_column') {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return {
        sql: `alter table ${tableSql} drop column ${quoteIdent(node.column)}`,
        params: [],
      }
    }
    if (node.kind === 'drop_table') {
      const tableSql = qualifyPostgresTable(node.schema, node.table)
      return {
        sql: `drop table ${tableSql}`,
        params: [],
      }
    }
    if (node.kind === 'drop_index') {
      const schemaName = node.schema ?? 'public'
      return {
        sql: `drop index ${quoteIdent(schemaName)}.${quoteIdent(node.index)}`,
        params: [],
      }
    }
    throw new Error(
      `postgresDialect.compile: unsupported AST kind "${(node as { kind: string }).kind}"`,
    )
  },

  mapResultValue(dataType, value) {
    return mapPostgresResultValue(dataType, value)
  },

  mapParamValue(dataType, value) {
    return mapPostgresParamValue(dataType, value)
  },
}

function postgresBaseType(dataType: string): string {
  return normalizePostgresDataType(dataType)
    .toLowerCase()
    .replace(/\(.*\)$/, '')
    .trim()
}

/**
 * Default Postgres → JS mapping for common result types.
 */
export function mapPostgresResultValue(
  dataType: string,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return value
  const base = postgresBaseType(dataType)

  if (base === 'timestamp' || base === 'timestamptz') {
    if (value instanceof Date) return value
    if (typeof value === 'string' || typeof value === 'number') {
      const date = new Date(value)
      return Number.isNaN(date.getTime()) ? value : date
    }
    return value
  }

  if (base === 'json' || base === 'jsonb') {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value) as unknown
      } catch {
        return value
      }
    }
    return value
  }

  if (base === 'uuid') {
    return typeof value === 'string' ? value : String(value)
  }

  return value
}

/**
 * Default JS → Postgres param mapping for common types.
 */
export function mapPostgresParamValue(
  dataType: string,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return value
  const base = postgresBaseType(dataType)

  if (base === 'timestamp' || base === 'timestamptz') {
    if (value instanceof Date) return value.toISOString()
    return value
  }

  if (base === 'json' || base === 'jsonb') {
    if (typeof value === 'string') return value
    return JSON.stringify(value)
  }

  if (base === 'uuid') {
    return typeof value === 'string' ? value : String(value)
  }

  return value
}

function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`
}

function qualifyPostgresTable(
  schema: string | undefined,
  table: string,
): string {
  // Always qualify so default public and explicit public match.
  const schemaName = schema ?? 'public'
  return `${quoteIdent(schemaName)}.${quoteIdent(table)}`
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
    default: {
      const _exhaustive: never = op
      return _exhaustive
    }
  }
}

function compileReturning(returning: ReturningAst | undefined): string {
  if (!returning) return ''
  if (returning.kind === 'all') return ' returning *'
  if (returning.columns.length === 0) return ' returning *'
  return ` returning ${returning.columns.map((c) => quoteIdent(c)).join(', ')}`
}

function qualifyColumn(column: string, table?: string): string {
  const col = quoteIdent(column)
  return table ? `${quoteIdent(table)}.${col}` : col
}

function compileQualifiedColumn(col: QualifiedColumnAst): string {
  return qualifyColumn(col.column, col.table)
}

function compilePredicate(pred: PredicateAst, params: unknown[]): string {
  switch (pred.kind) {
    case 'cmp': {
      const left = qualifyColumn(pred.column, pred.table)
      const op = comparisonSql(pred.op)
      if (pred.right) {
        return `${left} ${op} ${compileQualifiedColumn(pred.right)}`
      }
      params.push(pred.value)
      return `${left} ${op} $${params.length}`
    }
    case 'and': {
      if (pred.preds.length === 0) return 'true'
      if (pred.preds.length === 1)
        return compilePredicate(pred.preds[0]!, params)
      return `(${pred.preds.map((p) => compilePredicate(p, params)).join(' and ')})`
    }
    case 'or': {
      if (pred.preds.length === 0) return 'false'
      if (pred.preds.length === 1)
        return compilePredicate(pred.preds[0]!, params)
      return `(${pred.preds.map((p) => compilePredicate(p, params)).join(' or ')})`
    }
    case 'not':
      return `(not ${compilePredicate(pred.pred, params)})`
    default: {
      const _exhaustive: never = pred
      return _exhaustive
    }
  }
}

function compileWhereClause(
  where: PredicateAst | undefined,
  params: unknown[],
): string {
  if (!where) return ''
  return ` where ${compilePredicate(where, params)}`
}

function compileExpr(expr: SqlExprAst, params: unknown[]): string {
  switch (expr.kind) {
    case 'column':
      return qualifyColumn(expr.column, expr.table)
    case 'count_all':
      return 'count(*)'
    case 'count':
      return `count(${compileExpr(expr.arg, params)})`
    case 'min':
      return `min(${compileExpr(expr.arg, params)})`
    case 'max':
      return `max(${compileExpr(expr.arg, params)})`
    case 'sum':
      return `sum(${compileExpr(expr.arg, params)})`
    case 'lower':
      return `lower(${compileExpr(expr.arg, params)})`
    case 'upper':
      return `upper(${compileExpr(expr.arg, params)})`
    case 'length':
      return `length(${compileExpr(expr.arg, params)})`
    case 'now':
      return 'now()'
    case 'date_trunc': {
      params.push(expr.unit)
      const unitParam = `$${params.length}`
      return `date_trunc(${unitParam}, ${compileExpr(expr.arg, params)})`
    }
    default: {
      const _exhaustive: never = expr
      return _exhaustive
    }
  }
}

function compileSelectItem(item: SelectItemAst, params: unknown[]): string {
  switch (item.kind) {
    case 'all':
      return item.table ? `${quoteIdent(item.table)}.*` : '*'
    case 'column': {
      const col = qualifyColumn(item.column, item.table)
      return item.alias ? `${col} as ${quoteIdent(item.alias)}` : col
    }
    case 'expr':
      return `${compileExpr(item.expr, params)} as ${quoteIdent(item.alias)}`
    default: {
      const _exhaustive: never = item
      return _exhaustive
    }
  }
}

function compileOrderBy(orderBy: readonly OrderByAst[] | undefined): string {
  if (!orderBy || orderBy.length === 0) return ''
  const parts = orderBy.map(
    (o) =>
      `${qualifyColumn(o.column, o.table)} ${o.direction === 'desc' ? 'desc' : 'asc'}`,
  )
  return ` order by ${parts.join(', ')}`
}

function compileJoin(join: JoinAst, params: unknown[]): string {
  const tableSql = qualifyPostgresTable(join.schema, join.table)
  const type =
    join.type === 'inner'
      ? 'inner join'
      : join.type === 'left'
        ? 'left join'
        : 'right join'
  return ` ${type} ${tableSql} on ${compilePredicate(join.on, params)}`
}

function compileSelect(node: SelectAst): CompiledQuery {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const params: unknown[] = []
  const selection =
    !node.selection || node.selection.length === 0
      ? '*'
      : node.selection.map((item) => compileSelectItem(item, params)).join(', ')
  let sql = `select ${selection} from ${tableSql}`
  if (node.joins) {
    for (const join of node.joins) {
      sql += compileJoin(join, params)
    }
  }
  sql += compileWhereClause(node.where, params)
  if (node.groupBy && node.groupBy.length > 0) {
    sql += ` group by ${node.groupBy.map((c) => compileQualifiedColumn(c)).join(', ')}`
  }
  if (node.having) {
    sql += ` having ${compilePredicate(node.having, params)}`
  }
  sql += compileOrderBy(node.orderBy)
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

function compileInsert(node: InsertAst): CompiledQuery {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const cols = node.columns.map((c) => quoteIdent(c)).join(', ')
  const params: unknown[] = []
  const rowSql = node.values.map((row) => {
    const placeholders = row.map((value) => {
      // undefined → SQL DEFAULT (omit-on-insert / byDefault columns)
      if (value === undefined) return 'default'
      params.push(value)
      return `$${params.length}`
    })
    return `(${placeholders.join(', ')})`
  })
  const sql = `insert into ${tableSql} (${cols}) values ${rowSql.join(', ')}${compileReturning(node.returning)}`
  return { sql, params }
}

function compileUpdate(node: UpdateAst): CompiledQuery {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
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
  const whereSql = compileWhereClause(node.where, params)
  const sql = `update ${tableSql} set ${setSql}${whereSql}${compileReturning(node.returning)}`
  return { sql, params }
}

function compileDelete(node: DeleteAst): CompiledQuery {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const params: unknown[] = []
  const whereSql = compileWhereClause(node.where, params)
  const sql = `delete from ${tableSql}${whereSql}${compileReturning(node.returning)}`
  return { sql, params }
}

/** Base types allowed in DDL (with optional precision/length suffixes). */
const ALLOWED_PG_BASE_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'int2',
  'int4',
  'int8',
  'serial',
  'bigserial',
  'smallserial',
  'real',
  'double precision',
  'float4',
  'float8',
  'numeric',
  'decimal',
  'money',
  'boolean',
  'bool',
  'text',
  'varchar',
  'character varying',
  'char',
  'character',
  'bpchar',
  'uuid',
  'json',
  'jsonb',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
  'time with time zone',
  'bytea',
  'inet',
  'cidr',
  'macaddr',
  'macaddr8',
  'interval',
  'xml',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
])

/**
 * SQL default expressions that may appear unquoted (not string literals).
 * Case-insensitive match after trim/collapse whitespace.
 */
const ALLOWED_DEFAULT_EXPRESSIONS = new Set([
  'null',
  'true',
  'false',
  'now()',
  'current_timestamp',
  'current_date',
  'current_time',
  'localtimestamp',
  'localtime',
  'gen_random_uuid()',
  'uuid_generate_v4()',
])

/**
 * Validates and returns a safe SQL type fragment for DDL.
 * @throws Error when the type is not on the Postgres allowlist
 */
export function assertSafePostgresDataType(dataType: string): string {
  const trimmed = dataType.trim()
  if (!trimmed) {
    throw new Error('column data type must be a non-empty string')
  }
  // Reject obvious injection / multi-statement fragments
  if (/[;"\\]|--|\/\*|\*\//.test(trimmed)) {
    throw new Error(`unsafe column data type: ${JSON.stringify(dataType)}`)
  }

  const lower = trimmed.toLowerCase()
  // type(args) or type only — args must be digits/commas/spaces
  const match = lower.match(
    /^([a-z][a-z0-9 ]*?)(?:\s*\(\s*([0-9]+(?:\s*,\s*[0-9]+)?)\s*\))?$/,
  )
  if (!match) {
    throw new Error(`unsupported column data type: ${JSON.stringify(dataType)}`)
  }
  const base = match[1]!.replace(/\s+/g, ' ').trim()
  if (!ALLOWED_PG_BASE_TYPES.has(base)) {
    throw new Error(`unsupported column data type: ${JSON.stringify(dataType)}`)
  }
  // Preserve original casing for length args; normalize spacing lightly
  if (match[2]) {
    return `${base}(${match[2].replace(/\s+/g, '')})`
  }
  return base
}

/**
 * Formats a column default for DDL.
 * - number / boolean / null → SQL literals
 * - allowlisted expressions (`now()`, `gen_random_uuid()`, …) → raw SQL
 * - other strings → single-quoted literals (escaped)
 */
export function formatPostgresDefault(
  value: string | number | boolean | null,
): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('column default number must be finite')
    }
    return String(value)
  }

  const trimmed = value.trim()
  const collapsed = trimmed.toLowerCase().replace(/\s+/g, ' ')
  if (ALLOWED_DEFAULT_EXPRESSIONS.has(collapsed)) {
    // Prefer canonical lowercase keywords / function form
    if (collapsed.endsWith('()')) return collapsed
    return collapsed
  }

  // Numeric strings as numbers (optional convenience)
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed
  }

  return `'${value.replaceAll("'", "''")}'`
}

function formatReferentialAction(action: string): string {
  return action.toUpperCase()
}

function compileColumnDefinition(col: CreateTableColumnAst): string {
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
  if (col.unique) parts.push('unique')

  if (col.defaultValue !== undefined && !col.generated && !col.autoIncrement) {
    parts.push(`default ${formatPostgresDefault(col.defaultValue)}`)
  }

  if (col.references) {
    const refTable = qualifyPostgresTable(
      col.references.schema,
      col.references.table,
    )
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

function compileCreateTable(node: CreateTableAst): string {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  const primaryKey = [...node.primaryKey]
  const singlePk = primaryKey.length === 1 ? primaryKey[0] : undefined

  const columnSql = node.columns.map((col) => {
    const def = compileColumnDefinition(col)
    if (singlePk && col.name === singlePk) {
      // insert primary key before unique/default/references for readability
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
      parts.push('primary key')
      if (col.unique) parts.push('unique')

      if (
        col.defaultValue !== undefined &&
        !col.generated &&
        !col.autoIncrement
      ) {
        parts.push(`default ${formatPostgresDefault(col.defaultValue)}`)
      }

      if (col.references) {
        const refTable = qualifyPostgresTable(
          col.references.schema,
          col.references.table,
        )
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
    return def
  })

  if (primaryKey.length > 1) {
    columnSql.push(
      `primary key (${primaryKey.map((c) => quoteIdent(c)).join(', ')})`,
    )
  }

  return `create table ${tableSql} (${columnSql.join(', ')})`
}

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
  return `create ${unique}index if not exists ${quoteIdent(node.name)} on ${tableSql} (${cols})`
}

function compileAddColumn(node: {
  schema?: string
  table: string
  column: CreateTableColumnAst
}): string {
  const tableSql = qualifyPostgresTable(node.schema, node.table)
  return `alter table ${tableSql} add column ${compileColumnDefinition(node.column)}`
}
