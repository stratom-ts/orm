import type { BaseIssue, BaseSchema } from 'valibot'
import type { NumberConstraints } from '@/types/constraints'

/**
 * Extracts number constraints (minValue, maxValue, isInteger) from a schema.
 *
 * Parses the schema's pipe to find numeric constraints for number types.
 *
 * @param schema - The schema to extract constraints from
 * @returns Object containing minValue, maxValue, and isInteger constraints if defined
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
