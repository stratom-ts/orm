import type { AnySchema } from '@/types/schema'

import { unwrapSchema } from '../valibot/unwrapSchema'

/**
 * Unwraps optional/nullable/nullish wrappers and pipes to the base schema.
 *
 * @example
 *   const base = getBaseSchema(optional(pipe(string(), minLength(1))))
 *   // string schema
 *
 * @param schema - Schema that may be wrapped or piped.
 *
 * @returns Innermost base schema type
 */
export function getBaseSchema(schema: AnySchema): AnySchema {
  return unwrapSchema(schema, true)
}
