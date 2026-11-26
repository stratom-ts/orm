import type { DialectExpressionKind, DialectExpressionResult } from '@/dialects/types'
import type { TableHandle } from '@/types'

/** Private provenance survives nesting without storing conversions in SQL AST nodes. */
export type ResultValue = (
  | { kind: 'column'; handle: TableHandle; column: string }
  | { kind: DialectExpressionKind; operand?: ResultValue }
) & { bypassNull?: boolean }

/** SQL storage, parameter encoding and final-row decoding travel as one contract. */
export type ResultContract = DialectExpressionResult & {
  standard: boolean
  setContract(): string
}
