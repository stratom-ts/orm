import { getBaseSchema } from '@/schemas/utils/getBaseSchema'
import { SchemaError } from '@/utils/error'

import type { DialectMappingContext } from '../types'

function contextOf(value: DialectMappingContext | string): DialectMappingContext {
  return typeof value === 'string' ? { dataType: value } : value
}
function isJsonSchema(context: DialectMappingContext): boolean {
  const type = logicalType(context)
  return [
    'object',
    'loose_object',
    'strict_object',
    'object_with_rest',
    'record',
    'array',
    'tuple',
    'loose_tuple',
    'strict_tuple',
    'tuple_with_rest',
  ].includes(type)
}
function logicalType(context: DialectMappingContext): string {
  if (!context.schema) return ''
  return String(getBaseSchema(context.schema).type)
}
/**
 * Formats a date as SQLite's canonical UTC text, matching `current_timestamp`.
 *
 * SQLite compares TEXT byte-wise, so application writes must use the same
 * spelling as database defaults or ordering and range filters mix two
 * incomparable formats in one column.
 */
function formatSqliteDate(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '')
}
function parseSqliteDate(value: string): Date | undefined {
  const match = value.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/)
  if (match) {
    const millis = match[3] ? `.${match[3].padEnd(3, '0')}` : ''
    const date = new Date(`${match[1]}T${match[2]}${millis}Z`)
    return Number.isNaN(date.getTime()) ? undefined : date
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date
}
export function mapSqliteResultValue(
  input: DialectMappingContext | string,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return value
  const context = contextOf(input)
  if (isJsonSchema(context)) {
    if (typeof value !== 'string') return value
    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }
  if (logicalType(context) === 'boolean')
    return value === 1 || value === '1' || value === true
  if (logicalType(context) === 'date') {
    if (value instanceof Date) return value
    const date = parseSqliteDate(String(value))
    return date ?? value
  }
  if (logicalType(context) === 'bigint') {
    if (typeof value === 'bigint') return value
    if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
    if (typeof value === 'number' && Number.isInteger(value))
      throw new SchemaError({
        message:
          'SQLite bigint result is an unsafe integer number; return a numeric string or bigint',
      })
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
    // Falling through would hand back a number or string typed as bigint,
    // which only fails later at the first arithmetic use.
    throw new SchemaError({
      message: `SQLite bigint result ${JSON.stringify(String(value))} is not an integer; return a numeric string or bigint`,
    })
  }
  return value
}
export function mapSqliteParamValue(
  input: DialectMappingContext | string,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return value
  const context = contextOf(input)
  if (isJsonSchema(context))
    return typeof value === 'string' ? value : JSON.stringify(value)
  if (logicalType(context) === 'boolean') return value ? 1 : 0
  if (logicalType(context) === 'date' && value instanceof Date)
    return formatSqliteDate(value)
  if (logicalType(context) === 'bigint') return value
  return value
}
