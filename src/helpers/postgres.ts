import type { ColumnDataType } from 'kysely'
import type {
  BaseIssue,
  BaseSchema,
  ErrorMessage,
  Literal,
  LiteralSchema,
} from 'valibot'
import {
  getBaseSchema,
  getNumberConstraints,
  getStringConstraints,
} from '@/schemas'
import { isNumber } from '@/utils'
import type { NumberConstraints, StringConstraints } from '@/types/constraints'

/**
 * Infers the appropriate PostgreSQL column type for string constraints.
 *
 * Maps string constraints to PostgreSQL types:
 * - char(n): Fixed length strings (maxLength ≤ 255 and minLength === maxLength)
 * - varchar(n): Variable length strings (maxLength ≤ 255)
 * - text: Unbounded or large strings
 *
 * @param constraints - The string constraints to base the type on
 * @returns The PostgreSQL column data type
 * @example
 * ```ts
 * // No maxLength - returns text
 * inferPostgresStringType({})
 * // Returns: 'text'
 *
 * // maxLength <= 255 - returns varchar
 * inferPostgresStringType({ maxLength: 100 })
 * // Returns: 'varchar(100)'
 *
 * // Fixed length - both minLength & maxLength - returns char
 * inferPostgresStringType({ minLength: 5, maxLength: 5 })
 * // Returns: 'char(5)'
 *
 * // maxLength > 255 - returns text
 * inferPostgresStringType({ maxLength: 500 })
 * // Returns: 'text'
 * ```
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
 * Infers the appropriate PostgreSQL column type for number constraints.
 *
 * Maps number constraints to PostgreSQL numeric types based on value ranges:
 * - smallint: -32768 to 32767
 * - integer: -2147483648 to 2147483647
 * - bigint: Integer values outside above ranges
 * - real: Floating point numbers
 *
 * @param constraints - The number constraints to base the type on
 * @returns The PostgreSQL column data type
 * @example
 * ```ts
 * // Small integer range - returns smallint
 * inferPostgresNumberType({ minValue: 0, maxValue: 100 })
 * // Returns: 'smallint'
 *
 * // Standard integer range - returns integer
 * inferPostgresNumberType({ minValue: -1000000, maxValue: 1000000 })
 * // Returns: 'integer'
 *
 * // Integer outside range - returns bigint
 * inferPostgresNumberType({ isInteger: true, minValue: -10000000000, maxValue: 10000000000 })
 * // Returns: 'bigint'
 *
 * // Floating point - returns real
 * inferPostgresNumberType({})
 * // Returns: 'real'
 * ```
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
 * Infers the appropriate PostgreSQL column type for literal values.
 * @param literal - The literal value to infer the type from
 * @returns The PostgreSQL column data type
 * @example
 * ```ts
 * // String literal - returns text
 * inferPostgresLiteralType('active')
 * // Returns: 'text'
 *
 * // Integer literal - returns integer
 * inferPostgresLiteralType(42)
 * // Returns: 'integer'
 *
 * // Float literal - returns real
 * inferPostgresLiteralType(3.14)
 * // Returns: 'real'
 *
 * // Boolean literal - returns boolean
 * inferPostgresLiteralType(true)
 * // Returns: 'boolean'
 * ```
 */
function inferPostgresLiteralType(literal: Literal) {
  if (typeof literal === 'string') return 'text'
  if (typeof literal === 'number')
    return Number.isInteger(literal) ? 'integer' : 'real'
  if (typeof literal === 'boolean') return 'boolean'
  return 'text'
}

/**
 * Infers the appropriate PostgreSQL column type for any schema.
 *
 * This is the main type inference method that dispatches to specialized
 * methods based on the schema type.
 *
 * @param schema - The schema to infer the type from
 * @returns The PostgreSQL column data type
 * @example
 * ```ts
 * import { string, number, boolean } from 'valibot'
 *
 * const stringType = inferPostgresType(string())
 * // Returns: 'text'
 *
 * const varcharType = inferPostgresType(string([maxLength(100)]))
 * // Returns: 'varchar(100)'
 *
 * const intType = inferPostgresType(number())
 * // Returns: 'real'
 *
 * const boolType = inferPostgresType(boolean())
 * // Returns: 'boolean'
 * ```
 */
export function inferPostgresType(
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
