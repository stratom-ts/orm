import type { BaseIssue, BaseSchema } from 'valibot'
import type { NumberConstraints } from '@/types/constraints'

/**
 * Reads min/max value and integer constraints from a number schema pipe.
 *
 * @param schema - Number schema that may include constraint actions
 * @returns Extracted `minValue`, `maxValue`, and `isInteger` if present
 *
 * @example
 * ```ts
 * const c = getNumberConstraints(pipe(number(), minValue(0), integer()))
 * // { minValue: 0, isInteger: true }
 * ```
 */
export function getNumberConstraints(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): NumberConstraints {
  const constraints: NumberConstraints = {}

  if ('pipe' in schema && Array.isArray((schema as { pipe: unknown[] }).pipe)) {
    const pipeItems = (schema as { pipe: unknown[] }).pipe.slice(1)

    for (const item of pipeItems) {
      if (item && typeof item === 'object' && item !== null && 'type' in item) {
        const action = item as { type: string; requirement?: number }
        if (action.type === 'min_value') {
          constraints.minValue = action.requirement
        } else if (action.type === 'max_value') {
          constraints.maxValue = action.requirement
        } else if (
          action.type === 'integer' ||
          action.type === 'safe_integer'
        ) {
          constraints.isInteger = true
        }
      }
    }
  }

  return constraints
}
