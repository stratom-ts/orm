import type { BaseIssue, ErrorMessage, Literal, LiteralSchema } from 'valibot'

import { analyzeSchema } from '@/schemas/utils/analyzeSchema'
import type { SchemaAnalysis } from '@/schemas/utils/analyzeSchema'
import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

import type { SqlDataType } from '../types'

const SQLITE_INTEGER_MIN = -9223372036854775808n
const SQLITE_INTEGER_MAX = 9223372036854775807n

/** Throws the contract required when a choice schema has no safe default mapping. */
function unsupportedChoiceType(type: string): never {
  throw new SchemaError({
    message: `cannot infer a SQLite column type for a mixed or unsupported ${type} output; specify column({ physicalType: { sqlite: ... } }) and explicit parameter and result mappings`,
  })
}

/** Infers storage for enum and picklist values from their validated output options. */
export function inferSqliteChoiceType(analysis: SchemaAnalysis): SqlDataType {
  const schema = analysis.baseSchema as typeof analysis.baseSchema & {
    options?: unknown[]
  }

  const options = schema.options
  const kind = analysis.outputKind

  if (!options?.length || !kind) return unsupportedChoiceType(schema.type)

  if (kind === 'string') return 'TEXT'

  if (kind === 'number') {
    const numbers = options as number[]

    if (numbers.some((value) => !Number.isFinite(value))) {
      return unsupportedChoiceType(schema.type)
    }

    if (
      numbers.some((value) => Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      return unsupportedChoiceType(schema.type)
    }

    return numbers.every(Number.isInteger) ? 'INTEGER' : 'REAL'
  }

  if (kind === 'bigint') {
    if (
      (options as bigint[]).some(
        (value) => value < SQLITE_INTEGER_MIN || value > SQLITE_INTEGER_MAX,
      )
    ) {
      return unsupportedChoiceType(schema.type)
    }

    return 'BIGINT'
  }

  if (kind === 'boolean') return 'BOOLEAN'

  return unsupportedChoiceType(schema.type)
}

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
 * Maps supported literal values to SQLite logical storage types.
 *
 * @param literal - Literal schema value used to infer physical storage.
 *
 * @returns The SQLite storage type supported by the literal value.
 */
function inferSqliteLiteralType(literal: unknown): SqlDataType {
  if (typeof literal === 'string') return 'TEXT'
  if (typeof literal === 'number') return Number.isInteger(literal) ? 'INTEGER' : 'REAL'
  if (typeof literal === 'bigint') return 'BIGINT'
  if (typeof literal === 'boolean') return 'BOOLEAN'
  if (literal === null) return 'NULL'

  throw new SchemaError({ message: 'cannot infer a SQLite column type for this literal' })
}

/** Infers a SQLite declared type while retaining useful logical type spellings. */
export function inferSqliteColumnType(
  schema: AnySchema,
  analysis: SchemaAnalysis = analyzeSchema(schema),
): SqlDataType {
  const baseSchema = analysis.baseSchema

  switch (baseSchema.type) {
    case 'string':
      return 'TEXT'
    case 'enum':
    case 'picklist':
      return inferSqliteChoiceType(analysis)
    case 'number':
      return analysis.numberConstraints.isInteger ? 'INTEGER' : 'REAL'
    case 'literal': {
      const literalSchema = baseSchema as LiteralSchema<
        Literal,
        ErrorMessage<BaseIssue<unknown>>
      >

      return inferSqliteLiteralType(literalSchema.literal)
    }
    case 'bigint':
      return 'BIGINT'
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'DATETIME'
    default:
      if (JSON_SHAPED_SCHEMA_TYPES.has(baseSchema.type)) return 'JSON'

      throw new SchemaError({
        message: `cannot infer a SQLite column type for a "${baseSchema.type}" schema; specify it explicitly with column({ physicalType: { sqlite: ... } })`,
      })
  }
}
