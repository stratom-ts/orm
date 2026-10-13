import type { DriverErrorClassifier, DriverErrorKind } from '@/utils/error'

import { nativeCauses, nativeField } from '../nativeError'

const UNKNOWN = { kind: 'unknown', retryable: false } as const

const CONSTRAINT_CODES: Readonly<Partial<Record<number, DriverErrorKind>>> = {
  2067: 'uniqueViolation', // SQLITE_CONSTRAINT_UNIQUE
  1555: 'uniqueViolation', // SQLITE_CONSTRAINT_PRIMARYKEY
  787: 'foreignKeyViolation',
  1299: 'notNullViolation',
  275: 'checkViolation',
}

/** Reads SQLite's numeric primary or extended result code fields. */
function numericKind(native: object): DriverErrorKind | undefined {
  for (const key of ['errcode', 'extendedErrcode', 'sqliteCode', 'code', 'errno']) {
    const numeric = nativeField(native, key)

    if (typeof numeric !== 'number' || !Number.isInteger(numeric)) continue

    const kind =
      (numeric & 0xff) === 5 || (numeric & 0xff) === 6
        ? 'transient'
        : CONSTRAINT_CODES[numeric]

    if (kind) return kind
  }

  return undefined
}

/** Maps SQLite primary and extended result codes, including node:sqlite errcode. */
export const sqliteClassifyDriverError: DriverErrorClassifier = (cause) => {
  for (const native of nativeCauses(cause)) {
    const code = nativeField(native, 'code')
    const stringKind =
      code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
        ? 'uniqueViolation'
        : code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
          ? 'foreignKeyViolation'
          : code === 'SQLITE_CONSTRAINT_NOTNULL'
            ? 'notNullViolation'
            : code === 'SQLITE_CONSTRAINT_CHECK'
              ? 'checkViolation'
              : typeof code === 'string' && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)
                ? 'transient'
                : undefined

    if (stringKind) return { kind: stringKind, retryable: stringKind === 'transient' }

    const kind = numericKind(native)

    if (kind) return { kind, retryable: kind === 'transient' }
  }

  return UNKNOWN
}
