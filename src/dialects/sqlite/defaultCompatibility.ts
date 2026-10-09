import type { DatabaseDefault } from '@/schemas'
import { analyzeSchema } from '@/schemas'
import type { AnySchema } from '@/types/schema'
import { MigrationError } from '@/utils/error'

import { mapSqliteResultValue } from './mapping'
import { normalizeSqliteDataType } from './normalize'

/** Applies ordinary-table affinity to a supported literal's storage value. */
function storedLiteral(
  value: string | number | boolean | null,
  dataType: string,
): string | number | bigint | null {
  if (value === null) return null

  const affinity = normalizeSqliteDataType(dataType)
  const primitive = typeof value === 'boolean' ? (value ? 1 : 0) : value

  if (affinity === 'text') return String(primitive)
  if (affinity === 'blob' && typeof primitive === 'string') return primitive

  // SQLite numeric affinity accepts decimal text, but preserves hex and other text.
  if (
    typeof primitive === 'string' &&
    !/^[ \t\r\n\f\v]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t\r\n\f\v]*$/.test(
      primitive,
    )
  )
    return primitive

  const text = String(primitive).trim()

  if (affinity !== 'real' && /^[+-]?\d+$/.test(text)) {
    const integer = BigInt(text)

    if (integer >= -(2n ** 63n) && integer < 2n ** 63n) {
      return Number.isSafeInteger(Number(integer)) ? Number(integer) : integer
    }
  }

  const numeric = Number(primitive)

  if (
    affinity !== 'real' &&
    affinity !== 'blob' &&
    Number.isInteger(numeric) &&
    numeric > -(2 ** 63) &&
    numeric < 2 ** 63
  ) {
    return Number.isSafeInteger(numeric) ? numeric : BigInt(numeric)
  }

  return numeric
}

/** Checks only the registered value family, without imposing schema constraints. */
function compatibleResult(value: unknown, schema: AnySchema): boolean {
  const analysis = analyzeSchema(schema)

  if (value === null) return analysis.nullable

  switch (analysis.outputKind) {
    case 'date':
      return value instanceof Date && !Number.isNaN(value.getTime())
    case 'json': {
      const arraySchema = [
        'array',
        'tuple',
        'loose_tuple',
        'strict_tuple',
        'tuple_with_rest',
      ].includes(analysis.baseSchema.type)

      return typeof value === 'object' && Array.isArray(value) === arraySchema
    }
    case 'string':
    case 'number':
    case 'bigint':
    case 'boolean':
      return typeof value === analysis.outputKind
    case undefined:
      return false
  }
}

/** Rejects literal and portable defaults that built-in result mapping cannot preserve. */
export function assertSqliteDefaultCompatibility(
  value: DatabaseDefault,
  dataType: string,
  schema: AnySchema,
  hasCustomResultMapping: boolean,
  identity: string,
): void {
  if (value.kind === 'dialectExpression') return

  // Result hooks own their logical contract. Planning must not execute user code.
  if (hasCustomResultMapping) return

  // Every supported portable expression returns this date/time text shape.
  const literal =
    value.kind === 'literal'
      ? value.value
      : value.expression === 'currentTime'
        ? '12:34:56'
        : value.expression === 'currentDate'
          ? '2000-01-02'
          : '2000-01-02 12:34:56'

  let compatible = false
  try {
    const stored = storedLiteral(literal, dataType)
    const mapped = mapSqliteResultValue(dataType, stored, { schema })
    compatible = compatibleResult(mapped, schema)
  } catch {
    // Built-in mapping also rejects unsafe numeric values and unsupported types.
  }

  if (!compatible) {
    throw new MigrationError({
      message: `SQLite database default on ${identity} is incompatible with the registered ${analyzeSchema(schema).outputKind ?? schema.type} logical type and ${JSON.stringify(dataType)} storage; requires an explicit result mapping`,
    })
  }
}
