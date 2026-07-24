/**
 * Type guard for `typeof value === 'number'`.
 *
 * @example
 *   ;```ts
 *   if (isNumber(n)) console.log(n.toFixed(2))
 *   ```
 *
 * @param value - Value to check.
 *
 * @returns `true` if `value` is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number'
}
