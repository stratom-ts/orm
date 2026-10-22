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
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

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
  const inferred = inferEffectivePostgresType(analysis)

  if (inferred) return inferred

  const baseSchema = analysis.outputSchema ?? analysis.baseSchema
  const detail = analysis.unresolvedTransformation
    ? 'an unresolved transformation'
    : `a "${baseSchema.type}" schema`

  throw new SchemaError({
    message: `cannot infer a SQL column type for ${detail}; specify it explicitly with column({ physicalType: { postgresql: ... } })`,
  })
}

function inferEffectivePostgresType(analysis: SchemaAnalysis): SqlDataType | undefined {
  const schema = analysis.outputSchema

  if (schema?.type === 'literal')
    return inferPostgresLiteralType(
      (schema as LiteralSchema<Literal, ErrorMessage<BaseIssue<unknown>>>).literal,
    )

  if (schema?.type === 'enum' || schema?.type === 'picklist') return 'text'

  switch (analysis.outputKind) {
    case 'string':
      return analysis.stringFormat === 'uuid'
        ? 'uuid'
        : inferPostgresStringType(analysis.stringConstraints)
    case 'number': {
      return inferPostgresNumberOutputType(analysis.numberConstraints)
    }
    case 'bigint': {
      const { minValue, maxValue } = analysis.bigintConstraints
      return minValue !== undefined &&
        maxValue !== undefined &&
        minValue >= INT64_MIN &&
        maxValue <= INT64_MAX
        ? 'bigint'
        : 'numeric'
    }
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'timestamptz'
    case 'json':
      return 'jsonb'
    case undefined:
      return undefined
  }
}

function inferPostgresNumberOutputType(constraints: NumberConstraints): SqlDataType {
  if (
    constraints.isSafeInteger &&
    (constraints.minValue === undefined || constraints.maxValue === undefined)
  )
    return 'bigint'

  return inferPostgresNumberType(constraints)
}
