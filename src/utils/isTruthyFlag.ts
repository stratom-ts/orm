/**
 * Type guard for truthy flag values (booleans, finite non-zero numbers, truthy strings).
 *
 * @example
 *   isTruthyFlag(true) // true
 *   isTruthyFlag('yes') // true
 *   isTruthyFlag(42) // true
 *   isTruthyFlag(0) // false
 *   isTruthyFlag(NaN) // false
 *   isTruthyFlag('false') // false
 *
 * @param value - Value to check.
 *
 * @returns `true` if the value represents a truthy flag
 */
export function isTruthyFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0
  if (typeof value === 'string') {
    const lower = value.toLowerCase()
    return lower === 'yes' || lower === 'true' || lower === 't' || lower === '1'
  }
  return false
}
