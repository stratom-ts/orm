import type { Dialect } from '@/dialects'
import type { ColumnMetadata } from '@/schemas'
import { getColumnMetadata, getReferenceMetadata } from '@/schemas'
import type { RelationIdentityInput } from '@/schemas/actions/relation'
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
 * Formats an authored relation for diagnostics.
 *
 * @param relation - Authored relation intent.
 */
function formatRelationInput(relation: RelationIdentityInput): string {
  const segments =
    relation.namespace?.map(
      ({ role, spelling }) => `${role}:${JSON.stringify(spelling)}`,
    ) ?? []
  segments.push(`relation:${JSON.stringify(relation.relation)}`)
  return `[${segments.join(', ')}]`
}

/**
 * Resolves the one registered handle matched by the selected query member.
 *
 * @param dialect - Selected dialect query semantics.
 * @param registered - Registered table handles to search.
 * @param relation - Authored relation intent.
 */
function resolveReferencedHandle(
  dialect: Dialect,
  registered: readonly TableHandle[],
  relation: RelationIdentityInput,
): TableHandle {
  const matches = dialect.query.findRelationMatches(registered, relation)

  if (matches.length === 1) return matches[0]!

  if (matches.length === 0) {
    throw new SchemaError({
      message: `Reference target ${formatRelationInput(relation)} is not registered`,
    })
  }

  throw new SchemaError({
    message: `Reference target ${formatRelationInput(relation)} is ambiguous`,
  })
}

/**
 * Resolves one column name on a registered handle under selected query semantics.
 *
 * @param dialect - Selected dialect query semantics.
 * @param handle - Handle whose members are being addressed.
 * @param columnName - Authored column spelling to resolve.
 * @param relation - Optional authored relation for diagnostics.
 */
function resolveColumnName(
  dialect: Dialect,
  handle: TableHandle,
  columnName: string,
  relation?: RelationIdentityInput,
): string {
  const matches = dialect.query.findColumnMatches(handle, columnName)
  const table = relation ? formatRelationInput(relation) : handle.getTableMetadata().name

  if (matches.length === 1) return matches[0]!

  if (matches.length === 0) {
    throw new SchemaError({
      message: `Reference target ${table}.${columnName} is not defined`,
    })
  }

  throw new SchemaError({
    message: `Reference target ${table}.${columnName} is ambiguous`,
  })
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
function resolveColumnDataType(
  handle: TableHandle,
  columnName: string,
  dialect: Dialect,
  registered: readonly TableHandle[],
  resolving: readonly { handle: TableHandle; column: string }[],
): string | undefined {
  const entries = handle.getSchema().entries as Record<
    string,
    { kind?: string } | undefined
  >
  const columnSchema = entries[columnName]
  if (!columnSchema || columnSchema.kind !== 'schema') return undefined

  const schema = columnSchema as Parameters<Dialect['schema']['inferColumnType']>[0]
  const columnMetadata = getColumnMetadata(schema)
  const referenceMetadata = getReferenceMetadata(schema)

  if (referenceMetadata) {
    const target = resolveReferencedHandle(
      dialect,
      registered,
      referenceMetadata.target.relation,
    )
    const targetLabel = referenceMetadata.target.relation.relation
    const targetColumn = resolveColumnName(
      dialect,
      target,
      referenceMetadata.target.column,
      referenceMetadata.target.relation,
    )

    if (
      resolving.some(
        (candidate) => candidate.handle === target && candidate.column === targetColumn,
      )
    ) {
      throw new SchemaError({
        message: `Cannot resolve reference-only column type cycle at ${targetLabel}.${targetColumn}`,
      })
    }

    const result = resolveColumnDataType(target, targetColumn, dialect, registered, [
      ...resolving,
      { handle: target, column: targetColumn },
    ])

    if (result === undefined) {
      throw new SchemaError({
        message: `Reference target column ${targetLabel}.${targetColumn} is not defined`,
      })
    }

    return result
  }

  const selected = columnMetadata?.physicalType?.[dialect.id]
  if (selected !== undefined) return String(selected)
  return String(dialect.schema.inferColumnType(schema))
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
  dialect: Dialect,
  map?: ValueMapConfig,
  registered: readonly TableHandle[] = [],
): ValueMapper {
  const typeCache = new WeakMap<TableHandle, Record<string, string>>()

  /**
   * Gets physical SQL data types keyed by column name.
   *
   * @param handle - Table whose column types should be resolved.
   */
  const columnTypes = (handle: TableHandle): Record<string, string> => {
    const cached = typeCache.get(handle)
    if (cached) return cached
    const types: Record<string, string> = {}

    for (const name of Object.keys(handle.getSchema().entries)) {
      const dt = resolveColumnDataType(handle, name, dialect, registered, [])
      if (dt !== undefined) types[name] = dt
    }

    typeCache.set(handle, types)
    return types
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

    const dataType = columnTypes(handle)[column]
    if (dataType === undefined) return value

    if (map?.mapParamValue) return map.mapParamValue(dataType, value)

    if (dialect.query.mapParamValue) {
      return dialect.query.mapParamValue(dataType, value)
    }

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

    const dataType = columnTypes(handle)[column]
    if (dataType === undefined) return value

    if (map?.mapResultValue) return map.mapResultValue(dataType, value)

    if (dialect.query.mapResultValue) {
      return dialect.query.mapResultValue(dataType, value)
    }

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
