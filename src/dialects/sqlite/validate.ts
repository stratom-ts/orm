import { MigrationError } from '@/utils/error'

import { normalizeSqliteDefaultExpression } from './normalize'

/** Validates a SQLite declared type while preserving its authored spelling. */
export function assertSafeSqliteDataType(dataType: string): string {
  const value = dataType.trim()

  if (!value)
    throw new MigrationError({ message: 'column data type must be a non-empty string' })

  if (/[;"'\\]|--|\/\*|\*\//.test(value)) {
    throw new MigrationError({
      message: `unsafe SQLite column data type: ${JSON.stringify(dataType)}`,
    })
  }

  if (!/^[A-Za-z][A-Za-z0-9_ ]*(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?$/.test(value)) {
    throw new MigrationError({
      message: `unsupported SQLite column data type: ${JSON.stringify(dataType)}`,
    })
  }

  return value
}

/** Formats a tagged database literal for SQLite DDL. */
export function formatSqliteLiteral(value: string | number | boolean | null): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? '1' : '0'

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MigrationError({ message: 'column default number must be finite' })
    }

    return String(value)
  }

  return `'${value.replaceAll("'", "''")}'`
}

/** Verifies that a SQLite expression is a balanced, side-effect-free default. */
export function assertSafeSqliteDefaultExpression(expression: string): string {
  const value = expression.trim()
  let { unquoted, unsafe } = scanSqliteDefaultExpression(value)

  if (
    /\b(?:select|from|pragma|attach|detach|insert|update|delete|create|alter|drop|vacuum)\b/i.test(
      unquoted,
    )
  ) {
    unsafe = true
  }

  const postgresOnly =
    /^(?:now|clock_timestamp|gen_random_uuid|uuid_generate_v4|date_trunc)\s*\(/i

  if (postgresOnly.test(unquoted)) unsafe = true

  for (const match of unquoted.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const name = match[0].toLowerCase()

    if (!SQLITE_DEFAULT_EXPRESSION_NAMES.has(name)) {
      unsafe = true
      break
    }
  }

  if (unsafe) {
    throw new MigrationError({
      message: `Unsafe SQLite database expression ${JSON.stringify(expression)}`,
    })
  }

  return value
}

/**
 * Checks quoted text and parenthesis balance while collecting unquoted default-expression
 * tokens.
 *
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns Validated expression boundaries and supported literal or function tokens.
 */
function scanSqliteDefaultExpression(value: string) {
  let quoted = false
  let depth = 0
  let unquoted = ''
  let unsafe = !value || /;|--|\/\*|\*\/|\$|::/.test(value)

  for (let index = 0; index < value.length && !unsafe; index++) {
    const character = value[index]!

    if (character === "'") {
      const escaped: boolean = quoted && value[index + 1] === "'"
      index += escaped ? 1 : 0
      quoted = escaped ? quoted : !quoted
    } else if (!quoted && character === '(') {
      depth++
    } else if (!quoted && character === ')') {
      unsafe = depth === 0
      depth = Math.max(0, depth - 1)
    }

    unquoted += quoted ? ' ' : character
  }

  if (quoted || depth !== 0) unsafe = true

  return { unquoted, unsafe }
}

/** Wraps a SQLite expression in the form accepted by DEFAULT. */
export function formatSqliteDefaultExpression(expression: string): string {
  const value = assertSafeSqliteDefaultExpression(expression)

  if (/^current_(timestamp|date|time)$/i.test(value)) return value.toUpperCase()

  return `(${value})`
}

/** Normalizes a primitive default under SQLite's literal rules. */
export function normalizeSqliteDefaultValue(
  value: string | number | boolean | null,
): string {
  return normalizeSqliteDefaultExpression(formatSqliteLiteral(value))
}

const SQLITE_DEFAULT_EXPRESSION_NAMES = new Set([
  'abs',
  'as',
  'cast',
  'char',
  'coalesce',
  'current_date',
  'current_time',
  'current_timestamp',
  'date',
  'datetime',
  'format',
  'hex',
  'ifnull',
  'instr',
  'julianday',
  'length',
  'lower',
  'ltrim',
  'max',
  'min',
  'null',
  'nullif',
  'printf',
  'quote',
  'replace',
  'round',
  'rtrim',
  'sign',
  'strftime',
  'substr',
  'substring',
  'time',
  'trim',
  'true',
  'unicode',
  'unixepoch',
  'upper',
])
