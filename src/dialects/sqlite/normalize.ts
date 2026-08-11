import { assertSafeSqliteDataType } from './validate'

/** SQLite type affinity/comparison key. */
export function normalizeSqliteDataType(dataType: string): string {
  const value = assertSafeSqliteDataType(dataType)
  const upper = value.toUpperCase()
  if (upper.includes('INT')) return 'INTEGER'
  if (upper.includes('CHAR') || upper.includes('CLOB') || upper.includes('TEXT'))
    return 'TEXT'
  if (upper.includes('BLOB') || upper === '') return 'BLOB'
  if (upper.includes('REAL') || upper.includes('FLOA') || upper.includes('DOUB'))
    return 'REAL'
  return 'NUMERIC'
}
