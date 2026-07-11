import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import type {
  ColumnMetadata as LocalColumnMetadata,
  TableMetadata as LocalTableMetadata,
} from '@/schemas'
import {
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
} from '@/schemas'
import type { ColumnMetadata as DbColumnMetadata } from 'kysely'
import type { BaseIssue, BaseSchema } from 'valibot'
import { getColumnInfo } from './column'
import type { TableSchema } from './table'

export interface ColumnDiff {
  /** The name of the db column */
  name: string
  /** The local schema column definition */
  local: LocalColumnMetadata & { dataType: string; nullable: boolean }
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
  adapter: DialectAdapter = postgresAdapter,
): TableDiff | null {
  const metadata = getTableMetadata(schema)
  if (!metadata) return null

  const localColumns = getLocalColumns(schema, metadata, adapter)
  const dbColumnMap = new Map(dbColumns.map((c) => [c.name, c]))

  const added: ColumnDiff[] = []
  const modified: ColumnDiff[] = []
  const removed: string[] = []

  for (const [name, localCol] of localColumns) {
    const dbCol = dbColumnMap.get(name)
    if (!dbCol) added.push({ name, local: localCol, current: null })
    else if (isColumnModified(localCol, dbCol, adapter))
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
  adapter: DialectAdapter,
): Map<string, LocalColumnMetadata & { dataType: string; nullable: boolean }> {
  const columns = new Map<
    string,
    LocalColumnMetadata & { dataType: string; nullable: boolean }
  >()
  const entries = schema.entries as Record<
    string,
    BaseSchema<unknown, unknown, BaseIssue<unknown>>
  >
  for (const [column, columnSchema] of Object.entries(entries)) {
    const columnMetadata = getColumnMetadata(columnSchema)
    const referenceMetadata = getReferenceMetadata(columnSchema)
    const { dataType, nullable, defaultValue, unique, autoIncrement } =
      getColumnInfo(columnSchema, columnMetadata, referenceMetadata, adapter)
    columns.set(column, {
      type: columnMetadata?.type ?? dataType,
      nullable,
      default: defaultValue,
      unique,
      autoIncrement,
      dataType,
    } as LocalColumnMetadata & { dataType: string; nullable: boolean })
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
  local: LocalColumnMetadata & { dataType: string; nullable: boolean },
  current: DbColumnMetadata,
  adapter: DialectAdapter,
): boolean {
  const localNorm = adapter.normalizeDataType(local.dataType)
  const currentNorm = adapter.normalizeDataType(current.dataType)
  if (localNorm !== currentNorm) return true
  const localNullable = local.nullable ?? false
  if (localNullable !== current.isNullable) return true
  const localAutoIncrement = local.autoIncrement ?? false
  if (localAutoIncrement !== current.isAutoIncrementing) return true
  const localHasDefault = local.default !== undefined
  if (localHasDefault !== current.hasDefaultValue) return true
  return false
}
