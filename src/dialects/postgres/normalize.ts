import { formatPostgresDefault } from './validate'

/**
 * Normalizes PostgreSQL type names and aliases for comparison.
 *
 * @example
 *   normalizePostgresDataType('int4') // 'integer'
 *   normalizePostgresDataType('character varying') // 'varchar'
 *   normalizePostgresDataType('varchar(255)') // 'varchar(255)'
 *
 * @param dataType - Raw type string (e.g. `int4`, `character varying`)
 *
 * @returns Canonical type (e.g. `integer`, `varchar`)
 */
export function normalizePostgresDataType(dataType: string): string {
  const normalized = dataType.toLowerCase().trim()
  const typeMappings: Record<string, string> = {
    bool: 'boolean',
    boolean: 'boolean',
    int4: 'integer',
    integer: 'integer',
    int2: 'smallint',
    smallint: 'smallint',
    int8: 'bigint',
    bigint: 'bigint',
    float8: 'double precision',
    float4: 'real',
    real: 'real',
    doubleprecision: 'double precision',
    'double precision': 'double precision',
    timestamptz: 'timestamptz',
    timestamp: 'timestamp',
    timestampwithouttimezone: 'timestamp',
    timestampwithtimezone: 'timestamptz',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamptz',
    char: 'char',
    character: 'char',
    'character varying': 'varchar',
    varchar: 'varchar',
    text: 'text',
    uuid: 'uuid',
    json: 'json',
    jsonb: 'jsonb',
  }

  const withoutLength = normalized.replace(/\(\d+\)/, '').trim()
  const lengthMatch = normalized.match(/\((\d+)\)/)

  if (typeMappings[withoutLength]) {
    return lengthMatch
      ? `${typeMappings[withoutLength]}(${lengthMatch[1]})`
      : typeMappings[withoutLength]
  }

  return normalized
}

/**
 * Extracts the base PostgreSQL type without length/precision suffix.
 *
 * @example
 *   extractPostgresBaseType('varchar(255)') // 'varchar'
 *   extractPostgresBaseType('numeric(10,2)') // 'numeric'
 *   extractPostgresBaseType('text') // 'text'
 *
 * @param dataType - SQL data type string (e.g. `varchar(255)`, `numeric(10,2)`)
 *
 * @returns Base type name (e.g. `varchar`, `numeric`)
 */
export function extractPostgresBaseType(dataType: string): string {
  return normalizePostgresDataType(dataType).replace(/\(.*\)$/, '')
}

/** Formats and normalizes a primitive PostgreSQL column default for comparison. */
export function normalizePostgresDefaultValue(
  value: string | number | boolean | null,
): string {
  return normalizePostgresDefaultExpression(formatPostgresDefault(value))
}

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

function stripAllEnclosingParens(expression: string): string {
  let normalized = expression
  let previous: string
  do {
    previous = normalized
    normalized = stripEnclosingParens(normalized)
  } while (normalized !== previous)

  return normalized
}

/** Canonicalizes PostgreSQL default expressions for migration comparison. */
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
