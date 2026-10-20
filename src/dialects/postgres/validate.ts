import { MigrationError, SchemaError } from '@/utils/error'

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
    throw new SchemaError({ message: 'column data type must be a non-empty string' })
  }

  if (/[;"\\]|--|\/\*|\*\//.test(trimmed)) {
    throw new SchemaError({
      message: `unsafe column data type: ${JSON.stringify(dataType)}`,
    })
  }

  const lower = trimmed.toLowerCase()
  const match = lower.match(
    /^([a-z][a-z0-9 ]*?)(?:\s*\(\s*([0-9]+(?:\s*,\s*[0-9]+)?)\s*\))?$/,
  )

  if (!match) {
    throw new SchemaError({
      message: `unsupported column data type: ${JSON.stringify(dataType)}`,
    })
  }

  const base = match[1]!.replace(/\s+/g, ' ').trim()

  if (!ALLOWED_PG_BASE_TYPES.has(base)) {
    throw new SchemaError({
      message: `unsupported column data type: ${JSON.stringify(dataType)}`,
    })
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
      throw new SchemaError({ message: 'column default number must be finite' })
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

/** Validates and trims an authored PostgreSQL dialect expression. */
export function assertSafePostgresDefaultExpression(expression: string): string {
  const value = expression.trim()
  let quoted = false
  let parentheses = 0
  let unsafe = !value || /\$|;|--|\/\*|\*\//.test(value)

  for (let index = 0; index < value.length && !unsafe; index++) {
    const character = value[index]

    if (character === "'") {
      const escaped: boolean = quoted && value[index + 1] === "'"
      index += escaped ? 1 : 0
      quoted = escaped ? quoted : !quoted
    } else if (!quoted && character === '(') {
      parentheses++
    } else if (!quoted && character === ')') {
      unsafe = parentheses === 0
      parentheses = Math.max(0, parentheses - 1)
    }
  }

  if (quoted || parentheses !== 0) unsafe = true

  if (unsafe) {
    throw new MigrationError({
      message: `Unsafe PostgreSQL database expression ${JSON.stringify(expression)}`,
    })
  }

  return value
}
