import type { CompiledQuery, Dialect, DialectQueryResolution, SqlAst } from '@/dialects'
import type { ColumnMetadata, ReferenceMetadata } from '@/schemas'
import { getColumnMetadata, getReferenceMetadata } from '@/schemas'
import type { RelationIdentityInput } from '@/schemas/actions/relation'
import type { TableHandle } from '@/types'
import { SchemaError } from '@/utils/error'

/** CreateDatabase-level value mapping overrides. */
export type ValueMapConfig = {
  /**
   * Maps a database result value into its declared JavaScript representation.
   *
   * @param dataType - Physical SQL type used for validation, comparison, or value
   *   mapping.
   * @param value - Runtime value to validate, normalize, or map.
   *
   * @returns The mapped result value, or the unchanged value when no mapper applies.
   */
  mapResultValue?(dataType: string, value: unknown): unknown
  /**
   * Maps a JavaScript value into the selected physical SQL type's parameter
   * representation.
   *
   * @param dataType - Physical SQL type used for validation, comparison, or value
   *   mapping.
   * @param value - Runtime value to validate, normalize, or map.
   *
   * @returns The SQL parameter representation produced by this mapping override.
   */
  mapParamValue?(dataType: string, value: unknown): unknown
}

export type ValueMapper = {
  /** SQL data type per column name for a table. */
  columnTypes(handle: TableHandle): Record<string, string>
  /**
   * Maps a column parameter using column, client, then dialect overrides.
   *
   * @param handle - Table handle whose schema and relation metadata are required.
   * @param column - Authored column spelling to resolve, map, or compile.
   * @param value - Runtime value to validate, normalize, or map.
   *
   * @returns The value mapped by the first applicable override, or the unchanged value.
   */
  mapParam(handle: TableHandle, column: string, value: unknown): unknown
  /**
   * Maps a database result value into its declared JavaScript representation.
   *
   * @param handle - Table handle whose schema and relation metadata are required.
   * @param column - Authored column spelling to resolve, map, or compile.
   * @param value - Runtime value to validate, normalize, or map.
   *
   * @returns The mapped result value, or the unchanged value when no mapper applies.
   */
  mapResultValue(handle: TableHandle, column: string, value: unknown): unknown
  /**
   * Maps recognized result-column values while preserving the row's other fields.
   *
   * @param handle - Table handle whose schema and relation metadata are required.
   * @param row - Current native catalog row, insert row, or result object.
   *
   * @returns Recognized result-column values while preserving the row's other fields.
   */
  mapResultRow(handle: TableHandle, row: Record<string, unknown>): Record<string, unknown>
  /**
   * Maps result objects while preserving result values that are not objects.
   *
   * @param handle - Table handle whose schema and relation metadata are required.
   * @param rows - Ordered native observations or result rows to process.
   *
   * @returns Result objects while preserving result values that are not objects.
   */
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
 * @param query - Resolved query compilation and relation-member lookup operations.
 * @param relation - Authored relation intent.
 *
 * @returns The uniquely matched referenced handle; absent or ambiguous matches throw.
 */
function resolveReferencedHandle(
  query: DialectQueryResolution,
  relation: RelationIdentityInput,
): TableHandle {
  const matches = query.findRelationMatches(relation)

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
 * @param query - Resolved query compilation and relation-member lookup operations.
 * @param handle - Handle whose members are being addressed.
 * @param columnName - Authored column spelling to resolve.
 * @param relation - Optional authored relation for diagnostics.
 *
 * @returns One column name on a registered handle under selected query semantics.
 */
function resolveColumnName(
  query: DialectQueryResolution,
  handle: TableHandle,
  columnName: string,
  relation?: RelationIdentityInput,
): string {
  const matches = query.findColumnMatches(handle, columnName)
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
  query: DialectQueryResolution,
  registered: readonly TableHandle[],
  resolving: readonly { handle: TableHandle; column: string }[],
): string | undefined {
  const entries = handle.getSchema().entries as Record<
    string,
    { kind?: string } | undefined
  >

  const columnSchema = entries[columnName]

  if (columnSchema?.kind !== 'schema') return undefined

  const schema = columnSchema as Parameters<Dialect['schema']['inferColumnType']>[0]
  const columnMetadata = getColumnMetadata(schema)
  const referenceMetadata = getReferenceMetadata(schema)

  if (referenceMetadata) {
    const result = resolveReferenceDataType(
      query,
      referenceMetadata,
      resolving,
      dialect,
      registered,
    )

    return result
  }

  const selected = columnMetadata?.physicalType?.[dialect.id]

  if (selected !== undefined) return String(selected)

  return String(dialect.schema.inferColumnType(schema))
}

/**
 * Follows registered foreign-key targets while rejecting unresolved columns and reference
 * cycles.
 *
 * @param query - Resolved query compilation and relation-member lookup operations.
 * @param referenceMetadata - Authored foreign-key metadata whose target type must be
 *   resolved.
 * @param resolving - Reference path used to detect cyclic physical-type lookup.
 * @param dialect - Selected dialect's schema, query, and lifecycle operations.
 * @param registered - Registered table handles indexed by canonical relation identity.
 *
 * @returns The referenced column's physical SQL type; unresolved or cyclic chains throw.
 */
function resolveReferenceDataType(
  query: Readonly<{
    compile(node: SqlAst): CompiledQuery
    findRelationMatches(
      relation: RelationIdentityInput,
      handles?: readonly TableHandle[],
    ): readonly TableHandle[]
    findColumnMatches(handle: TableHandle, column: string): readonly string[]
  }>,
  referenceMetadata: ReferenceMetadata,
  resolving: readonly { handle: TableHandle; column: string }[],
  dialect: Dialect,
  registered: readonly TableHandle[],
) {
  const target = resolveReferencedHandle(query, referenceMetadata.target.relation)
  const targetLabel = referenceMetadata.target.relation.relation
  const targetColumn = resolveColumnName(
    query,
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

  const result = resolveColumnDataType(target, targetColumn, dialect, query, registered, [
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

  if (columnSchema?.kind !== 'schema') return undefined

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
  query: DialectQueryResolution = dialect.query.resolve(registered),
): ValueMapper {
  const typeCache = new WeakMap<TableHandle, Record<string, string>>()
  /** Returns physical SQL types keyed by the table's authored column names. */
  const columnTypes = (handle: TableHandle) =>
    cachedColumnTypes(handle, typeCache, dialect, query, registered)

  /**
   * Maps a JavaScript parameter value for a table column.
   *
   * @param handle - Table containing the column.
   * @param column - Column receiving the parameter.
   * @param value - JavaScript value to map.
   */
  const mapParamForColumn = (handle: TableHandle, column: string, value: unknown) =>
    mapParam(handle, column, value, dialect, map, columnTypes)

  /**
   * Maps a SQL result value for a table column.
   *
   * @param handle - Table containing the column.
   * @param column - Column that produced the value.
   * @param value - SQL result value to map.
   */
  const mapResultValueForColumn = (handle: TableHandle, column: string, value: unknown) =>
    mapResultValue(handle, column, value, dialect, map, columnTypes)

  /** Maps recognized result-column values while preserving the row's other fields. */
  const mapResultRow = (handle: TableHandle, row: Record<string, unknown>) =>
    mapObjectRow(handle, row, mapResultValueForColumn)

  /** Maps result objects while preserving result values that are not objects. */
  const mapResultRows = (handle: TableHandle, rows: unknown[]) =>
    mapRows(handle, rows, mapResultRow)

  for (const handle of registered) columnTypes(handle)

  return {
    columnTypes,
    mapParam: mapParamForColumn,
    mapResultValue: mapResultValueForColumn,
    mapResultRow,
    mapResultRows,
  }
}

/**
 * Maps a column parameter using column, client, then dialect overrides.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param column - Authored column spelling to resolve, map, or compile.
 * @param value - Runtime value to validate, normalize, or map.
 * @param dialect - Selected dialect's schema, query, and lifecycle operations.
 * @param map - Client value-mapping overrides applied before dialect defaults.
 * @param columnTypes - Callback that supplies physical types keyed by authored column
 *   name.
 *
 * @returns The value mapped by the first applicable override, or the unchanged value.
 */
function mapParam(
  handle: TableHandle,
  column: string,
  value: unknown,
  dialect: Dialect,
  map: ValueMapConfig | undefined,
  columnTypes: ValueMapper['columnTypes'],
): unknown {
  if (value === undefined) return value

  const meta = columnMeta(handle, column)

  if (meta?.mapParam) return meta.mapParam(value)

  const types = columnTypes(handle)

  if (!Object.hasOwn(types, column)) return value

  const dataType = types[column]

  if (map?.mapParamValue) return map.mapParamValue(dataType, value)

  if (dialect.query.mapParamValue) {
    return dialect.query.mapParamValue(dataType, value)
  }

  return value
}

/**
 * Maps a database result value into its declared JavaScript representation.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param column - Authored column spelling to resolve, map, or compile.
 * @param value - Runtime value to validate, normalize, or map.
 * @param dialect - Selected dialect's schema, query, and lifecycle operations.
 * @param map - Client value-mapping overrides applied before dialect defaults.
 * @param columnTypes - Callback that supplies physical types keyed by authored column
 *   name.
 *
 * @returns The mapped result value, or the unchanged value when no mapper applies.
 */
function mapResultValue(
  handle: TableHandle,
  column: string,
  value: unknown,
  dialect: Dialect,
  map: ValueMapConfig | undefined,
  columnTypes: ValueMapper['columnTypes'],
): unknown {
  const meta = columnMeta(handle, column)

  if (meta?.mapResult) return meta.mapResult(value)

  const types = columnTypes(handle)

  if (!Object.hasOwn(types, column)) return value

  const dataType = types[column]

  if (map?.mapResultValue) return map.mapResultValue(dataType, value)

  if (dialect.query.mapResultValue) {
    return dialect.query.mapResultValue(dataType, value)
  }

  return value
}

/**
 * Gets physical SQL data types keyed by column name.
 *
 * @param handle - Table whose column types should be resolved.
 */
function cachedColumnTypes(
  handle: TableHandle,
  typeCache: WeakMap<TableHandle, Record<string, string>>,
  dialect: Dialect,
  query: DialectQueryResolution,
  registered: readonly TableHandle[],
): Record<string, string> {
  const cached = typeCache.get(handle)

  if (cached) return cached

  const types: Record<string, string> = {}

  for (const name of Object.keys(handle.getSchema().entries)) {
    const dt = resolveColumnDataType(handle, name, dialect, query, registered, [])

    if (dt !== undefined) types[name] = dt
  }

  typeCache.set(handle, types)
  return types
}

/**
 * Maps every recognized column value in a result row.
 *
 * @param handle - Table associated with the result row.
 * @param row - Result row to map.
 */
function mapObjectRow(
  handle: TableHandle,
  row: Record<string, unknown>,
  mapResultValueForColumn: (
    handle: TableHandle,
    column: string,
    value: unknown,
  ) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(row)) {
    out[key] = mapResultValueForColumn(handle, key, value)
  }

  return out
}

/**
 * Maps object rows while preserving non-object result values.
 *
 * @param handle - Table associated with the result rows.
 * @param rows - Result values to map.
 */
function mapRows(
  handle: TableHandle,
  rows: unknown[],
  mapResultRow: (
    handle: TableHandle,
    row: Record<string, unknown>,
  ) => Record<string, unknown>,
): unknown[] {
  return rows.map((row) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return row
    }

    return mapResultRow(handle, row as Record<string, unknown>)
  })
}
