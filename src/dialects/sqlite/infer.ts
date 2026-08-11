import type { BaseIssue, ErrorMessage, Literal, LiteralSchema } from 'valibot'

import { getBaseSchema } from '@/schemas/utils/getBaseSchema'
import { getNumberConstraints } from '@/schemas/utils/getNumberConstraints'
import { unwrapDeep } from '@/schemas/utils/unwrapDeep'
import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

const JSON_TYPES = new Set([
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

export function inferSqliteColumnType(schema: AnySchema): string {
  const base = getBaseSchema(schema)
  const unwrapped = unwrapDeep(schema)
  switch (base.type) {
    case 'string':
    case 'date':
    case 'enum':
    case 'picklist':
      return 'TEXT'
    case 'number':
      return getNumberConstraints(unwrapped).isInteger ? 'INTEGER' : 'REAL'
    case 'integer':
      return 'INTEGER'
    case 'bigint':
    case 'boolean':
      return 'INTEGER'
    case 'literal': {
      const literal = (base as LiteralSchema<Literal, ErrorMessage<BaseIssue<unknown>>>)
        .literal
      if (typeof literal === 'number')
        return Number.isInteger(literal) ? 'INTEGER' : 'REAL'
      if (typeof literal === 'boolean') return 'INTEGER'
      return 'TEXT'
    }
    case 'blob':
    case 'bytes':
      return 'BLOB'
    default:
      if (JSON_TYPES.has(base.type)) return 'TEXT'
      throw new SchemaError({
        message: `cannot infer a SQLite column type for a "${base.type}" schema; specify it explicitly with column({ physicalType: { sqlite: ... } })`,
      })
  }
}
