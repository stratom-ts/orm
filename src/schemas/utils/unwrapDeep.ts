import { unwrap } from 'valibot'

import type { AnySchema } from '@/types/schema'

import { analyzeSchema } from './analyzeSchema'

/**
 * Recursively unwraps optional/nullable/nullish wrappers.
 *
 * @example
 *   const inner = unwrapDeep(
 *     optional(pipe(string(), column({ physicalType: { postgresql: 'uuid' } }))),
 *   )
 *
 * @param schema - Schema that may be wrapped.
 *
 * @returns Innermost schema with pipes intact
 */
export function unwrapDeep<TSchema extends Parameters<typeof unwrap>[0]>(
  schema: AnySchema | TSchema,
): TSchema['wrapped'] {
  return analyzeSchema(schema as AnySchema).unwrappedSchema as TSchema['wrapped']
}
