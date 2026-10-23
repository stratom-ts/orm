import { analyzeSchema } from '@/schemas/utils/analyzeSchema'
import { QueryError, SchemaError } from '@/utils/error'

import type { DialectValueMappingContext } from '../types'

import { extractPostgresBaseType } from './normalize'

const BIGINT_OUTPUT_STORAGE = new Set([
  'numeric',
  'decimal',
  'bigint',
  'integer',
  'smallint',
])

/** Rejects reference outputs that built-in target mapping cannot preserve. */
export function validatePostgresValueMapping(
  _dataType: string,
  context: DialectValueMappingContext,
): void {
  if (!context.authoredSchema) return

  const target = analyzeSchema(context.schema)
  const authored = analyzeSchema(context.authoredSchema)

  if (authored.outputKind !== target.outputKind) {
    throw new SchemaError({
      message:
        'PostgreSQL reference transformations must preserve the resolved target output kind or provide explicit parameter and result mappings',
    })
  }
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
export function mapPostgresResultValue(
  dataType: string,
  value: unknown,
  context?: DialectValueMappingContext,
): unknown {
  if (value === null || value === undefined) return value

  const base = extractPostgresBaseType(dataType)

  const kind = context ? analyzeSchema(context.schema).outputKind : undefined

  if (kind === 'bigint' && BIGINT_OUTPUT_STORAGE.has(base)) return mapBigintResult(value)

  if (kind === 'number' && base === 'bigint') return mapSafeNumberResult(value)

  if (base === 'timestamp' || base === 'timestamptz') {
    if (kind === 'string') return value instanceof Date ? value.toISOString() : value
    if (value instanceof Date) return value
    if (typeof value !== 'string' && typeof value !== 'number') return value

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date
  }

  if (base === 'json' || base === 'jsonb')
    return typeof value === 'string' ? parseJsonResult(value) : value

  if (base === 'uuid') {
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
export function mapPostgresParamValue(
  dataType: string,
  value: unknown,
  context?: DialectValueMappingContext,
): unknown {
  if (value === null || value === undefined) return value

  const base = extractPostgresBaseType(dataType)
  const kind = context ? analyzeSchema(context.schema).outputKind : undefined

  if (kind === 'bigint' && BIGINT_OUTPUT_STORAGE.has(base))
    return mapBigintResult(value).toString()

  if (kind === 'number' && base === 'bigint') return mapSafeNumberResult(value)

  if (base === 'timestamp' || base === 'timestamptz') {
    if (value instanceof Date) return value.toISOString()

    return value
  }

  if (base === 'json' || base === 'jsonb') {
    if (typeof value !== 'string') return JSON.stringify(value)

    return value
  }

  if (base === 'uuid') {
    return mapUuidValue(value)
  }

  return value
}
