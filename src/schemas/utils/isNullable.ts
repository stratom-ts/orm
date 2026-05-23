import type { BaseIssue, BaseSchema } from 'valibot'

/**
 * Determines if a schema allows null values.
 *
 * Checks for nullable, optional, and nullish wrapper types, as well as
 * pipe actions that indicate nullability.
 *
 * @param schema - The schema to check for nullability
 * @returns True if the schema allows null values
 */
export function isNullable(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): boolean {
  if (schema.type === 'optional' || schema.type === 'nullish') {
    return true
  }
  if (schema.type === 'nullable') {
    return true
  }

  if ('pipe' in schema && Array.isArray((schema as { pipe: unknown[] }).pipe)) {
    const pipeItems = (schema as { pipe: unknown[] }).pipe
    for (const item of pipeItems) {
      if (item && typeof item === 'object' && item !== null && 'type' in item) {
        const actionType = (item as { type: string }).type
        if (
          actionType === 'optional' ||
          actionType === 'nullish' ||
          actionType === 'nullable'
        ) {
          return true
        }
      }
    }
  }

  return false
}
