import type { AnySchema } from '@/types/schema'

import { extractStorageFacts } from '../valibot/storageFacts'

/**
 * Returns whether a column schema should map to SQL NULL-capable storage.
 *
 * - `nullable` / `nullish` → SQL nullable
 * - `optional` alone → not SQL nullable (omit-on-insert only; use a DB default or
 *   `nullable`/`nullish` when the column may store NULL)
 *
 * @example
 *   isSqlNullable(nullable(string())) // true
 *   isSqlNullable(optional(string())) // false
 *   isSqlNullable(string()) // false
 *
 * @param schema - Column schema to check.
 *
 * @returns `true` when the schema maps to a SQL-nullable column
 */
export function isSqlNullable(schema: AnySchema): boolean {
  return extractStorageFacts(schema).nullable
}
