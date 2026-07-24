import type { AnySchema } from '@/types/schema'

/**
 * Returns whether a schema allows null or undefined values.
 *
 * @param schema - Schema to inspect
 * @returns `true` if optional, nullable, or nullish
 *
 * @example
 * ```ts
 * isNullable(optional(string())) // true
 * isNullable(string()) // false
 * ```
 */
export function isNullable(schema: AnySchema): boolean {
  if (schema.type === 'optional' || schema.type === 'nullish') {
    return true
  }
  if (schema.type === 'nullable') {
    return true
  }

  if ('pipe' in schema && Array.isArray((schema as { pipe: unknown[] }).pipe)) {
    const pipeItems = (schema as { pipe: unknown[] }).pipe
    for (const item of pipeItems) {
      if (item && typeof item === 'object' && item !== null && 'type' in item) {
        const actionType = (item as { type: string }).type
        if (
          actionType === 'optional' ||
          actionType === 'nullish' ||
          actionType === 'nullable'
        ) {
          return true
        }
      }
    }
  }

  return false
}
