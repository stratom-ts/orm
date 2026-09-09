import { postgresBaseType } from './normalize'

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
export function mapPostgresResultValue(dataType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value

  const base = postgresBaseType(dataType)

  if (base === 'timestamp' || base === 'timestamptz') {
    if (value instanceof Date) return value
    if (typeof value !== 'string' && typeof value !== 'number') return value

    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date
  }

  if (base === 'json' || base === 'jsonb') {
    if (typeof value !== 'string') return value

    try {
      return JSON.parse(value) as unknown
    } catch {
      return value
    }
  }

  if (base === 'uuid') {
    return typeof value === 'string' ? value : String(value)
  }

  return value
}

/**
 * Maps a JavaScript value to its PostgreSQL parameter representation.
 *
 * Handles common type conversions:
 *
 * - `Date` → ISO string for timestamp types
 * - Objects/arrays → JSON string for json/jsonb
 * - Non-string values → string for uuid.
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
export function mapPostgresParamValue(dataType: string, value: unknown): unknown {
  if (value === null || value === undefined) return value

  const base = postgresBaseType(dataType)

  if (base === 'timestamp' || base === 'timestamptz') {
    if (value instanceof Date) return value.toISOString()
    return value
  }

  if (base === 'json' || base === 'jsonb') {
    if (typeof value !== 'string') return JSON.stringify(value)
    return value
  }

  if (base === 'uuid') {
    return typeof value === 'string' ? value : String(value)
  }

  return value
}
