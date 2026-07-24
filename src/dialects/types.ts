import type { ColumnDataType } from 'kysely'
import type { BaseIssue, BaseSchema } from 'valibot'

/**
 * Dialect-specific helpers for column type inference and comparison.
 */
export interface DialectAdapter {
  /**
   * Maps a Valibot schema to a SQL column type.
   *
   * @param schema - Column schema to infer from
   * @returns Dialect-specific column data type
   *
   * @example
   * ```ts
   * adapter.inferColumnType(string()) // 'text' (postgres)
   * ```
   */
  inferColumnType(
    schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  ): ColumnDataType

  /**
   * Normalizes a SQL type name for equality checks (aliases, casing).
   *
   * @param dataType - Raw type string from schema or database
   * @returns Canonical type string
   *
   * @example
   * ```ts
   * adapter.normalizeDataType('int4') // 'integer'
   * ```
   */
  normalizeDataType(dataType: string): string
}
