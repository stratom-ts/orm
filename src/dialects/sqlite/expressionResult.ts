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

const INTEGER = ['INTEGER', 'BIGINT']
const FLOAT = ['REAL', 'FLOAT', 'DOUBLE']
const TEXT = ['TEXT', 'VARCHAR']

function storage(dataType: string) {
  return dataType
    .trim()
    .toUpperCase()
    .replace(/\(.*\)/, '')
}

function sumResult(operand: DialectExpressionOperand): DialectExpressionResult {
  const type = storage(operand.dataType)

  if (operand.outputKind === 'number') {
    if (INTEGER.includes(type))
      return expressionResult('INTEGER', 'number', expressionInteger)

    if (FLOAT.includes(type)) return expressionResult('REAL', 'number', expressionFloat)
  }

  if (operand.outputKind === 'bigint' && INTEGER.includes(type))
    return expressionResult('BIGINT', 'bigint', expressionBigint)

  throw new QueryError({
    message: 'sum does not support the selected SQLite operand storage',
  })
}

/** Resolves the shared SQLite helper subset without assuming PostgreSQL representations. */
export function sqliteExpressionResult(
  kind: DialectExpressionKind,
  operand?: DialectExpressionOperand,
): DialectExpressionResult {
  if (kind === 'count' || kind === 'count_all')
    return expressionResult('INTEGER', 'number', expressionCount, expressionInteger)

  if (kind === 'now')
    return {
      ...expressionResult('TEXT', 'date', expressionDate, (value) =>
        expressionDateParam(value)
          .replace('T', ' ')
          .replace(/\.000Z$/, '')
          .replace(/Z$/, ''),
      ),
      encoding: 'utc-seconds',
    }

  if (kind === 'date_trunc')
    throw new QueryError({ message: 'SQLite 3.37 does not support date_trunc' })

  if (!operand)
    throw new QueryError({ message: `${kind} requires a known operand result contract` })

  const type = storage(operand.dataType)

  if (kind === 'min' || kind === 'max') {
    if ([...INTEGER, ...FLOAT, ...TEXT, 'DATE', 'DATETIME'].includes(type))
      return expressionResult(operand.dataType, operand.outputKind, (value) => value)

    throw new QueryError({
      message: `${kind} does not support the selected SQLite operand storage`,
    })
  }

  if (!operand.standard)
    throw new QueryError({
      message: `${kind} requires supported native storage and standard mappings`,
    })

  if (kind === 'sum') return sumResult(operand)

  if (operand.outputKind === 'string' && TEXT.includes(type)) {
    if (kind === 'lower' || kind === 'upper')
      return expressionResult('TEXT', 'string', expressionString)

    return expressionResult('INTEGER', 'number', expressionCount, expressionInteger)
  }

  throw new QueryError({
    message: `${kind} does not support the selected SQLite operand storage`,
  })
}

/**
 * SQLite comparisons retain native encoding, including the special CURRENT_TIMESTAMP
 * spelling.
 */
export function sqliteExpressionComparable(
  left: DialectExpressionOperand,
  right: DialectExpressionOperand,
): boolean {
  const family = (operand: DialectExpressionOperand) => {
    if (operand.encoding) return operand.encoding

    const type = storage(operand.dataType)

    if ([...INTEGER, ...FLOAT].includes(type)) return 'numeric'
    if (TEXT.includes(type)) return 'text'
    if (['DATE', 'DATETIME'].includes(type)) return 'iso-date'

    return undefined
  }

  return (
    left.standard &&
    right.standard &&
    left.outputKind !== undefined &&
    left.outputKind === right.outputKind &&
    family(left) !== undefined &&
    family(left) === family(right)
  )
}
