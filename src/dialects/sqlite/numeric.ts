/** SQLite's signed 64-bit integer bounds, shared by inference and value mapping. */
const SQLITE_INTEGER_MIN = -(2n ** 63n)
const SQLITE_INTEGER_MAX = 2n ** 63n - 1n

/** True when a JavaScript number is an exactly representable integer. */
export function isSqliteSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value)
}

/** True when a JavaScript number is finite and any integer value is safe. */
export function isSqliteSupportedNumber(value: number): boolean {
  return (
    Number.isFinite(value) && (!Number.isInteger(value) || isSqliteSafeInteger(value))
  )
}

/** True when a bigint can be represented by SQLite's signed 64-bit INTEGER. */
export function isSqliteSupportedBigInt(value: bigint): boolean {
  return value >= SQLITE_INTEGER_MIN && value <= SQLITE_INTEGER_MAX
}
