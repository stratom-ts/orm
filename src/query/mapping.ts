import type { DialectCore, DialectMappingContext } from '@/dialects'
import type { ColumnMetadata } from '@/schemas'
import { getColumnMetadata, getReferenceMetadata } from '@/schemas'
import type { TableHandle } from '@/types'
import { SchemaError } from '@/utils/error'

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

/**
 * Resolves a column's physical SQL data type, following references as needed.
 *
 * @param handle - Table containing the column.
 * @param columnName - Column name to resolve.
 * @param dialect - Dialect used to infer physical types.
 * @param registered - Registered tables available for reference resolution.
 * @param resolving - Reference targets currently being resolved.
 */
function resolveColumnContext(
  handle: TableHandle,
  columnName: string,
  dialect: DialectCore,
  registered: readonly TableHandle[],
  resolving: Set<string>,
): DialectMappingContext | undefined {
  const entries = handle.getSchema().entries as Record<
    string,
    { kind?: string } | undefined
  >
  const columnSchema = entries[columnName]
  if (!columnSchema || columnSchema.kind !== 'schema') return undefined

  const schema = columnSchema as Parameters<DialectCore['inferColumnType']>[0]
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
    if (!target) {
      throw new SchemaError({
        message: `Reference target ${targetSchema === undefined ? '' : `${targetSchema}.`}${referenceMetadata.target.relation.relation}.${referenceMetadata.target.column} is not registered`,
      })
    }
    const token = `${targetSchema ?? ''}\0${referenceMetadata.target.relation.relation}\0${referenceMetadata.target.column}`
    if (resolving.has(token)) {
      throw new SchemaError({
        message: `Cannot resolve reference-only column type cycle at ${targetSchema === undefined ? '' : `${targetSchema}.`}${referenceMetadata.target.relation.relation}.${referenceMetadata.target.column}`,
      })
    }
    resolving.add(token)
    const result = resolveColumnContext(
      target,
      referenceMetadata.target.column,
      dialect,
      registered,
      resolving,
    )
    resolving.delete(token)
    if (result === undefined) {
      throw new SchemaError({
        message: `Reference target column ${targetSchema === undefined ? '' : `${targetSchema}.`}${referenceMetadata.target.relation.relation}.${referenceMetadata.target.column} is not defined`,
      })
    }
    return result
  }
  const selected = columnMetadata?.physicalType?.[dialect.id]
  const dataType =
    selected !== undefined ? String(selected) : String(dialect.inferColumnType(schema))
  return {
    dataType,
    schema,
    column: columnName,
    ...(columnMetadata === undefined ? {} : { metadata: columnMetadata }),
  }
}

/**
 * Gets metadata for a schema-backed column.
 *
 * @param handle - Table containing the column.
 * @param columnName - Column name to inspect.
 */
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
 *   const mapper = createValueMapper(dialect)
 *   mapper.mapParam(handle, 'createdAt', new Date())
 *
 * @param dialect - SQL dialect providing default value mapping.
 * @param map - Optional global value mapping overrides.
 * @param registered - Tables available for reference type resolution.
 *
 * @returns Value mapper with `columnTypes`, `mapParam`, `mapResultRow`, and
 *   `mapResultRows`
 */
export function createValueMapper(
  dialect: DialectCore,
  map?: ValueMapConfig,
  registered: readonly TableHandle[] = [],
): ValueMapper {
  const contextCache = new WeakMap<TableHandle, Record<string, DialectMappingContext>>()

  /**
   * Gets physical SQL data types keyed by column name.
   *
   * @param handle - Table whose column types should be resolved.
   */
  const columnTypes = (handle: TableHandle): Record<string, string> => {
    const cached = contextCache.get(handle)
    if (cached) {
      return Object.fromEntries(
        Object.entries(cached).map(([name, context]) => [name, context.dataType]),
      )
    }
    const contexts: Record<string, DialectMappingContext> = {}
    for (const name of Object.keys(handle.getSchema().entries)) {
      const context = resolveColumnContext(handle, name, dialect, registered, new Set())
      if (context !== undefined) contexts[name] = context
    }
    contextCache.set(handle, contexts)
    return Object.fromEntries(
      Object.entries(contexts).map(([name, context]) => [name, context.dataType]),
    )
  }

  const contextFor = (
    handle: TableHandle,
    column: string,
  ): DialectMappingContext | undefined => {
    // columnTypes populates the same context cache while preserving its public shape.
    columnTypes(handle)
    return contextCache.get(handle)?.[column]
  }

  /**
   * Maps a JavaScript parameter value for a table column.
   *
   * @param handle - Table containing the column.
   * @param column - Column receiving the parameter.
   * @param value - JavaScript value to map.
   */
  const mapParam = (handle: TableHandle, column: string, value: unknown): unknown => {
    if (value === undefined) return value
    const meta = columnMeta(handle, column)
    if (meta?.mapParam) return meta.mapParam(value)

    const context = contextFor(handle, column)
    if (context === undefined) return value

    if (map?.mapParamValue) return map.mapParamValue(context.dataType, value)
    if (dialect.mapParamValueContext) return dialect.mapParamValueContext(context, value)
    if (dialect.mapParamValue) return dialect.mapParamValue(context.dataType, value)
    return value
  }

  /**
   * Maps a SQL result value for a table column.
   *
   * @param handle - Table containing the column.
   * @param column - Column that produced the value.
   * @param value - SQL result value to map.
   */
  const mapResultValue = (
    handle: TableHandle,
    column: string,
    value: unknown,
  ): unknown => {
    const meta = columnMeta(handle, column)
    if (meta?.mapResult) return meta.mapResult(value)

    const context = contextFor(handle, column)
    if (context === undefined) return value

    if (map?.mapResultValue) return map.mapResultValue(context.dataType, value)
    if (dialect.mapResultValueContext)
      return dialect.mapResultValueContext(context, value)
    if (dialect.mapResultValue) return dialect.mapResultValue(context.dataType, value)
    return value
  }

  /**
   * Maps every recognized column value in a result row.
   *
   * @param handle - Table associated with the result row.
   * @param row - Result row to map.
   */
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

  /**
   * Maps object rows while preserving non-object result values.
   *
   * @param handle - Table associated with the result rows.
   * @param rows - Result values to map.
   */
  const mapResultRows = (handle: TableHandle, rows: unknown[]): unknown[] =>
    rows.map((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) {
        return row
      }
      return mapResultRow(handle, row as Record<string, unknown>)
    })

  for (const handle of registered) columnTypes(handle)

  return { columnTypes, mapParam, mapResultValue, mapResultRow, mapResultRows }
}
