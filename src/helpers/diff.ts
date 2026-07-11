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
  /** Column name */
  name: string
  /** Local schema column definition */
  local: LocalColumnMetadata & { dataType: string; nullable: boolean }
  /** Database column definition, or `null` if the column is new */
  current: DbColumnMetadata | null
}

export interface TableDiff {
  /** Table name */
  tableName: string
  /** Columns present locally but not in the database */
  added: ColumnDiff[]
  /** Columns whose definition differs from the database */
  modified: ColumnDiff[]
  /** Column names present in the database but not locally */
  removed: string[]
}

/**
 * Diffs a local table schema against database column metadata.
 *
 * @param schema - Local table schema
 * @param dbColumns - Current database columns
 * @param adapter - Dialect adapter for type normalization
 * @returns Diff of added, modified, and removed columns, or `null` if unchanged
 *
 * @example
 * ```ts
 * const diff = diffTableSchema(UserSchema, dbColumns)
 * if (diff) console.log(diff.added, diff.modified, diff.removed)
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
 * Builds a map of local column definitions from a table schema.
 *
 * @param schema - Local table schema
 * @param _metadata - Table metadata (unused; kept for call-site consistency)
 * @param adapter - Dialect adapter for type inference
 * @returns Map of column name to resolved column metadata
 *
 * @example
 * ```ts
 * const columns = getLocalColumns(UserSchema, metadata, adapter)
 * for (const [name, meta] of columns) console.log(name, meta.dataType)
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
 * Returns whether a local column definition differs from the database.
 *
 * @param local - Local column metadata
 * @param current - Database column metadata
 * @param adapter - Dialect adapter for type normalization
 * @returns `true` if type, nullability, auto-increment, or default differs
 *
 * @example
 * ```ts
 * if (isColumnModified(localCol, dbCol, adapter)) {
 *   // column needs ALTER
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
