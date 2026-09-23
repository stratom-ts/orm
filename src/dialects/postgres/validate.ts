import { InvariantError } from '@/utils/error'

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
 * @example
 *   assertSafePostgresDataType('varchar(255)') // 'varchar(255)'
 *   assertSafePostgresDataType('INTEGER') // 'integer'
 *
 * @param dataType - SQL data type string to validate (e.g. `varchar(255)`, `integer`)
 *
 * @returns Normalized, safe type string for use in DDL
 *
 * @throws Error when the type is not on the Postgres allowlist
 */
export function assertSafePostgresDataType(dataType: string): string {
  const trimmed = dataType.trim()

  if (!trimmed) {
    throw new InvariantError('column data type must be a non-empty string')
  }

  if (/[;"\\]|--|\/\*|\*\//.test(trimmed)) {
    throw new InvariantError(`unsafe column data type: ${JSON.stringify(dataType)}`)
  }

  const lower = trimmed.toLowerCase()
  const match = lower.match(
    /^([a-z][a-z0-9 ]*?)(?:\s*\(\s*([0-9]+(?:\s*,\s*[0-9]+)?)\s*\))?$/,
  )

  if (!match) {
    throw new InvariantError(`unsupported column data type: ${JSON.stringify(dataType)}`)
  }

  const base = match[1]!.replace(/\s+/g, ' ').trim()

  if (!ALLOWED_PG_BASE_TYPES.has(base)) {
    throw new InvariantError(`unsupported column data type: ${JSON.stringify(dataType)}`)
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
 * @example
 *   formatPostgresDefault(null) // 'null'
 *   formatPostgresDefault(42) // '42'
 *   formatPostgresDefault('now()') // 'now()'
 *   formatPostgresDefault("O'Brien") // 'O''Brien'
 *
 * @param value - Default value to format.
 *
 * @returns SQL default expression
 *
 * @throws Error when value is a non-finite number
 */
export function formatPostgresDefault(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new InvariantError('column default number must be finite')
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

/**
 * Formats a tagged literal without interpreting string contents as SQL expressions.
 *
 * @example
 *   formatPostgresLiteral('now()') // "'now()'"
 *
 * @param value - Literal value to format.
 */
export function formatPostgresLiteral(value: string | number | boolean | null): string {
  if (typeof value !== 'string') return formatPostgresDefault(value)

  const escapedQuotes = value.replaceAll("'", "''")
  return value.includes('\\')
    ? `E'${escapedQuotes.replaceAll('\\', '\\\\')}'`
    : `'${escapedQuotes}'`
}

/**
 * Strips a pair of outer parentheses only when they fully enclose the
 * expression (balanced depth reaches zero at the final character).
 *
 * @param s - Input string that may be wrapped in parentheses.
 *
 * @returns The string with one outer layer removed, or the original string
 *   when the outer parens do not form a matching pair.
 */
function stripEnclosingParens(s: string): string {
  if (s.length < 2 || s[0] !== '(' || s[s.length - 1] !== ')') return s

  let depth = 0

  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    if (depth === 0 && i < s.length - 1) return s
  }

  return depth === 0 ? s.slice(1, -1).trim() : s
}

/**
 * Strips all balanced outer parentheses from an expression.
 *
 * @param expression - Expression that may have nested outer parentheses.
 */
function stripAllEnclosingParens(expression: string): string {
  let normalized = expression
  let previous: string

  do {
    previous = normalized
    normalized = stripEnclosingParens(normalized)
  } while (normalized !== previous)

  return normalized
}

/**
 * Canonicalizes a PostgreSQL catalog default expression for migration
 * comparison by normalizing whitespace, stripping balanced enclosing
 * parentheses, removing trailing `::type` casts (including chained casts
 * such as `::text::varchar`), and canonicalizing `CURRENT_TIMESTAMP`.
 *
 * @example
 *   normalizePostgresDefaultExpression('(now())') // 'now()'
 *   normalizePostgresDefaultExpression("('a') || ('b')") // "('a') || ('b')"
 *   normalizePostgresDefaultExpression("'x'::text::varchar") // "'x'"
 *
 * @param expression - Raw default expression from `pg_catalog`.
 *
 * @returns Normalized expression suitable for drift comparison.
 */
export function normalizePostgresDefaultExpression(expression: string): string {
  const normalized = stripAllEnclosingParens(expression.trim())
  const withoutCasts = normalized.replace(
    /(?:::(?:[a-z][a-z0-9_ ]*|"[^"]+")(?:\s*\([^)]*\))?(?:\[\])?)+$/i,
    '',
  )
  const currentTimestampCandidate = stripAllEnclosingParens(withoutCasts.trim())

  return /^current_timestamp$/i.test(currentTimestampCandidate)
    ? 'current_timestamp'
    : withoutCasts
}
