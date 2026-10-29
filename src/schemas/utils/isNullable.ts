import type { AnySchema } from '@/types/schema'

import { extractStorageFacts } from '../valibot/storageFacts'

/**
 * Returns whether a schema allows null or undefined values.
 *
 * @example
 *   isNullable(optional(string())) // true
 *   isNullable(string()) // false
 *
 * @param schema - Schema to inspect.
 *
 * @returns `true` if optional, nullable, or nullish
 */
export function isNullable(schema: AnySchema): boolean {
  const analysis = extractStorageFacts(schema)
  return analysis.nullable || analysis.allowsUndefined
}
