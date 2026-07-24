import { isTruthyFlag, toNumberOrNull } from '@/utils'

import type { CatalogSnapshot, CatalogTable, CompiledQuery } from '../types'

type IntrospectExecutor = {
  execute(query: CompiledQuery): Promise<unknown[]>
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

/**
 * Formats a column's data type from catalog metadata rows.
 *
 * @param row - Column row from information_schema queries.
 *
 * @returns Normalized PostgreSQL data type string
 */
function formatPostgresCatalogDataType(row: ColumnRow): string {
  const dataType = (row.data_type ?? row.udt_name ?? 'text').toLowerCase()
  const udt = (row.udt_name ?? '').toLowerCase()
  const maxLen = toNumberOrNull(row.character_maximum_length)
  const precision = toNumberOrNull(row.numeric_precision)
  const scale = toNumberOrNull(row.numeric_scale)

  if (dataType === 'character varying' || dataType === 'varchar' || udt === 'varchar') {
    return maxLen !== null ? `varchar(${maxLen})` : 'varchar'
  }
  if (dataType === 'character' || dataType === 'char' || udt === 'bpchar') {
    return maxLen !== null ? `char(${maxLen})` : 'char'
  }
  if (dataType === 'numeric' || dataType === 'decimal') {
    if (precision !== null && scale !== null) return `numeric(${precision},${scale})`
    if (precision !== null) return `numeric(${precision})`
    return 'numeric'
  }
  if (udt === 'int2') return 'smallint'
  if (udt === 'int4') return 'integer'
  if (udt === 'int8') return 'bigint'
  if (udt === 'bool') return 'boolean'
  if (udt === 'float4') return 'real'
  if (udt === 'float8') return 'double precision'
  if (udt === 'timestamptz') return 'timestamptz'
  if (udt === 'timestamp') return 'timestamp'
  if (udt === 'uuid') return 'uuid'
  if (udt === 'text') return 'text'
  if (udt === 'json') return 'json'
  if (udt === 'jsonb') return 'jsonb'

  if (dataType === 'timestamp without time zone') return 'timestamp'
  if (dataType === 'timestamp with time zone') return 'timestamptz'
  if (dataType === 'double precision') return 'double precision'

  return dataType
}

/**
 * Parses index column names from various catalog formats.
 *
 * Handles PostgreSQL array literals (`{a,b,c}`), JSON arrays (`["a","b"]`),
 * and native arrays.
 *
 * @param value - Raw column value from catalog query.
 *
 * @returns Array of column name strings
 */
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

/**
 * Introspects a PostgreSQL database to build a catalog snapshot.
 *
 * Queries `information_schema` and `pg_catalog` to discover tables, columns,
 * and indexes in the connected database.
 *
 * @param executor - Database executor capable of running compiled queries.
 *
 * @returns Catalog snapshot with all user tables, columns, and indexes
 *
 * @example```ts
 * const snapshot = await introspectPostgres(db)
 * for (const table of snapshot.tables) {
 *   console.log(`${table.schema}.${table.name}: ${table.columns.length} columns`)
 * }
 * ```
 */
export async function introspectPostgres(executor: unknown): Promise<CatalogSnapshot> {
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

  function getOrCreateTable(name: string, schema: string): CatalogTable {
    const key = `${schema}.${name}`
    let table = tables.get(key)
    if (!table) {
      table = { name, schema, columns: [], indexes: [] }
      tables.set(key, table)
    }
    return table
  }

  for (const row of tableRows) {
    if (typeof row.name !== 'string') continue
    const schema = typeof row.schema === 'string' ? row.schema : 'public'
    getOrCreateTable(row.name, schema)
  }

  for (const row of columnRows) {
    if (typeof row.table_name !== 'string' || typeof row.column_name !== 'string')
      continue
    const schema = typeof row.schema === 'string' ? row.schema : 'public'
    const table = getOrCreateTable(row.table_name, schema)

    table.columns.push({
      name: row.column_name,
      dataType: formatPostgresCatalogDataType(row),
      isNullable: (row.is_nullable ?? 'YES').toUpperCase() === 'YES',
      hasDefault: row.column_default != null,
      isIdentity: (row.is_identity ?? 'NO').toUpperCase() === 'YES',
    })
  }

  for (const row of indexRows) {
    if (typeof row.table_name !== 'string' || typeof row.index_name !== 'string') continue
    const schema = typeof row.schema === 'string' ? row.schema : 'public'
    const table = getOrCreateTable(row.table_name, schema)

    table.indexes!.push({
      name: row.index_name,
      columns: parseIndexColumns(row.columns),
      unique: isTruthyFlag(row.is_unique),
    })
  }

  return { tables: [...tables.values()] }
}
