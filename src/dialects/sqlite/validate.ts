import { MigrationError } from '@/utils/error'

import {
  isSqliteDefaultExpression,
  isSqliteDefaultLiteral,
  trimSqliteWhitespace,
} from './defaults'
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

  if (
    /\b(?:CONSTRAINT|PRIMARY\s+KEY|NOT\s+NULL|NULL|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|AS|AUTOINCREMENT)\b/i.test(
      value,
    )
  ) {
    throw new MigrationError({
      message: `SQLite column data type contains constraint syntax: ${JSON.stringify(dataType)}`,
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

/** Validates supported literals separately from constant-expression syntax and calls. */
export function assertSafeSqliteDefaultExpression(expression: string): string {
  const value = trimSqliteWhitespace(expression)

  if (!isSqliteDefaultLiteral(value) && !isSqliteDefaultExpression(value)) {
    throw new MigrationError({
      message: `Unsafe SQLite database expression ${JSON.stringify(expression)}`,
    })
  }

  return value
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
