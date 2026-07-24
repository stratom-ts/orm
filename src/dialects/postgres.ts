import {
  getBaseSchema,
  getNumberConstraints,
  getStringConstraints,
} from '@/schemas'
import type { NumberConstraints, StringConstraints } from '@/types/constraints'
import { isNumber } from '@/utils'
import type { ColumnDataType } from 'kysely'
import type {
  BaseIssue,
  BaseSchema,
  ErrorMessage,
  Literal,
  LiteralSchema,
} from 'valibot'
import type { DialectAdapter } from './types'

/**
 * Maps string length constraints to a PostgreSQL string type.
 *
 * @param constraints - min/max length from the schema pipe
 * @returns `char(n)`, `varchar(n)`, or `text`
 */
function inferPostgresStringType(
  constraints: StringConstraints,
): ColumnDataType {
  if (constraints.maxLength === undefined) return 'text'
  if (
    constraints.maxLength <= 255 &&
    constraints.minLength === constraints.maxLength
  )
    return `char(${constraints.maxLength})`
  if (constraints.maxLength <= 255) return `varchar(${constraints.maxLength})`
  return 'text'
}

/**
 * Maps number constraints to a PostgreSQL numeric type.
 *
 * @param constraints - min/max value and integer flags
 * @returns `smallint`, `integer`, `bigint`, or `real`
 */
function inferPostgresNumberType(constraints: NumberConstraints) {
  if (
    isNumber(constraints.minValue) &&
    constraints.minValue >= -32768 &&
    isNumber(constraints.maxValue) &&
    constraints.maxValue <= 32767
  )
    return 'smallint'
  if (
    isNumber(constraints.minValue) &&
    constraints.minValue >= -2147483648 &&
    isNumber(constraints.maxValue) &&
    constraints.maxValue <= 2147483647
  )
    return 'integer'
  if (constraints.isInteger) return 'bigint'
  return 'real'
}

/**
 * Maps a Valibot literal value to a PostgreSQL column type.
 *
 * @param literal - Literal value from the schema
 * @returns Inferred column type for the literal
 */
function inferPostgresLiteralType(literal: Literal) {
  if (typeof literal === 'string') return 'text'
  if (typeof literal === 'number')
    return Number.isInteger(literal) ? 'integer' : 'real'
  if (typeof literal === 'boolean') return 'boolean'
  return 'text'
}

/**
 * Infers a PostgreSQL column type from a Valibot schema.
 *
 * @param schema - Column schema (may be wrapped or piped)
 * @returns PostgreSQL column data type
 *
 * @example
 * ```ts
 * inferPostgresColumnType(string()) // 'text'
 * inferPostgresColumnType(pipe(string(), maxLength(50))) // 'varchar(50)'
 * ```
 */
export function inferPostgresColumnType(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): ColumnDataType {
  const baseSchema = getBaseSchema(schema)
  switch (baseSchema.type) {
    case 'string': {
      const constraints = getStringConstraints(schema)
      return inferPostgresStringType(constraints)
    }
    case 'number': {
      const constraints = getNumberConstraints(schema)
      return inferPostgresNumberType(constraints)
    }
    case 'literal': {
      const literalSchema = baseSchema as LiteralSchema<
        Literal,
        ErrorMessage<BaseIssue<unknown>>
      >
      return inferPostgresLiteralType(literalSchema.literal)
    }
    case 'date':
      return 'timestamp'
    case 'enum':
    case 'picklist':
      return 'varchar(255)'
    case 'bigint':
    case 'boolean':
    case 'uuid':
      return baseSchema.type
    default:
      return 'text'
  }
}

/**
 * Normalizes PostgreSQL type names and aliases for comparison.
 *
 * @param dataType - Raw type string (e.g. `int4`, `character varying`)
 * @returns Canonical type (e.g. `integer`, `varchar`)
 */
function normalizePostgresDataType(dataType: string): string {
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
    float8: 'real',
    float4: 'real',
    real: 'real',
    doubleprecision: 'real',
    timestamptz: 'timestamptz',
    timestamp: 'timestamp',
    timestampwithouttimezone: 'timestamp',
    timestampwithtimezone: 'timestamptz',
    char: 'char',
    character: 'char',
    'character varying': 'varchar',
    varchar: 'varchar',
    text: 'text',
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
 * PostgreSQL dialect adapter for type inference and normalization.
 *
 * @example
 * ```ts
 * await runMigrations(db, schemas, postgresAdapter)
 * ```
 */
export const postgresAdapter: DialectAdapter = {
  inferColumnType(schema) {
    return inferPostgresColumnType(schema)
  },
  normalizeDataType(dataType) {
    return normalizePostgresDataType(dataType)
  },
}
