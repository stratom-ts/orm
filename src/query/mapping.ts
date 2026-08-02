import type { Dialect } from '@/dialects'
import type { ColumnMetadata } from '@/schemas'
import { getColumnMetadata, getReferenceMetadata } from '@/schemas'
import type { TableHandle } from '@/types'

/** CreateDatabase-level value mapping overrides. */
export type ValueMapConfig = {
  mapResultValue?(dataType: string, value: unknown): unknown
  mapParamValue?(dataType: string, value: unknown): unknown
}

export type ValueMapper = {
  /** SQL data type per column name for a table. */
  columnTypes(handle: TableHandle): Record<string, string>
  mapParam(handle: TableHandle, column: string, value: unknown): unknown
  mapResultValue(handle: TableHandle, column: string, value: unknown): unknown
  mapResultRow(handle: TableHandle, row: Record<string, unknown>): Record<string, unknown>
  mapResultRows(handle: TableHandle, rows: unknown[]): unknown[]
}

function resolveColumnDataType(
  handle: TableHandle,
  columnName: string,
  dialect: Dialect,
  registered: readonly TableHandle[],
  resolving: Set<string>,
): string | undefined {
  const entries = handle.getSchema().entries as Record<
    string,
    { kind?: string } | undefined
  >
  const columnSchema = entries[columnName]
  if (!columnSchema || columnSchema.kind !== 'schema') return undefined

  const schema = columnSchema as Parameters<Dialect['inferColumnType']>[0]
  const columnMetadata = getColumnMetadata(schema)
  const referenceMetadata = getReferenceMetadata(schema)
  if (referenceMetadata) {
    const targetSchema = referenceMetadata.target.relation.namespace?.find(
      (segment) => segment.role === 'schema',
    )?.spelling
    const target = registered.find((candidate) => {
      const metadata = candidate.getTableMetadata()
      return (
        metadata.name === referenceMetadata.target.relation.relation &&
        (targetSchema === undefined
          ? metadata.schema === undefined
          : metadata.schema === targetSchema)
      )
    })
    if (!target) return undefined
    const token = `${targetSchema ?? ''}\0${referenceMetadata.target.relation.relation}\0${referenceMetadata.target.column}`
    if (resolving.has(token)) return undefined
    resolving.add(token)
    const result = resolveColumnDataType(
      target,
      referenceMetadata.target.column,
      dialect,
      registered,
      resolving,
    )
    resolving.delete(token)
    return result
  }
  const selected = columnMetadata?.physicalType?.[dialect.id]
  if (selected !== undefined) return String(selected)
  if (dialect.id === 'postgresql' && columnMetadata?.type !== undefined) {
    return String(columnMetadata.type)
  }
  return String(dialect.inferColumnType(schema))
}

function columnMeta(handle: TableHandle, columnName: string): ColumnMetadata | undefined {
  const entries = handle.getSchema().entries as Record<
    string,
    { kind?: string } | undefined
  >
  const columnSchema = entries[columnName]
  if (!columnSchema || columnSchema.kind !== 'schema') return undefined
  return getColumnMetadata(columnSchema as Parameters<typeof getColumnMetadata>[0])
}

/**
 * Builds a value mapper: column override → createDatabase map → dialect defaults.
 *
 * @example
 *   const mapper = createValueMapper(dialect, { mapParamValue: ... })
 *   mapper.mapParam(handle, 'createdAt', new Date())
 *
 * @param dialect - SQL dialect providing default value mapping.
 * @param map - Optional global value mapping overrides.
 *
 * @returns Value mapper with `columnTypes`, `mapParam`, `mapResultRow`, and
 *   `mapResultRows`
 */
export function createValueMapper(
  dialect: Dialect,
  map?: ValueMapConfig,
  registered: readonly TableHandle[] = [],
): ValueMapper {
  const typeCache = new WeakMap<TableHandle, Record<string, string>>()

  const columnTypes = (handle: TableHandle): Record<string, string> => {
    const cached = typeCache.get(handle)
    if (cached) return cached
    const types: Record<string, string> = {}
    for (const name of Object.keys(handle.getSchema().entries)) {
      const dt = resolveColumnDataType(handle, name, dialect, registered, new Set())
      if (dt !== undefined) types[name] = dt
    }
    typeCache.set(handle, types)
    return types
  }

  const mapParam = (handle: TableHandle, column: string, value: unknown): unknown => {
    if (value === undefined) return value
    const meta = columnMeta(handle, column)
    if (meta?.mapParam) return meta.mapParam(value)

    const dataType = columnTypes(handle)[column]
    if (dataType === undefined) return value

    if (map?.mapParamValue) return map.mapParamValue(dataType, value)
    if (dialect.mapParamValue) return dialect.mapParamValue(dataType, value)
    return value
  }

  const mapResultValue = (
    handle: TableHandle,
    column: string,
    value: unknown,
  ): unknown => {
    const meta = columnMeta(handle, column)
    if (meta?.mapResult) return meta.mapResult(value)

    const dataType = columnTypes(handle)[column]
    if (dataType === undefined) return value

    if (map?.mapResultValue) return map.mapResultValue(dataType, value)
    if (dialect.mapResultValue) return dialect.mapResultValue(dataType, value)
    return value
  }

  const mapResultRow = (
    handle: TableHandle,
    row: Record<string, unknown>,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(row)) {
      out[key] = mapResultValue(handle, key, value)
    }
    return out
  }

  const mapResultRows = (handle: TableHandle, rows: unknown[]): unknown[] =>
    rows.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return row
      }
      return mapResultRow(handle, row as Record<string, unknown>)
    })

  return { columnTypes, mapParam, mapResultValue, mapResultRow, mapResultRows }
}
