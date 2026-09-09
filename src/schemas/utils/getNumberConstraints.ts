import type { NumberConstraints } from '@/types/constraints'
import type { AnySchema, AnySchemaAsync } from '@/types/schema'

import { analyzeSchema } from './analyzeSchema'

/**
 * Reads min/max value and integer constraints from a number schema pipe.
 *
 * @example
 *   const c = getNumberConstraints(pipe(number(), minValue(0), integer()))
 *   // { minValue: 0, isInteger: true }
 *
 * @param schema - Number schema that may include constraint actions.
 *
 * @returns Extracted `minValue`, `maxValue`, and `isInteger` if present
 */
export function getNumberConstraints(
  schema: AnySchema | AnySchemaAsync,
): NumberConstraints {
  return analyzeSchema(schema as AnySchema).numberConstraints
}
