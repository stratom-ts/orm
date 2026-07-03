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

function inferPostgresLiteralType(literal: Literal) {
  if (typeof literal === 'string') return 'text'
  if (typeof literal === 'number')
    return Number.isInteger(literal) ? 'integer' : 'real'
  if (typeof literal === 'boolean') return 'boolean'
  return 'text'
}

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

export const postgresAdapter: DialectAdapter = {
  inferColumnType(schema) {
    return inferPostgresColumnType(schema)
  },
  normalizeDataType(dataType) {
    return normalizePostgresDataType(dataType)
  },
}
