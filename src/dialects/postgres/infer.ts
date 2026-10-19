import type { BaseIssue, ErrorMessage, Literal, LiteralSchema } from 'valibot'

import { analyzeSchema } from '@/schemas/utils/analyzeSchema'
import type { SchemaAnalysis } from '@/schemas/utils/analyzeSchema'
import type { NumberConstraints, StringConstraints } from '@/types/constraints'
import type { AnySchema } from '@/types/schema'
import { isNumber } from '@/utils'
import { SchemaError } from '@/utils/error'

import type { SqlDataType } from '../types'

const INT16_MIN = -32768
const INT16_MAX = 32767
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647

const JSON_SHAPED_SCHEMA_TYPES = new Set([
  'object',
  'loose_object',
  'strict_object',
  'object_with_rest',
  'record',
  'array',
  'tuple',
  'loose_tuple',
  'strict_tuple',
  'tuple_with_rest',
])

/**
 * Maps string length constraints to a PostgreSQL string type.
 *
 * @param constraints - Min/max length from the schema pipe.
 *
 * @returns `varchar(n)` for maxLength ≤ 255, `text` otherwise
 */
function inferPostgresStringType(constraints: StringConstraints): SqlDataType {
  if (constraints.maxLength === undefined) return 'text'
  if (constraints.maxLength <= 255) return `varchar(${constraints.maxLength})`

  return 'text'
}

/**
 * Maps number constraints to a PostgreSQL numeric type.
 *
 * @param constraints - Min/max value and integer flags.
 *
 * @returns `smallint`, `integer`, `bigint`, or `double precision`
 */
function inferPostgresNumberType(constraints: NumberConstraints): SqlDataType {
  if (!constraints.isInteger) return 'double precision'

  const { minValue: min, maxValue: max } = constraints

  if ((isNumber(min) && min < INT32_MIN) || (isNumber(max) && max > INT32_MAX)) {
    return 'bigint'
  }

  if (isNumber(min) && min >= INT16_MIN && isNumber(max) && max <= INT16_MAX) {
    return 'smallint'
  }

  return 'integer'
}

/**
 * Maps a Valibot literal value to a PostgreSQL column type.
 *
 * @param literal - Literal value from the schema.
 *
 * @returns Inferred column type for the literal
 */
function inferPostgresLiteralType(literal: Literal) {
  if (typeof literal === 'string') return 'text'

  if (typeof literal === 'number')
    return Number.isInteger(literal) ? 'integer' : 'double precision'

  if (typeof literal === 'boolean') return 'boolean'

  return 'text'
}

/**
 * Infers a PostgreSQL column type from a Valibot schema.
 *
 * @example
 *   inferPostgresColumnType(string()) // 'text'
 *   inferPostgresColumnType(pipe(string(), maxLength(50))) // 'varchar(50)'
 *   inferPostgresColumnType(optional(pipe(string(), maxLength(50)))) // 'varchar(50)'
 *   inferPostgresColumnType(number()) // 'double precision'
 *   inferPostgresColumnType(integer()) // 'integer'
 *
 * @param schema - Column schema (may be wrapped or piped)
 *
 * @returns PostgreSQL column data type
 *
 * @throws SchemaError when the schema type cannot be inferred
 */
export function inferPostgresColumnType(
  schema: AnySchema,
  analysis: SchemaAnalysis = analyzeSchema(schema),
): SqlDataType {
  const baseSchema = analysis.baseSchema

  switch (baseSchema.type) {
    case 'string': {
      return analysis.stringFormat === 'uuid'
        ? 'uuid'
        : inferPostgresStringType(analysis.stringConstraints)
    }
    case 'number': {
      return inferPostgresNumberType(analysis.numberConstraints)
    }
    case 'literal': {
      const literalSchema = baseSchema as LiteralSchema<
        Literal,
        ErrorMessage<BaseIssue<unknown>>
      >

      return inferPostgresLiteralType(literalSchema.literal)
    }
    case 'date':
      return 'timestamptz'
    case 'enum':
    case 'picklist':
      return 'text'
    case 'bigint':
      return 'bigint'
    case 'boolean':
      return 'boolean'
    default:
      if (JSON_SHAPED_SCHEMA_TYPES.has(baseSchema.type)) return 'jsonb'

      throw new SchemaError({
        message: `cannot infer a SQL column type for a "${baseSchema.type}" schema; specify it explicitly with column({ physicalType: { postgresql: ... } })`,
      })
  }
}
