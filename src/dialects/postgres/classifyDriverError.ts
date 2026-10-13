import type { DriverErrorClassifier } from '@/utils/error'

import { nativeCauses, nativeField } from '../nativeError'

const UNKNOWN = { kind: 'unknown', retryable: false } as const
const TRANSIENT_CODES = new Set([
  '40P01',
  '40001',
  '08000',
  '08001',
  '08003',
  '08006',
  '57P01',
  '57P02',
  '57P03',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
])

/** Maps native PostgreSQL SQLSTATE and network codes to portable failure fields. */
export const postgresClassifyDriverError: DriverErrorClassifier = (cause) => {
  for (const native of nativeCauses(cause)) {
    const code = nativeField(native, 'code')

    if (typeof code !== 'string') continue

    const kind =
      code === '23505'
        ? 'uniqueViolation'
        : code === '23503'
          ? 'foreignKeyViolation'
          : code === '23502'
            ? 'notNullViolation'
            : code === '23514'
              ? 'checkViolation'
              : TRANSIENT_CODES.has(code)
                ? 'transient'
                : undefined

    if (!kind) continue

    const constraint = nativeField(native, 'constraint')
    const table = nativeField(native, 'table')
    const column = nativeField(native, 'column')

    return {
      kind,
      retryable: kind === 'transient',
      ...(typeof constraint === 'string' ? { constraint } : {}),
      ...(typeof table === 'string' ? { table } : {}),
      ...(typeof column === 'string' ? { columns: [column] } : {}),
    }
  }

  return UNKNOWN
}
