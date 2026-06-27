import type { ColumnMetadata as DbColumnMetadata } from 'kysely'
import type { BaseIssue, BaseSchema } from 'valibot'
import { getColumnInfo } from './column'
import type { TableSchema } from './table'
import {
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
} from '@/schemas'
import type {
  ColumnMetadata as LocalColumnMetadata,
  TableMetadata as LocalTableMetadata,
} from '@/schemas'

export interface ColumnDiff {
  /** The name of the db column */
  name: string
  /** The local schema column definition */
  local: LocalColumnMetadata & { dataType: string }
  /** The db schema column definition */
  current: DbColumnMetadata | null
}

export interface TableDiff {
  /** The name of the db table */
  tableName: string
  /** Columns added to the local schema */
  added: ColumnDiff[]
  /** Columns modified in the local schema */
  modified: ColumnDiff[]
  /** Columns removed from the local schema */
  removed: string[]
}

/**
 * Compares a local table schema definition against the current database schema
 * to identify added, modified, or removed columns.
 *
 * @param schema - The local table schema definition from the schema files
 * @param dbColumns - The current column metadata from the database
 * @returns A TableDiff object if there are differences, or null if schemas match
 * @example
 * ```typescript
 * const diff = diffTableSchema(userTableSchema, dbColumns)
 * if (diff) {
 *   console.log(`Added: ${diff.added.length}, Modified: ${diff.modified.length}, Removed: ${diff.removed.length}`)
 * }
 * ```
 */
export function diffTableSchema(
  schema: TableSchema,
  dbColumns: DbColumnMetadata[],
): TableDiff | null {
  const metadata = getTableMetadata(schema)
  if (!metadata) return null

  const localColumns = getLocalColumns(schema, metadata)
  const dbColumnMap = new Map(dbColumns.map((c) => [c.name, c]))

  const added: ColumnDiff[] = []
  const modified: ColumnDiff[] = []
  const removed: string[] = []

  for (const [name, localCol] of localColumns) {
    const dbCol = dbColumnMap.get(name)
    if (!dbCol) added.push({ name, local: localCol, current: null })
    else if (isColumnModified(localCol, dbCol))
      modified.push({ name, local: localCol, current: dbCol })
  }
  for (const [name] of dbColumnMap) {
    if (!localColumns.has(name)) removed.push(name)
  }

  if (added.length === 0 && modified.length === 0 && removed.length === 0)
    return null
  return { tableName: metadata.name, added, modified, removed }
}

/**
 * Extracts column metadata from a local table schema and maps it to a searchable format.
 *
 * @param schema - The local table schema definition
 * @param _metadata - The table metadata (unused but kept for signature consistency)
 * @returns A Map of column names to their metadata including data type, nullable, default, unique, and autoIncrement
 * @example
 * ```typescript
 * const columns = getLocalColumns(userTableSchema, metadata)
 * for (const [name, meta] of columns) {
 *   console.log(`${name}: ${meta.dataType}`)
 * }
 * ```
 */
function getLocalColumns(
  schema: TableSchema,
  _metadata: LocalTableMetadata,
): Map<string, LocalColumnMetadata & { dataType: string }> {
  const columns = new Map<string, LocalColumnMetadata & { dataType: string }>()
  const entries = schema.entries as Record<
    string,
    BaseSchema<unknown, unknown, BaseIssue<unknown>>
  >
  for (const [column, columnSchema] of Object.entries(entries)) {
    const columnMetadata = getColumnMetadata(columnSchema)
    const referenceMetadata = getReferenceMetadata(columnSchema)
    const { dataType, nullable, defaultValue, unique, autoIncrement } =
      getColumnInfo(columnSchema, columnMetadata, referenceMetadata)
    columns.set(column, {
      type: columnMetadata?.type ?? dataType,
      nullable,
      default: defaultValue,
      unique,
      autoIncrement,
      dataType,
    } as LocalColumnMetadata & { dataType: string })
  }
  return columns
}

/**
 * Compares a local schema column with the db column schema
 * to determine if it has been modified.
 *
 * @param local - The local column metadata including data type
 * @param current - The current database column metadata
 * @returns true if the column has been modified, false otherwise
 * @example
 * ```typescript
 * const modified = isColumnModified(localColumn, dbColumn)
 * if (modified) {
 *   console.log('Column definition has changed')
 * }
 * ```
 */
function isColumnModified(
  local: LocalColumnMetadata & { dataType: string },
  current: DbColumnMetadata,
): boolean {
  if (compareDataTypes(local.dataType, current.dataType)) return true
  const localNullable = local.nullable ?? false
  if (localNullable !== current.isNullable) return true
  const localAutoIncrement = local.autoIncrement ?? false
  if (localAutoIncrement !== current.isAutoIncrementing) return true
  const localHasDefault = local.default !== undefined
  if (localHasDefault !== current.hasDefaultValue) return true
  return false
}

/**
 * Normalizes a database data type string to a consistent format for comparison.
 * Handles PostgreSQL type aliases and removes length specifications for comparison.
 *
 * @param dataType - The raw data type string from the database
 * @returns The normalized data type string
 * @example
 * ```typescript
 * normalizeDataType('VARCHAR(255)') // returns 'varchar(255)'
 * normalizeDataType('INT4') // returns 'integer'
 * normalizeDataType('TIMESTAMPTZ') // returns 'timestamptz'
 * ```
 */
function normalizeDataType(dataType: string): string {
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
    timestamptz: 'timestamptz',
    timestamp: 'timestamp',
    timestampwithouttimezone: 'timestamp',
    timestampwithtimezone: 'timestamptz',
    char: 'char',
    character: 'char',
    'character varying': 'varchar',
    varchar: 'varchar',
    text: 'text',
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

/**
 * Compares two data type strings to determine if they represent different types.
 * Normalizes both types before comparison and ignores length specifications.
 *
 * @param local - The local column data type string
 * @param current - The current database column data type string
 * @returns true if the data types are different, false if they match
 * @example
 * ```typescript
 * compareDataTypes('integer', 'int4') // returns false (same type)
 * compareDataTypes('varchar(100)', 'text') // returns true (different base types)
 * compareDataTypes('boolean', 'bool') // returns false (same type)
 * ```
 */
function compareDataTypes(local: string, current: string): boolean {
  const normalizedLocal = normalizeDataType(local)
  const normalizedCurrent = normalizeDataType(current)
  if (normalizedLocal === normalizedCurrent) return false
  const localBase = normalizedLocal.replace(/\(\d+\)/, '')
  const currentBase = normalizedCurrent.replace(/\(\d+\)/, '')
  return localBase !== currentBase
}
