import { QueryError } from '@/utils/error'

import type { DialectExpressionResult } from './types'

/** Rejects native results that cannot satisfy a declared helper result. */
export function expressionMappingError(): never {
  throw new QueryError({ message: 'SQL expression result cannot be represented safely' })
}

/** Reads an exact integral result without passing text through a lossy number. */
export function expressionBigint(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)

  if (typeof value === 'string' && /^-?\d+(?:\.0+)?$/.test(value))
    return BigInt(value.replace(/\.0+$/, ''))

  return expressionMappingError()
}

/** Converts an exact integer only inside JavaScript's safe range. */
export function expressionInteger(value: unknown): number {
  const exact = expressionBigint(value)
  const result = Number(exact)
  return Number.isSafeInteger(result) && BigInt(result) === exact
    ? result
    : expressionMappingError()
}

export function expressionCount(value: unknown): number {
  const count = expressionInteger(value)
  return count >= 0 ? count : expressionMappingError()
}

/** Floating storage promises finite approximation, never integer precision recovery. */
export function expressionFloat(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    return expressionMappingError()

  return !Number.isInteger(value) || Number.isSafeInteger(value)
    ? value
    : expressionMappingError()
}

export function expressionString(value: unknown): string {
  return typeof value === 'string' ? value : expressionMappingError()
}

/** Validates Date results and parses timezone-free native UTC text explicitly. */
export function expressionDate(value: unknown): Date {
  if (value instanceof Date)
    return Number.isFinite(value.getTime()) ? value : expressionMappingError()

  if (typeof value !== 'string') return expressionMappingError()

  const normalized = value.replace(' ', 'T')
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized)
      ? `${normalized}Z`
      : normalized,
  )

  return Number.isFinite(date.getTime()) ? date : expressionMappingError()
}

export function expressionDateParam(value: unknown): string {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value.toISOString()
    : expressionMappingError()
}

/** Builds the small adapter contract shared by the two built-in dialects. */
export function expressionResult(
  dataType: string,
  outputKind: DialectExpressionResult['outputKind'],
  mapResult: DialectExpressionResult['mapResult'],
  mapParam = mapResult,
): DialectExpressionResult {
  return { dataType, outputKind, mapResult, mapParam }
}
