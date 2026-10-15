import { types } from 'node:util'

import { analyzeSchema } from '@/schemas/utils/analyzeSchema'
import { QueryError, SchemaError } from '@/utils/error'

import type { DialectValueMappingContext } from '../types'

import { inferSqliteChoiceType } from './infer'
import { normalizeSqliteDataType } from './normalize'
import {
  isSqliteSafeInteger,
  isSqliteSupportedBigInt,
  isSqliteSupportedNumber,
} from './numeric'

/** Finds output-changing actions beneath pipes and schema wrappers. */
function hasTransformation(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return false

  const node = schema as { kind?: string; wrapped?: unknown; pipe?: readonly unknown[] }
  return (
    node.kind === 'transformation' ||
    hasTransformation(node.wrapped) ||
    (node.pipe?.some(hasTransformation) ?? false)
  )
}

/** Rejects affinities that cannot preserve the schema's values with built-in mapping. */
export function validateSqliteValueMapping(
  dataType: string,
  context: DialectValueMappingContext,
): void {
  const analysis = analyzeSchema(context.schema)
  const affinity = normalizeSqliteDataType(dataType)
  const kind = analysis.outputKind
  const supported =
    kind === 'date' ||
    kind === 'json' ||
    (kind === 'string' && (affinity === 'text' || affinity === 'blob')) ||
    ((kind === 'number' || kind === 'boolean') && affinity !== 'text') ||
    (kind === 'bigint' &&
      (affinity === 'integer' || affinity === 'numeric' || affinity === 'blob'))

  if (
    !supported ||
    hasTransformation(context.schema) ||
    hasTransformation(context.authoredSchema)
  ) {
    throw new SchemaError({
      message: `SQLite ${kind ?? analysis.baseSchema.type} schema with ${JSON.stringify(dataType)} (${affinity} affinity) requires explicit parameter and result mappings`,
    })
  }
}

/** Resolves logical value semantics independently of physical storage overrides. */
function mappingType(dataType: string, context?: DialectValueMappingContext): string {
  if (!context) return declaredType(dataType)

  validateSqliteValueMapping(dataType, context)
  const analysis = analyzeSchema(context.schema)
  switch (analysis.outputKind) {
    case 'string':
      return 'TEXT'
    case 'number':
      if (
        analysis.baseSchema.type === 'enum' ||
        analysis.baseSchema.type === 'picklist'
      ) {
        return inferSqliteChoiceType(analysis)
      }

      return analysis.numberConstraints.isInteger ? 'INTEGER' : 'REAL'
    case 'bigint':
      return 'BIGINT'
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'DATETIME'
    case 'json':
      return 'JSON'
    case undefined:
      return 'NULL'
  }
}

/** Removes type parameters and normalizes a SQLite logical type for value mapping. */
function declaredType(dataType: string): string {
  return dataType
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
    .replace(/\(.*\)$/, '')
    .trim()
}

/** Throws a query error that identifies the SQLite logical type and invalid value. */
function mappingError(dataType: string, message: string): never {
  throw new QueryError({ message: `SQLite ${declaredType(dataType)} ${message}` })
}

/** Rejects numbers outside JavaScript's safe integer range. */
function safeInteger(dataType: string, value: number): number {
  if (!isSqliteSafeInteger(value)) {
    return mappingError(dataType, 'values must be safe integers')
  }

  return value
}

/** Rejects non-finite numeric values before SQL parameter mapping. */
function finiteNumber(dataType: string, value: number): number {
  if (!isSqliteSupportedNumber(value)) {
    if (!Number.isFinite(value)) return mappingError(dataType, 'values must be finite')

    return mappingError(dataType, 'values must be safe integers')
  }

  return value
}

/** Converts a bigint only when its value remains a safe JavaScript integer. */
function numberFromBigInt(dataType: string, value: bigint): number {
  const number = Number(value)
  return safeInteger(dataType, number)
}

/** Rejects bigints outside SQLite's signed 64-bit integer range. */
function sqliteBigint(dataType: string, value: bigint): bigint {
  if (!isSqliteSupportedBigInt(value)) {
    return mappingError(dataType, 'values must be within the signed 64-bit integer range')
  }

  return value
}

/**
 * Converts supported integer inputs to bigint and rejects invalid numeric values.
 *
 * @param dataType - Physical SQL type used for validation, comparison, or value mapping.
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns The parsed bigint, or undefined for unsupported input representations.
 */
function bigintValue(dataType: string, value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return sqliteBigint(dataType, value)

  if (typeof value === 'number') {
    return sqliteBigint(dataType, BigInt(safeInteger(dataType, value)))
  }

  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    let parsed: bigint

    try {
      parsed = BigInt(value)
    } catch {
      return mappingError(dataType, 'values must be valid integers')
    }

    return sqliteBigint(dataType, parsed)
  }

  return undefined
}

const BOOLEAN_TYPES = new Set(['BOOLEAN', 'BOOL'])
const DATE_TYPES = new Set(['DATETIME', 'DATE'])

/** Serializes valid Date parameters and preserves values that are not dates. */
function mapDateParamValue(dataType: string, value: unknown): unknown {
  if (!(value instanceof Date)) return value

  if (Number.isNaN(value.getTime())) {
    return mappingError(dataType, 'Date values must be valid')
  }

  return value.toISOString()
}

/**
 * Decodes supported SQLite timestamps while preserving unrecognized or invalid date
 * values.
 *
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns Supported SQLite timestamps while preserving unrecognized or invalid date
 *   values.
 */
function mapDateResultValue(value: unknown): unknown {
  if (value instanceof Date) return value
  if (typeof value !== 'string' && typeof value !== 'number') return value

  if (typeof value === 'string') {
    const sqliteTimestamp = value.match(
      /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/,
    )

    if (sqliteTimestamp) {
      const [, year, month, day, hour, minute, second] = sqliteTimestamp
      const date = new Date(0)
      date.setUTCFullYear(Number(year), Number(month) - 1, Number(day))
      date.setUTCHours(Number(hour), Number(minute), Number(second), 0)

      const valid =
        date.getUTCFullYear() === Number(year) &&
        date.getUTCMonth() === Number(month) - 1 &&
        date.getUTCDate() === Number(day) &&
        date.getUTCHours() === Number(hour) &&
        date.getUTCMinutes() === Number(minute) &&
        date.getUTCSeconds() === Number(second)

      return valid ? date : value
    }
  }

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date
}

/**
 * Serializes JSON parameters while preserving strings already supplied by the caller.
 *
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns Serialized JSON parameters with already serialized strings preserved.
 */
function mapJsonParamValue(value: unknown): unknown {
  if (typeof value === 'string') return value

  const ancestors: object[] = []
  return JSON.stringify(value, function (_key, current: unknown) {
    if (typeof current === 'bigint' || types.isBigIntObject(current)) {
      throw new QueryError({
        message: 'SQLite JSON parameter value cannot be serialized',
      })
    }

    if (typeof current === 'object' && current !== null) {
      while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop()

      if (ancestors.includes(current)) {
        throw new QueryError({
          message: 'SQLite JSON parameter value cannot be serialized',
        })
      }

      ancestors.push(current)
    }

    return current
  })
}

/** Parses JSON result strings and preserves values that cannot be decoded. */
function mapJsonResultValue(value: unknown): unknown {
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value) as unknown
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause

    return value
  }
}

/** Checks integer precision before mapping SQLite integer parameters or results. */
function mapIntegerValue(dataType: string, value: unknown): unknown {
  if (typeof value === 'number') return safeInteger(dataType, value)
  if (typeof value === 'bigint') return numberFromBigInt(dataType, value)

  return value
}

/** Rejects non-finite numbers while preserving nonnumeric SQLite REAL values. */
function mapRealValue(dataType: string, value: unknown): unknown {
  if (typeof value === 'bigint') return numberFromBigInt(dataType, value)

  return typeof value === 'number' ? finiteNumber(dataType, value) : value
}

/** Maps a JavaScript parameter value to SQLite's declared logical type. */
export function mapSqliteParamValue(
  dataType: string,
  value: unknown,
  context?: DialectValueMappingContext,
): unknown {
  if (value === null || value === undefined) return value

  const type = mappingType(dataType, context)

  if (BOOLEAN_TYPES.has(type)) return typeof value === 'boolean' ? (value ? 1 : 0) : value
  if (DATE_TYPES.has(type)) return mapDateParamValue(dataType, value)
  if (type === 'JSON') return mapJsonParamValue(value)
  if (type === 'BIGINT') return bigintValue(dataType, value) ?? value
  if (type === 'INTEGER') return mapIntegerValue(dataType, value)
  if (type === 'REAL') return mapRealValue(dataType, value)

  return value
}

/** Maps a SQLite result value to the declared logical JavaScript type. */
export function mapSqliteResultValue(
  dataType: string,
  value: unknown,
  context?: DialectValueMappingContext,
): unknown {
  if (value === null || value === undefined) return value

  const type = mappingType(dataType, context)

  if (BOOLEAN_TYPES.has(type)) {
    if (value === 0 || value === 0n) return false
    if (value === 1 || value === 1n) return true

    return value
  }

  if (DATE_TYPES.has(type)) return mapDateResultValue(value)
  if (type === 'JSON') return mapJsonResultValue(value)
  if (type === 'BIGINT') return bigintValue(dataType, value) ?? value
  if (type === 'INTEGER') return mapIntegerValue(dataType, value)
  if (type === 'REAL') return mapRealValue(dataType, value)

  return value
}
