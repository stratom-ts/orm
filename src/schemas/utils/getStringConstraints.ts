import type { StringConstraints } from '@/types/constraints'
import type { AnySchema } from '@/types/schema'

/**
 * Reads min/max length constraints from a string schema pipe.
 *
 * @param schema - String schema that may include length actions
 * @returns Extracted `minLength` and `maxLength` if present
 *
 * @example
 * ```ts
 * const c = getStringConstraints(pipe(string(), maxLength(255)))
 * // { maxLength: 255 }
 * ```
 */
export function getStringConstraints(schema: AnySchema): StringConstraints {
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
