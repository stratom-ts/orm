import { QueryError } from '@/utils/error'

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
  if (!Number.isSafeInteger(value)) {
    return mappingError(dataType, 'values must be safe integers')
  }

  return value
}

/** Rejects non-finite numeric values before SQL parameter mapping. */
function finiteNumber(dataType: string, value: number): number {
  if (!Number.isFinite(value)) return mappingError(dataType, 'values must be finite')

  return value
}

/** Converts a bigint only when its value remains a safe JavaScript integer. */
function numberFromBigInt(dataType: string, value: bigint): number {
  const number = Number(value)
  return safeInteger(dataType, number)
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
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(safeInteger(dataType, value))

  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    try {
      return BigInt(value)
    } catch {
      return mappingError(dataType, 'values must be valid integers')
    }
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

  try {
    return JSON.stringify(value)
  } catch (cause) {
    throw new QueryError({
      message: 'SQLite JSON parameter value cannot be serialized',
      cause,
    })
  }
}

/** Parses JSON result strings and preserves values that cannot be decoded. */
function mapJsonResultValue(value: unknown): unknown {
  if (typeof value !== 'string') return value

  try {
    return JSON.parse(value) as unknown
  } catch {
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
  return typeof value === 'number' ? finiteNumber(dataType, value) : value
}

/** Maps a JavaScript parameter value to SQLite's declared logical type. */
export function mapSqliteParamValue(dataType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value

  const type = declaredType(dataType)

  if (BOOLEAN_TYPES.has(type)) return typeof value === 'boolean' ? (value ? 1 : 0) : value
  if (DATE_TYPES.has(type)) return mapDateParamValue(dataType, value)
  if (type === 'JSON') return mapJsonParamValue(value)
  if (type === 'BIGINT') return bigintValue(dataType, value) ?? value
  if (type === 'INTEGER') return mapIntegerValue(dataType, value)
  if (type === 'REAL') return mapRealValue(dataType, value)

  return value
}

/** Maps a SQLite result value to the declared logical JavaScript type. */
export function mapSqliteResultValue(dataType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value

  const type = declaredType(dataType)

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
