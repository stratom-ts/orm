import { MigrationError } from '@/utils/error'

import {
  isSqliteDefaultExpression,
  isSqliteDefaultLiteral,
  trimSqliteWhitespace,
} from './defaultExpression'

/** Known SQLite validation rejection consumed by migration lowering. */
export class SqliteValidationError extends MigrationError {}

/** Detects tokens that SQLite cannot accept as a declared type identifier. */
function containsReservedTypeWord(value: string): boolean {
  return /\b(?:ADD|ALL|ALTER|AND|BETWEEN|CASE|COMMIT|CREATE|CROSS|DELETE|DISTINCT|DROP|ELSE|ESCAPE|EXCEPT|EXISTS|FROM|FULL|GROUP|HAVING|IN|INDEX|INDEXED|INNER|INSERT|INTERSECT|INTO|IS|ISNULL|JOIN|LEFT|LIMIT|NATURAL|NOTHING|NOTNULL|OR|ORDER|OUTER|RETURNING|RIGHT|SELECT|SET|TABLE|THEN|TO|TRANSACTION|UNION|UPDATE|USING|VALUES|WHEN|WHERE)\b/i.test(
    value,
  )
}

/** Validates a SQLite declared type while preserving its authored spelling. */
export function assertSafeSqliteDataType(dataType: string): string {
  const value = trimSqliteWhitespace(dataType)

  if (!value)
    throw new SqliteValidationError({
      message: 'column data type must be a non-empty string',
    })

  if (/[;"'\\]|--|\/\*|\*\//.test(value)) {
    throw new SqliteValidationError({
      message: `unsafe SQLite column data type: ${JSON.stringify(dataType)}`,
    })
  }

  if (
    !/^[A-Za-z][A-Za-z0-9_]*(?:[ \t\r\n\f]+[A-Za-z_][A-Za-z0-9_]*)*(?:[ \t\r\n\f]*\([ \t\r\n\f]*\d+(?:[ \t\r\n\f]*,[ \t\r\n\f]*\d+)?[ \t\r\n\f]*\))?$/.test(
      value,
    )
  ) {
    throw new SqliteValidationError({
      message: `unsupported SQLite column data type: ${JSON.stringify(dataType)}`,
    })
  }

  if (
    /\b(?:CONSTRAINT|PRIMARY|NOT|FOREIGN|NULL|UNIQUE|CHECK|DEFAULT|COLLATE|REFERENCES|AS|AUTOINCREMENT|ON|DEFERRABLE)\b/i.test(
      value,
    )
  ) {
    throw new SqliteValidationError({
      message: `SQLite column data type contains constraint syntax: ${JSON.stringify(dataType)}`,
    })
  }

  // SQLite build.c strips ALWAYS at 16 bytes; this grammar is ASCII, so JS length matches.
  if (value.length >= 16 && /ALWAYS$/i.test(value)) {
    const generatedConstraint = /\bGENERATED[ \t\r\n\f]+ALWAYS$/i.test(value)
    const reason = generatedConstraint
      ? 'SQLite column data type contains constraint syntax'
      : 'unsupported SQLite column data type'

    throw new SqliteValidationError({
      message: `${reason}: ${JSON.stringify(dataType)}`,
    })
  }

  // SQLite's typename accepts ids, including only its parser's ID-fallback keywords.
  // These reserved tokens cannot occur in a declared type without changing the grammar.
  if (containsReservedTypeWord(value)) {
    throw new SqliteValidationError({
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
      throw new SqliteValidationError({ message: 'column default number must be finite' })
    }

    return String(value)
  }

  return `'${value.replaceAll("'", "''")}'`
}

/** Validates supported literals separately from constant-expression syntax and calls. */
export function assertSafeSqliteDefaultExpression(expression: string): string {
  const value = trimSqliteWhitespace(expression)

  if (!isSqliteDefaultLiteral(value) && !isSqliteDefaultExpression(value)) {
    throw new SqliteValidationError({
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
