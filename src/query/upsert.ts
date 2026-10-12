import type { ColumnRef } from '@/types'

const EXCLUDED_REF = Symbol('stratom.excluded')

/** A reference to the value proposed for a column by the current insert row. */
export type ExcludedRef<TColumn extends ColumnRef = ColumnRef> = Readonly<{
  [EXCLUDED_REF]: true
  column: TColumn
}>

/**
 * Refers to an inserted value from an `onConflict(...).doUpdate(...)` patch.
 *
 * @param column - Insertable column on the table being inserted into.
 *
 * @returns An opaque excluded-row reference validated by the insert builder.
 */
export function excluded<TColumn extends ColumnRef>(
  column: TColumn,
): ExcludedRef<TColumn> {
  return Object.freeze({ [EXCLUDED_REF]: true as const, column })
}

/** Checks for excluded references created by this package instance. */
export function isExcludedRef(value: unknown): value is ExcludedRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<ExcludedRef>)[EXCLUDED_REF] === true
  )
}
