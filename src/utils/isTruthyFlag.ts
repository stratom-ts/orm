/**
 * Type guard for truthy flag values (booleans, non-zero numbers, truthy strings).
 *
 * @example
 *   isTruthyFlag(true) // true
 *   isTruthyFlag('yes') // true
 *   isTruthyFlag('false') // false
 *   isTruthyFlag(0) // false
 *
 * @param value - Value to check.
 *
 * @returns `true` if the value represents a truthy flag
 */
export function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    return lower === 'yes' || lower === 'true' || lower === 't' || lower === '1'
  }
  return false
}
