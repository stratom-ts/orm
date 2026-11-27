import { QueryError } from '@/utils/error'

import {
  expressionBigint,
  expressionCount,
  expressionDate,
  expressionDateParam,
  expressionFloat,
  expressionInteger,
  expressionResult,
  expressionString,
} from '../expressionMapping'
import type {
  DialectExpressionKind,
  DialectExpressionOperand,
  DialectExpressionResult,
} from '../types'

import { mapPostgresResultValue } from './mapping'
import { extractPostgresBaseType } from './normalize'

const INTEGER = ['smallint', 'integer', 'bigint', 'smallserial', 'serial', 'bigserial']
const FLOAT = ['real', 'double precision']
const TEXT = ['text', 'varchar', 'character varying', 'character', 'char']
const DATE = [
  'date',
  'timestamp',
  'timestamp without time zone',
  'timestamptz',
  'timestamp with time zone',
]

/**
 * SQL families used for capability checks and comparison, rather than JavaScript types
 * alone.
 */
function storage(dataType: string) {
  const type = extractPostgresBaseType(dataType)

  const family = INTEGER.includes(type)
    ? 'integer'
    : FLOAT.includes(type)
      ? 'float'
      : TEXT.includes(type)
        ? 'text'
        : DATE.includes(type)
          ? 'date'
          : type

  return { type, family }
}

function sumResult(operand: DialectExpressionOperand): DialectExpressionResult {
  const { type, family } = storage(operand.dataType)

  if (operand.outputKind === 'number') {
    // PostgreSQL widens integer sums to numeric. Retain that proof through CTE outputs.
    if (
      family === 'integer' ||
      (family === 'numeric' && operand.encoding === 'safe-integer')
    )
      return {
        ...expressionResult(
          type === 'bigint' || type === 'bigserial' || family === 'numeric'
            ? 'numeric'
            : 'bigint',
          'number',
          expressionInteger,
        ),
        encoding: 'safe-integer',
      }

    if (family === 'float') return expressionResult(type, 'number', expressionFloat)
  }

  if (
    operand.outputKind === 'bigint' &&
    ['integer', 'numeric', 'decimal'].includes(family)
  )
    return expressionResult('numeric', 'bigint', expressionBigint, (value) =>
      expressionBigint(value).toString(),
    )

  throw new QueryError({
    message: 'sum does not support the selected PostgreSQL operand storage',
  })
}

function dateResult(dataType: string): DialectExpressionResult {
  return expressionResult(
    dataType,
    'date',
    (value) => expressionDate(mapPostgresResultValue(dataType, value)),
    expressionDateParam,
  )
}

/** Resolves PostgreSQL helper output storage before any parameter or result hook runs. */
export function postgresExpressionResult(
  kind: DialectExpressionKind,
  operand?: DialectExpressionOperand,
): DialectExpressionResult {
  if (kind === 'count' || kind === 'count_all')
    return expressionResult('bigint', 'number', expressionCount, expressionInteger)

  if (kind === 'now') return dateResult('timestamptz')

  if (!operand)
    throw new QueryError({ message: `${kind} requires a known operand result contract` })

  const { type, family } = storage(operand.dataType)

  if (kind === 'min' || kind === 'max') {
    if (['integer', 'float', 'text', 'date', 'numeric', 'decimal'].includes(family))
      return expressionResult(operand.dataType, operand.outputKind, (value) => value)

    throw new QueryError({
      message: `${kind} does not support the selected PostgreSQL operand storage`,
    })
  }

  if (!operand.standard)
    throw new QueryError({
      message: `${kind} requires supported native storage and standard mappings`,
    })

  if (kind === 'sum') return sumResult(operand)

  if (operand.outputKind === 'string' && family === 'text') {
    if (kind === 'lower' || kind === 'upper')
      return expressionResult('text', 'string', expressionString)

    if (kind === 'length')
      return expressionResult('integer', 'number', expressionCount, expressionInteger)
  }

  if (kind === 'date_trunc' && operand.outputKind === 'date' && family === 'date')
    return dateResult(type === 'date' ? 'timestamptz' : type)

  throw new QueryError({
    message: `${kind} does not support the selected PostgreSQL operand storage`,
  })
}

/** PostgreSQL permits numeric widening and temporal comparisons without a shared decoder. */
export function postgresExpressionComparable(
  left: DialectExpressionOperand,
  right: DialectExpressionOperand,
): boolean {
  const family = (type: string) => {
    const resolved = storage(type).family
    return ['integer', 'float', 'numeric', 'decimal'].includes(resolved)
      ? 'numeric'
      : resolved
  }

  return (
    left.outputKind !== undefined &&
    left.outputKind === right.outputKind &&
    family(left.dataType) === family(right.dataType)
  )
}
