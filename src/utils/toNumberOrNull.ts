/**
 * Converts a value to a number, returning `null` for unconvertible or non-finite results.
 *
 * @example
 *   toNumberOrNull('42') // 42
 *   toNumberOrNull(null) // null
 *   toNumberOrNull('abc') // null
 *
 * @param value - Value to convert (string, number, null, undefined, etc.).
 *
 * @returns Parsed number, or `null` when the value is empty, non-finite, or unconvertible
 */
export function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}
