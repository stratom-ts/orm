/** Base types allowed in DDL (with optional precision/length suffixes). */
const ALLOWED_PG_BASE_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'int2',
  'int4',
  'int8',
  'serial',
  'bigserial',
  'smallserial',
  'real',
  'double precision',
  'float4',
  'float8',
  'numeric',
  'decimal',
  'money',
  'boolean',
  'bool',
  'text',
  'varchar',
  'character varying',
  'char',
  'character',
  'bpchar',
  'uuid',
  'json',
  'jsonb',
  'date',
  'time',
  'timetz',
  'timestamp',
  'timestamptz',
  'timestamp without time zone',
  'timestamp with time zone',
  'time without time zone',
  'time with time zone',
  'bytea',
  'inet',
  'cidr',
  'macaddr',
  'macaddr8',
  'interval',
  'xml',
  'point',
  'line',
  'lseg',
  'box',
  'path',
  'polygon',
  'circle',
])

/**
 * SQL default expressions that may appear unquoted (not string literals).
 * Case-insensitive match after trim/collapse whitespace.
 */
const ALLOWED_DEFAULT_EXPRESSIONS = new Set([
  'null',
  'true',
  'false',
  'now()',
  'current_timestamp',
  'current_date',
  'current_time',
  'localtimestamp',
  'localtime',
  'gen_random_uuid()',
  'uuid_generate_v4()',
])

/**
 * Validates and returns a safe SQL type fragment for DDL.
 *
 * @param dataType - SQL data type string to validate (e.g. `varchar(255)`, `integer`)
 *
 * @returns Normalized, safe type string for use in DDL
 *
 * @throws Error when the type is not on the Postgres allowlist
 *
 * @example```ts
 * assertSafePostgresDataType('varchar(255)') // 'varchar(255)'
 * assertSafePostgresDataType('INTEGER')      // 'integer'
 * ```
 */
export function assertSafePostgresDataType(dataType: string): string {
  const trimmed = dataType.trim()
  if (!trimmed) {
    throw new Error('column data type must be a non-empty string')
  }
  if (/[;"\\]|--|\/\*|\*\//.test(trimmed)) {
    throw new Error(`unsafe column data type: ${JSON.stringify(dataType)}`)
  }

  const lower = trimmed.toLowerCase()
  const match = lower.match(
    /^([a-z][a-z0-9 ]*?)(?:\s*\(\s*([0-9]+(?:\s*,\s*[0-9]+)?)\s*\))?$/,
  )
  if (!match) {
    throw new Error(`unsupported column data type: ${JSON.stringify(dataType)}`)
  }
  const base = match[1]!.replace(/\s+/g, ' ').trim()
  if (!ALLOWED_PG_BASE_TYPES.has(base)) {
    throw new Error(`unsupported column data type: ${JSON.stringify(dataType)}`)
  }
  if (match[2]) {
    return `${base}(${match[2].replace(/\s+/g, '')})`
  }
  return base
}

/**
 * Formats a column default for DDL.
 *
 * - Number / boolean / null → SQL literals
 * - Allowlisted expressions (`now()`, `gen_random_uuid()`, …) → raw SQL
 * - Other strings → single-quoted literals (escaped)
 *
 * @param value - Default value to format.
 *
 * @returns SQL default expression
 *
 * @throws Error when value is a non-finite number
 *
 * @example```ts
 * formatPostgresDefault(null)       // 'null'
 * formatPostgresDefault(42)         // '42'
 * formatPostgresDefault('now()')    // 'now()'
 * formatPostgresDefault("O'Brien")  // '''O''Brien'''
 * ```
 */
export function formatPostgresDefault(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('column default number must be finite')
    }
    return String(value)
  }

  const trimmed = value.trim()
  const collapsed = trimmed.toLowerCase().replace(/\s+/g, ' ')
  if (ALLOWED_DEFAULT_EXPRESSIONS.has(collapsed)) {
    return collapsed
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return trimmed
  }

  return `'${value.replaceAll("'", "''")}'`
}

/** Canonicalizes PostgreSQL catalog default expressions for migration comparison. */
export function normalizePostgresDefaultExpression(expression: string): string {
  let normalized = expression.trim()
  let changed = true
  while (changed) {
    changed = false
    if (
      normalized.length >= 2 &&
      normalized[0] === '(' &&
      normalized[normalized.length - 1] === ')'
    ) {
      let depth = 0
      let fullyEnclosed = true
      for (let i = 0; i < normalized.length; i++) {
        if (normalized[i] === '(') depth++
        else if (normalized[i] === ')') depth--
        if (depth === 0 && i < normalized.length - 1) {
          fullyEnclosed = false
          break
        }
      }
      if (fullyEnclosed && depth === 0) {
        normalized = normalized.slice(1, -1).trim()
        changed = true
      }
    }
  }
  return normalized.replace(
    /(?:::(?:[a-z][a-z0-9_ ]*|"[^"]+")(?:\s*\([^)]*\))?(?:\[\])?)+$/i,
    '',
  )
}
