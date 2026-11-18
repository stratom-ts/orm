import { getColumnMetadata } from '@/schemas'
import type { TableHandle } from '@/types'

/** Lists declared primary and unique keys in their authored column order. */
function candidateKeys(handle: TableHandle): string[][] {
  const { primaryKey, indexes } = handle.getTableMetadata()
  return [
    Array.isArray(primaryKey) ? primaryKey : [primaryKey],
    ...(indexes ?? [])
      .filter((index) => index.unique === true)
      .map((index) => index.columns),
    ...Object.entries(handle.getSchema().entries)
      .filter(([, schema]) => getColumnMetadata(schema)?.unique === true)
      .map(([name]) => [name]),
  ]
}

export { candidateKeys }
