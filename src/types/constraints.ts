/** Length bounds extracted from a string schema pipe. */
export interface StringConstraints {
  /** Minimum string length. */
  minLength?: number
  /** Maximum string length. */
  maxLength?: number
}

/** Numeric bounds extracted from a number schema pipe. */
export interface NumberConstraints {
  /** Minimum numeric value. */
  minValue?: number
  /** Maximum numeric value. */
  maxValue?: number
  /** Whether the schema requires an integer. */
  isInteger?: boolean
  /** Whether the schema requires JavaScript's safe-integer range. */
  isSafeInteger?: boolean
}
