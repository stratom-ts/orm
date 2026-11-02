import type { StorageFacts, StorageStringFormat } from '@/storage/facts'
import { QueryError, SchemaError } from '@/utils/error'

import type { DialectValueMappingContext } from '../types'

import { inferPostgresColumnTypeFromFacts } from './infer'
import { extractPostgresBaseType } from './normalize'

const BIGINT_OUTPUT_STORAGE = new Set([
  'numeric',
  'decimal',
  'bigint',
  'integer',
  'smallint',
])

const TEMPORAL_FORMAT_STORAGE: Partial<Record<StorageStringFormat, string>> = {
  iso_date: 'date',
  iso_time: 'time',
  iso_time_second: 'time',
  iso_date_time: 'timestamp',
  iso_date_time_second: 'timestamp',
  iso_timestamp: 'timestamptz',
}

const NUMBER_OUTPUT_STORAGE = new Set([
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
])

const DATE_OUTPUT_STORAGE = new Set(['date', 'timestamp', 'timestamptz'])
const TEMPORAL_STORAGE = new Set(['date', 'time', 'timestamp', 'timestamptz'])

const JSON_OUTPUT_STORAGE = new Set(['json', 'jsonb'])

/** Storage that the pg driver's default text parsers return as non-strings. */
const NON_STRING_STORAGE = new Set([
  ...NUMBER_OUTPUT_STORAGE,
  ...JSON_OUTPUT_STORAGE,
  'oid',
  'boolean',
  'bytea',
  'interval',
  'point',
  'circle',
])

/** Serial pseudo-types store their underlying integer type. */
const SERIAL_STORAGE: Readonly<Record<string, string>> = {
  smallserial: 'smallint',
  serial: 'integer',
  bigserial: 'bigint',
}

/** Resolves serial storage for value mapping without changing authored SQL types. */
function mappingStorage(dataType: string): string {
  const base = extractPostgresBaseType(dataType)
  return SERIAL_STORAGE[base] ?? base
}

/** Checks whether PostgreSQL storage returns values of one analyzed scalar output kind. */
function canStoreOutputKind(base: string, kind: StorageFacts['outputKind']): boolean {
  switch (kind) {
    case 'string':
      return !NON_STRING_STORAGE.has(base) && !base.endsWith('[]')
    case 'number':
      return NUMBER_OUTPUT_STORAGE.has(base)
    case 'bigint':
      return BIGINT_OUTPUT_STORAGE.has(base)
    case 'boolean':
      return base === 'boolean'
    case 'date':
      return DATE_OUTPUT_STORAGE.has(base)
    case 'json':
      return JSON_OUTPUT_STORAGE.has(base)
    case undefined:
      return false
  }
}

/**
 * Rejects scalar storage whose driver values cannot carry the analyzed output kind.
 *
 * Composite outputs are checked separately by their branch-aware validation. `unknown()`
 * and `any()` outputs are accepted because their inferred type admits any driver value.
 *
 * @param dataType - Selected PostgreSQL column type.
 * @param facts - Analysis of the column's logical schema.
 *
 * @throws SchemaError when built-in mapping cannot return the output kind
 */
function assertPostgresScalarStorage(dataType: string, facts: StorageFacts): void {
  if (facts.composite) return

  const kind = facts.outputKind

  if (facts.outputState === 'unconstrained') return

  const base = mappingStorage(dataType)

  assertTemporalFormatStorage(base, facts)

  if (canStoreOutputKind(base, kind)) return

  throw new SchemaError({
    message: `PostgreSQL ${kind ?? 'unknown'} schema with ${JSON.stringify(dataType)} requires explicit parameter and result mappings. Provide paired column mapParam/mapResult or client mapParamValue/mapResultValue hooks.`,
  })
}

/** Rejects proven ISO formats stored in a different native temporal type. */
function assertTemporalFormatStorage(base: string, facts: StorageFacts): void {
  if (facts.outputKind !== 'string') return
  if (!TEMPORAL_STORAGE.has(base)) return

  const formats = facts.stringFormats.filter((format) => TEMPORAL_FORMAT_STORAGE[format])

  if (formats.length && !matchesTemporalFormatStorage(base, formats)) {
    throw new SchemaError({
      message: `PostgreSQL ISO output formats ${formats.join(', ')} cannot use ${JSON.stringify(base)} storage without changing their value shape or offset. Provide paired column mapParam/mapResult or client mapParamValue/mapResultValue hooks.`,
    })
  }
}

/** Checks whether one proven ISO format matches its native PostgreSQL storage. */
function matchesTemporalFormatStorage(
  base: string,
  formats: StorageFacts['stringFormats'],
): boolean {
  return formats.length === 1 && TEMPORAL_FORMAT_STORAGE[formats[0]] === base
}

/** Selects authored reference formats only when native storage can preserve them. */
function referenceTemporalAnalysis(
  base: string,
  authored: StorageFacts | undefined,
): StorageFacts | undefined {
  if (!authored) return undefined

  const formats = authored.stringFormats.filter(
    (format) => TEMPORAL_FORMAT_STORAGE[format],
  )

  if (!formats.length) return undefined
  if (base === 'text' || base === 'varchar') return authored

  if (!matchesTemporalFormatStorage(base, formats)) {
    throw new SchemaError({
      message: `PostgreSQL reference output formats ${formats.join(', ')} cannot use ${JSON.stringify(base)} storage unambiguously. Provide paired column mapParam/mapResult or client mapParamValue/mapResultValue hooks.`,
    })
  }

  return authored
}

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
  base: string,
  value: string,
  formats: StorageFacts['stringFormats'],
): string | undefined {
  if (base === 'time' && formats.includes('iso_time')) return isoTimeResult(value, false)

  if (base === 'time' && formats.includes('iso_time_second'))
    return isoTimeResult(value, true)

  if (base === 'timestamp' && formats.includes('iso_date_time'))
    return isoDateTimeResult(value, false)

  if (base === 'timestamp' && formats.includes('iso_date_time_second'))
    return isoDateTimeResult(value, true)

  if (base === 'timestamptz' && formats.includes('iso_timestamp'))
    return isoTimestampResult(value)

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
): unknown {
  const kind = facts?.outputKind

  if (kind === 'string' && typeof value === 'string') {
    const iso = mapIsoStringResult(base, value, facts?.stringFormats ?? [])

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

/** Validates selected storage against resolved and locally authored logical output. */
function validatePostgresValueMappingFromFacts(
  dataType: string,
  target: StorageFacts,
  authored?: StorageFacts,
): void {
  validatePostgresCompositeMapping(dataType, target)

  if (authored) {
    validatePostgresCompositeMapping(dataType, authored)

    if (authored.outputKind !== target.outputKind) {
      throw new SchemaError({
        message:
          'PostgreSQL reference transformations must preserve the resolved target output kind. Provide paired column mapParam/mapResult or client mapParamValue/mapResultValue hooks.',
      })
    }

    referenceTemporalAnalysis(extractPostgresBaseType(dataType), authored)
  }

  assertPostgresScalarStorage(dataType, target)
}

function validatePostgresCompositeMapping(dataType: string, facts: StorageFacts): void {
  if (!facts.composite) return

  const base = mappingStorage(dataType)

  if (facts.outputKind === 'string' && (base === 'text' || base === 'varchar')) return

  const inferred = extractPostgresBaseType(inferPostgresColumnTypeFromFacts(facts))
  const kind = facts.outputKind
  const compatible =
    kind === 'number'
      ? isPostgresCompositeNumberStorage(inferred, base)
      : kind === 'bigint'
        ? base === 'numeric' ||
          base === 'decimal' ||
          (inferred === 'bigint' && base === 'bigint')
        : kind === 'json'
          ? base === 'json' || base === 'jsonb'
          : base === inferred

  if (!compatible)
    throw new SchemaError({
      message: `PostgreSQL ${kind ?? 'unknown'} composite with ${JSON.stringify(dataType)} requires explicit parameter and result mappings`,
    })
}

function isPostgresCompositeNumberStorage(inferred: string, selected: string): boolean {
  const widths = ['smallint', 'integer', 'bigint']
  const minimum = widths.indexOf(inferred)

  if (minimum < 0) return selected === inferred
  if (selected === 'double precision') return inferred !== 'bigint'

  return widths.indexOf(selected) >= minimum
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

  const base = mappingStorage(dataType)

  const facts = referenceTemporalAnalysis(base, authored) ?? target

  const kind = facts?.outputKind

  if (kind === 'bigint' && BIGINT_OUTPUT_STORAGE.has(base)) return mapBigintResult(value)

  if (kind === 'number' && base === 'bigint') return mapSafeNumberResult(value)

  if (
    base === 'date' ||
    base === 'time' ||
    base === 'timestamp' ||
    base === 'timestamptz'
  )
    return mapTemporalResult(base, value, facts)

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

  const base = mappingStorage(dataType)
  const kind = facts?.outputKind

  if (kind === 'bigint' && BIGINT_OUTPUT_STORAGE.has(base))
    return mapBigintResult(value).toString()

  if (kind === 'number' && base === 'bigint') return mapSafeNumberResult(value)

  if (base === 'timestamp' || base === 'timestamptz') {
    if (value instanceof Date) return value.toISOString()

    return value
  }

  if (base === 'json' || base === 'jsonb') {
    assertPostgresJsonCompositeParam(value, facts, authored)

    if (typeof value !== 'string') return JSON.stringify(value)

    return value
  }

  if (base === 'uuid') {
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

/** Proves native numeric storage without invoking custom mappings. */
function numericAssignmentType(
  dataType: string,
  context: DialectValueMappingContext,
): 'integer' | 'float' | undefined {
  const facts = context.authoredFacts ?? context.facts
  const storage = mappingStorage(dataType)

  if (
    facts.outputKind !== 'number' ||
    facts.outputState !== 'known' ||
    !['smallint', 'integer', 'bigint', 'real', 'double precision'].includes(storage)
  )
    return undefined

  return facts.numberConstraints.isInteger ||
    ['smallint', 'integer', 'bigint'].includes(storage)
    ? 'integer'
    : 'float'
}

export {
  assertPostgresScalarStorage,
  validatePostgresValueMapping,
  validatePostgresValueMappingFromFacts,
  mapPostgresResultValue,
  mapPostgresResultValueFromFacts,
  mapPostgresParamValue,
  mapPostgresParamValueFromFacts,
  numericAssignmentType,
}
