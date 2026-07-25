import type { IndexConfig, TableIndex } from '@/schemas/actions/types'

/**
 * Normalizes an index entry to a full `IndexConfig`.
 *
 * A bare string is treated as a single-column index; a config is returned as-is.
 *
 * @example
 *   normalizeIndex('email') // { columns: ['email'] }
 *   normalizeIndex({ columns: ['name'], unique: true }) // { columns: ['name'], unique: true }
 *
 * @param index - Column name or index config.
 *
 * @returns Index config with an explicit `columns` array
 */
export function normalizeIndex(index: TableIndex): IndexConfig {
  if (typeof index === 'string') {
    return { columns: [index] }
  }
  return index
}
