import type { AnySchema } from '@/types/schema'

import { analyzeSchema } from './analyzeSchema'

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
  return analyzeSchema(schema).baseSchema
}
