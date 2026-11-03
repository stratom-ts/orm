import type { StorageFacts, StorageStringFormat } from '@/storage/facts'
import { QueryError } from '@/utils/error'

import type { DialectValueMappingContext } from '../types'

import {
  resolvePostgresValueStorage,
  validatePostgresValueMappingFromFacts,
} from './storage'

/** Formats PostgreSQL's textual time at the precision promised by the schema. */
function isoTimeResult(value: string, withSeconds: boolean): string {
  const match = /^(\d{2}:\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value)

  if (!match) return value

  const [, minute, second, fraction] = match

  if (fraction && /[1-9]/.test(fraction))
    throw new QueryError({
      message: 'PostgreSQL time has finer precision than the schema output',
    })

  if (!withSeconds && second !== '00')
    throw new QueryError({
      message: 'PostgreSQL time has finer precision than the schema output',
    })

  return withSeconds ? `${minute}:${second}` : minute
}

/** Converts PostgreSQL's session-offset spelling to an ISO timestamp offset. */
function isoTimestampResult(value: string): string {
  const normalized = value.replace(' ', 'T')

  const historical =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?([+-])(\d{2}):?(\d{2}):?(\d{2})$/.exec(
      normalized,
    )

  if (historical) {
    const [, day, time, , direction, hour, minute, second] = historical
    const fraction = historical.at(3) ?? ''
    const wallClock = new Date(`${day}T${time}Z`)

    if (Number.isNaN(wallClock.getTime())) return normalized

    const offsetSeconds =
      (Number(hour) * 3600 + Number(minute) * 60 + Number(second)) *
      (direction === '+' ? 1 : -1)

    const utc = new Date(wallClock.getTime() - offsetSeconds * 1000)
    return `${utc.toISOString().slice(0, 19)}${fraction}Z`
  }

  return normalized.replace(
    /([+-]\d{2})(?::?(\d{2}))?$/,
    (_all, hour: string, minute?: string) =>
      hour === '+00' && (!minute || minute === '00') ? 'Z' : `${hour}:${minute ?? '00'}`,
  )
}

/** Restores the strict Valibot minute or second form from native timestamp text. */
function isoDateTimeResult(value: string, withSeconds: boolean): string {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(value)
  return match ? `${match[1]}T${isoTimeResult(match[2], withSeconds)}` : value
}

/** Applies an ISO format only when its native storage matches the selected type. */
function mapIsoStringResult(
  value: string,
  format: StorageStringFormat | undefined,
): string | undefined {
  if (format === 'iso_time') return isoTimeResult(value, false)

  if (format === 'iso_time_second') return isoTimeResult(value, true)

  if (format === 'iso_date_time') return isoDateTimeResult(value, false)

  if (format === 'iso_date_time_second') return isoDateTimeResult(value, true)

  if (format === 'iso_timestamp') return isoTimestampResult(value)

  return undefined
}

/** Parses an instant or UTC wall clock while leaving unparseable native text alone. */
function parseNativeTimestamp(base: string, value: string | number): Date | undefined {
  const date = new Date(
    typeof value === 'string'
      ? base === 'timestamp'
        ? `${value.replace(' ', 'T')}${/[Zz]|[+-]\d{2}(?::?\d{2})?$/.test(value) ? '' : 'Z'}`
        : isoTimestampResult(value)
      : value,
  )

  return Number.isNaN(date.getTime()) ? undefined : date
}

/** Maps one native temporal value after the schema's output family is known. */
function mapTemporalResult(
  base: string,
  value: unknown,
  facts: StorageFacts | undefined,
  format: StorageStringFormat | undefined,
): unknown {
  const kind = facts?.outputKind

  if (kind === 'string' && typeof value === 'string') {
    const iso = mapIsoStringResult(value, format)

    if (iso !== undefined) return iso
  }

  if (base === 'date' && kind === 'date' && typeof value === 'string') {
    const date = new Date(`${value}T00:00:00Z`)
    return Number.isNaN(date.getTime()) ? value : date
  }

  if (base !== 'timestamp' && base !== 'timestamptz') return value
  if (value instanceof Date) return kind === 'string' ? value.toISOString() : value
  if (typeof value !== 'string' && typeof value !== 'number') return value

  const date = parseNativeTimestamp(base, value)

  if (!date) return value

  return kind === 'string' ? date.toISOString() : date
}

/** Rejects storage and reference outputs that built-in mapping cannot preserve. */
function validatePostgresValueMapping(
  dataType: string,
  context: DialectValueMappingContext,
): void {
  validatePostgresValueMappingFromFacts(dataType, context.facts, context.authoredFacts)
}

function numericMappingError(): never {
  throw new QueryError({
    message: 'PostgreSQL numeric value cannot be represented safely by the schema output',
  })
}

function mapBigintResult(value: unknown): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)

  if (typeof value === 'string' && /^-?\d+(?:\.0+)?$/.test(value))
    return BigInt(value.replace(/\.0+$/, ''))

  return numericMappingError()
}

function mapSafeNumberResult(value: unknown): number {
  if (typeof value === 'bigint') {
    const number = Number(value)
    return Number.isSafeInteger(number) && BigInt(number) === value
      ? number
      : numericMappingError()
  }

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : numericMappingError()
  }

  if (typeof value === 'string' && /^-?\d+(?:\.0+)?$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) &&
      BigInt(number).toString() === BigInt(value.replace(/\.0+$/, '')).toString()
      ? number
      : numericMappingError()
  }

  return numericMappingError()
}

/**
 * Normalizes supported UUID representations while preserving other result values.
 *
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns Supported UUID representations while preserving other result values.
 */
function mapUuidValue(value: unknown): unknown {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return String(value)
  }

  return value
}

/**
 * Maps a PostgreSQL result value to its JavaScript representation.
 *
 * Handles common type conversions:
 *
 * - `timestamp` / `timestamptz` → `Date`
 * - `json` / `jsonb` → parsed JSON
 * - `uuid` → string.
 *
 * @example
 *   mapPostgresResultValue('timestamptz', '2024-01-15T10:30:00Z')
 *   // new Date('2024-01-15T10:30:00Z')
 *
 *   mapPostgresResultValue('jsonb', '{"key":"value"}')
 *   // { key: 'value' }
 *
 * @param dataType - PostgreSQL column data type.
 * @param value - Raw value from the database driver.
 *
 * @returns Mapped JavaScript value
 */
function mapPostgresResultValue(
  dataType: string,
  value: unknown,
  context?: DialectValueMappingContext,
): unknown {
  if (value === null || value === undefined) return value

  return mapPostgresResultValueFromFacts(
    dataType,
    value,
    context?.facts,
    context?.authoredFacts,
  )
}

/** Maps a driver value using only logical storage facts. */
function mapPostgresResultValueFromFacts(
  dataType: string,
  value: unknown,
  target?: StorageFacts,
  authored?: StorageFacts,
): unknown {
  if (value === null || value === undefined) return value

  const storage = resolvePostgresValueStorage(dataType, target, authored)

  if (storage.type === 'bigint') return mapBigintResult(value)
  if (storage.type === 'safeNumber') return mapSafeNumberResult(value)

  if (
    storage.type === 'date' ||
    storage.type === 'time' ||
    storage.type === 'timestamp' ||
    storage.type === 'timestamptz'
  )
    return mapTemporalResult(storage.type, value, storage.facts, storage.format)

  if (storage.type === 'json')
    return typeof value === 'string' ? parseJsonResult(value) : value

  if (storage.type === 'uuid') {
    return mapUuidValue(value)
  }

  return value
}

/** Leaves malformed JSON text intact while retaining unexpected parser failures. */
function parseJsonResult(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause

    return value
  }
}

/**
 * Maps a JavaScript value to its PostgreSQL parameter representation.
 *
 * Handles common type conversions:
 *
 * - `Date` → ISO string for timestamp types
 * - Objects/arrays → JSON string for json/jsonb
 * - String-compatible primitive values → string for uuid.
 *
 * @example
 *   mapPostgresParamValue('timestamptz', new Date('2024-01-15T10:30:00Z'))
 *   // '2024-01-15T10:30:00.000Z'
 *
 *   mapPostgresParamValue('jsonb', { key: 'value' })
 *   // '{"key":"value"}'
 *
 * @param dataType - PostgreSQL column data type.
 * @param value - JavaScript value to map.
 *
 * @returns PostgreSQL-compatible parameter value
 */
function mapPostgresParamValue(
  dataType: string,
  value: unknown,
  context?: DialectValueMappingContext,
): unknown {
  if (value === null || value === undefined) return value

  return mapPostgresParamValueFromFacts(
    dataType,
    value,
    context?.facts,
    context?.authoredFacts,
  )
}

/** Maps a parameter using only logical storage facts. */
function mapPostgresParamValueFromFacts(
  dataType: string,
  value: unknown,
  facts?: StorageFacts,
  authored?: StorageFacts,
): unknown {
  if (value === null || value === undefined) return value

  const storage = resolvePostgresValueStorage(dataType, facts)

  if (storage.type === 'bigint') return mapBigintResult(value).toString()
  if (storage.type === 'safeNumber') return mapSafeNumberResult(value)

  if (storage.type === 'timestamp' || storage.type === 'timestamptz') {
    if (value instanceof Date) return value.toISOString()

    return value
  }

  if (storage.type === 'json') {
    assertPostgresJsonCompositeParam(value, facts, authored)

    if (typeof value !== 'string') return JSON.stringify(value)

    return value
  }

  if (storage.type === 'uuid') {
    return mapUuidValue(value)
  }

  return value
}

function assertPostgresJsonCompositeParam(
  value: unknown,
  facts: StorageFacts | undefined,
  authored: StorageFacts | undefined,
): void {
  if (!(facts?.composite || authored?.composite) || !containsNonFiniteNumber(value))
    return

  throw new QueryError({
    message:
      'PostgreSQL JSON composite cannot serialize a non-finite number without changing it to null',
  })
}

function containsNonFiniteNumber(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'number') return !Number.isFinite(value)
  if (typeof value !== 'object' || value === null || seen.has(value)) return false

  seen.add(value)
  return Object.values(value).some((item) => containsNonFiniteNumber(item, seen))
}

export {
  validatePostgresValueMapping,
  mapPostgresResultValue,
  mapPostgresResultValueFromFacts,
  mapPostgresParamValue,
  mapPostgresParamValueFromFacts,
}
