import type { AnySchema } from '@/types/schema'

/**
 * Returns whether a column schema should map to SQL NULL-capable storage.
 *
 * - `nullable` / `nullish` → SQL nullable
 * - `optional` alone → not SQL nullable (omit-on-insert only; use a DB default or
 *   `nullable`/`nullish` when the column may store NULL)
 */
export function isSqlNullable(schema: AnySchema): boolean {
  if (schema.type === 'nullish' || schema.type === 'nullable') {
    return true
  }
  if (schema.type === 'optional') {
    return false
  }

  if ('pipe' in schema && Array.isArray((schema as { pipe: unknown[] }).pipe)) {
    const pipeItems = (schema as { pipe: unknown[] }).pipe
    for (const item of pipeItems) {
      if (item && typeof item === 'object' && item !== null && 'type' in item) {
        const actionType = (item as { type: string }).type
        if (actionType === 'nullish' || actionType === 'nullable') {
          return true
        }
      }
    }
  }

  if ('wrapped' in schema && schema.wrapped && typeof schema.wrapped === 'object') {
    return isSqlNullable(schema.wrapped as AnySchema)
  }

  return false
}
