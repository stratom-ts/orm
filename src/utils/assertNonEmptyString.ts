import { SchemaError } from '@/utils/error'

/**
 * Asserts that a value is a non-empty string.
 *
 * @example
 *   assertNonEmptyString('hello', 'name')
 *   assertNonEmptyString('', 'name') // throws SchemaError
 *
 * @param value - Value to check.
 * @param label - Human-readable name used in the error message.
 *
 * @throws SchemaError - When `value` is not a string or is empty
 */
export function assertNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== 'string' || value.length === 0)
    throw new SchemaError({ message: `${label} must be a non-empty string` })
}
