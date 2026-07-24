import type { BaseIssue, BaseSchema } from 'valibot'
import type { StringConstraints } from '@/types/constraints'

/**
 * Extracts string constraints (minLength, maxLength) from a schema.
 *
 * Parses the schema's pipe to find length constraints for string types.
 *
 * @param schema - The schema to extract constraints from
 * @returns Object containing minLength and maxLength constraints if defined
 */
export function getStringConstraints(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): StringConstraints {
  const constraints: StringConstraints = {}

  if ('pipe' in schema && Array.isArray((schema as { pipe: unknown[] }).pipe)) {
    const pipeItems = (schema as { pipe: unknown[] }).pipe.slice(1)

    for (const item of pipeItems) {
      if (item && typeof item === 'object' && item !== null && 'type' in item) {
        const action = item as { type: string; requirement?: number }
        if (action.type === 'min_length') {
          constraints.minLength = action.requirement
        } else if (action.type === 'max_length') {
          constraints.maxLength = action.requirement
        } else if (action.type === 'length') {
          constraints.minLength = action.requirement
          constraints.maxLength = action.requirement
        }
      }
    }
  }

  return constraints
}
