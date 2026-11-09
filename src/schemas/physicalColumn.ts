import type { Dialect } from '@/dialects/types'
import type { TableHandle } from '@/types'
import { SchemaError } from '@/utils/error'

import { getColumnMetadata } from './actions/column'

/** Resolves storage spelling without treating physical names as application aliases. */
export function physicalColumnName(handle: TableHandle, property: string): string {
  if (!Object.hasOwn(handle.getSchema().entries, property)) {
    throw new SchemaError({
      message: `Unknown application column ${JSON.stringify(property)} on ${handle.getTableMetadata().name}`,
    })
  }

  const metadata = getColumnMetadata(handle.getSchema().entries[property])

  if (!metadata || !Object.hasOwn(metadata, 'name')) return property

  if (
    typeof metadata.name !== 'string' ||
    metadata.name.length === 0 ||
    metadata.name.includes('\0')
  ) {
    throw new SchemaError({
      message: `Invalid physical name ${typeof metadata.name === 'string' ? JSON.stringify(metadata.name) : typeof metadata.name} for application column ${JSON.stringify(property)} on ${handle.getTableMetadata().name}`,
    })
  }

  return metadata.name
}

/** Validates physical mappings with the selected member before any session is acquired. */
export function validateColumnNames(
  handles: readonly TableHandle[],
  dialect: Dialect,
): void {
  for (const handle of handles) {
    const registry = dialect.naming.createRegistry()
    const table = handle.getTableMetadata().name
    for (const property of Object.keys(handle.getSchema().entries)) {
      const name = physicalColumnName(handle, property)
      registry.reserve({
        kind: 'check',
        owner: { namespace: [], relation: { spelling: table, comparisonKey: table } },
        name,
        token: property,
        description: `application column ${JSON.stringify(property)} (physical ${JSON.stringify(name)}) on ${table}`,
      })
    }
  }
}
