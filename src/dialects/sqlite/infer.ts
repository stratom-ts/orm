import type { BaseIssue, ErrorMessage, Literal, LiteralSchema } from 'valibot'

import { analyzeSchema } from '@/schemas/utils/analyzeSchema'
import type { SchemaAnalysis } from '@/schemas/utils/analyzeSchema'
import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

import type { SqlDataType } from '../types'

import { isSqliteSupportedBigInt, isSqliteSupportedNumber } from './numeric'

/** Throws the contract required when a choice schema has no safe default mapping. */
function unsupportedChoiceType(type: string): never {
  throw new SchemaError({
    message: `cannot infer a SQLite column type for a mixed or unsupported ${type} output; specify column({ physicalType: { sqlite: ... } }) and explicit parameter and result mappings`,
  })
}

/** Infers storage for enum and picklist values from their validated output options. */
export function inferSqliteChoiceType(analysis: SchemaAnalysis): SqlDataType {
  const schema = (analysis.outputSchema ??
    analysis.baseSchema) as typeof analysis.baseSchema & {
    options?: unknown[]
  }

  const options = schema.options
  const kind = analysis.outputKind

  if (!options?.length || !kind) return unsupportedChoiceType(schema.type)

  if (kind === 'string') return 'TEXT'

  if (kind === 'number') {
    const numbers = options as number[]

    if (numbers.some((value) => !isSqliteSupportedNumber(value))) {
      return unsupportedChoiceType(schema.type)
    }

    return numbers.every(Number.isInteger) ? 'INTEGER' : 'REAL'
  }

  if (kind === 'bigint') {
    if ((options as bigint[]).some((value) => !isSqliteSupportedBigInt(value))) {
      return unsupportedChoiceType(schema.type)
    }

    return 'BIGINT'
  }

  if (kind === 'boolean') return 'BOOLEAN'

  return unsupportedChoiceType(schema.type)
}

/**
 * Maps supported literal values to SQLite logical storage types.
 *
 * @param literal - Literal schema value used to infer physical storage.
 *
 * @returns The SQLite storage type supported by the literal value.
 */
function inferSqliteLiteralType(literal: unknown): SqlDataType {
  if (typeof literal === 'string') return 'TEXT'

  if (typeof literal === 'number') {
    if (!isSqliteSupportedNumber(literal)) {
      throw new SchemaError({
        message:
          'cannot infer a SQLite column type for a non-finite or unsafe integer literal',
      })
    }

    return Number.isInteger(literal) ? 'INTEGER' : 'REAL'
  }

  if (typeof literal === 'bigint') {
    if (!isSqliteSupportedBigInt(literal)) {
      throw new SchemaError({
        message:
          'cannot infer a SQLite column type for a bigint literal outside the signed 64-bit integer range',
      })
    }

    return 'BIGINT'
  }

  if (typeof literal === 'boolean') return 'BOOLEAN'
  if (literal === null) return 'NULL'

  throw new SchemaError({ message: 'cannot infer a SQLite column type for this literal' })
}

/** Infers a SQLite declared type while retaining useful logical type spellings. */
export function inferSqliteColumnType(
  schema: AnySchema,
  analysis: SchemaAnalysis = analyzeSchema(schema),
): SqlDataType {
  const inferred = inferEffectiveSqliteType(analysis)

  if (inferred) return inferred

  const effectiveSchema = analysis.outputSchema ?? analysis.baseSchema
  const detail = analysis.unresolvedTransformation
    ? 'an unresolved transformation'
    : `a "${effectiveSchema.type}" schema`

  throw new SchemaError({
    message: `cannot infer a SQLite column type for ${detail}; specify it explicitly with column({ physicalType: { sqlite: ... } })`,
  })
}

function inferEffectiveSqliteType(analysis: SchemaAnalysis): SqlDataType | undefined {
  const effectiveSchema = analysis.outputSchema

  if (effectiveSchema?.type === 'literal')
    return inferSqliteLiteralType(
      (effectiveSchema as LiteralSchema<Literal, ErrorMessage<BaseIssue<unknown>>>)
        .literal,
    )

  if (effectiveSchema?.type === 'enum' || effectiveSchema?.type === 'picklist')
    return inferSqliteChoiceType(analysis)

  switch (analysis.outputKind) {
    case 'string':
      return 'TEXT'
    case 'number': {
      const { minValue, maxValue, isInteger, isSafeInteger } = analysis.numberConstraints

      if (isSafeInteger || isInteger) return 'INTEGER'

      if (
        (minValue !== undefined && !Number.isFinite(minValue)) ||
        (maxValue !== undefined && !Number.isFinite(maxValue))
      )
        throw new SchemaError({
          message: 'cannot infer a SQLite column type for non-finite number bounds',
        })

      return 'REAL'
    }
    case 'bigint':
      return 'BIGINT'
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'DATETIME'
    case 'json':
      return 'JSON'
    case undefined:
      return undefined
  }
}
