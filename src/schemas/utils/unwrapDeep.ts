import type { unwrap } from 'valibot'

import type { AnySchema } from '@/types/schema'

import { analyzeSchema } from './analyzeSchema'

/** The innermost schema after supported presence and nullability wrappers are removed. */
type UnwrapDeepSchema<TSchema extends AnySchema> = TSchema extends Parameters<
  typeof unwrap
>[0]
  ? UnwrapDeepSchema<TSchema['wrapped']>
  : TSchema

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
export function unwrapDeep<TSchema extends AnySchema>(
  schema: TSchema,
): UnwrapDeepSchema<TSchema> {
  return analyzeSchema(schema).unwrappedSchema as UnwrapDeepSchema<TSchema>
}
