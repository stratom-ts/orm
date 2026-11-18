import type { Dialect } from '@/dialects/types'
import type { CanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type { ColumnNamingFunction } from '@/naming'
import type { TableHandle } from '@/types'
import { SchemaError } from '@/utils/error'

import { getColumnMetadata } from './actions/column'

/** Client-owned lookup of stored physical names by authored relation and property. */
type ResolvedColumnNames = (handle: TableHandle, property: string) => string

/** Resolves storage spelling without treating physical names as application aliases. */
function physicalColumnName(
  handle: TableHandle,
  property: string,
  resolved?: ResolvedColumnNames,
): string {
  if (resolved) return resolved(handle, property)

  if (!Object.hasOwn(handle.getSchema().entries, property))
    throw new SchemaError({
      message: `Unknown application column ${JSON.stringify(property)} on ${handle.getTableMetadata().name}`,
    })

  const metadata = getColumnMetadata(handle.getSchema().entries[property])

  if (!metadata || !Object.hasOwn(metadata, 'name')) return property

  if (
    typeof metadata.name !== 'string' ||
    metadata.name.length === 0 ||
    metadata.name.includes('\0')
  )
    throw new SchemaError({
      message: `Invalid physical name ${typeof metadata.name === 'string' ? JSON.stringify(metadata.name) : typeof metadata.name} for application column ${JSON.stringify(property)} on ${handle.getTableMetadata().name}`,
    })

  return metadata.name
}

/** Validates physical mappings with the selected member before any session is acquired. */
function validateColumnNames(handles: readonly TableHandle[], dialect: Dialect): void {
  resolveColumnNames(handles, dialect)
}

/** Takes a client-owned snapshot before a session provider is created. */
function resolveColumnNames(
  handles: readonly TableHandle[],
  dialect: Dialect,
  naming?: ColumnNamingFunction,
): ResolvedColumnNames {
  const tables = new Map<string, Map<string, string>>()
  for (const handle of handles) {
    const table = handle.getTableMetadata().name
    const columns = new Map<string, string>()
    const registry = dialect.naming.createRegistry()
    for (const property of Object.keys(handle.getSchema().entries)) {
      const returned = nameColumn(handle, property, naming)
      const description = `application column ${JSON.stringify(property)} (physical ${formatName(returned)}) on ${table}`

      const name = validateName(returned, description)

      registry.reserve({
        kind: 'check',
        owner: { namespace: [], relation: { spelling: table, comparisonKey: table } },
        name,
        token: property,
        description,
      })

      columns.set(property, name)
    }

    tables.set(relationKey(handle), columns)
  }

  return (handle, property) => {
    const name = tables.get(relationKey(handle))?.get(property)

    if (name === undefined)
      throw new SchemaError({
        message: `Unknown application column ${JSON.stringify(property)} on ${handle.getTableMetadata().name}`,
      })

    return name
  }
}

/** Rejects invalid callback output before dialect identifier validation. */
function validateName(value: unknown, description: string): string {
  if (typeof value !== 'string' || !value.length || value.includes('\0'))
    throw new SchemaError({ message: `Invalid physical name for ${description}` })

  return value
}

/** Applies explicit precedence and keeps callback failures as their original cause. */
function nameColumn(
  handle: TableHandle,
  property: string,
  naming?: ColumnNamingFunction,
): unknown {
  const metadata = getColumnMetadata(handle.getSchema().entries[property])

  if (metadata && Object.hasOwn(metadata, 'name'))
    return physicalColumnName(handle, property)

  if (!naming) return property

  try {
    return naming({ column: property, table: handle.getTableMetadata().name })
  } catch (cause) {
    throw new SchemaError({
      message: `Column naming failed for application column ${JSON.stringify(property)} on ${handle.getTableMetadata().name}`,
      cause,
    })
  }
}

/** Serializes authored relation structure without dotted-name ambiguity. */
function relationKey(handle: TableHandle): string {
  const relation = handle.getTableMetadata().relation
  return JSON.stringify([
    (relation.namespace ?? []).map(({ role, spelling }) => [role, spelling]),
    relation.relation,
  ])
}

/** Formats arbitrary callback values without invoking user serialization hooks. */
function formatName(value: unknown): string {
  if (value === null) return 'null'

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value)
    case 'symbol':
      return value.toString()
    case 'object':
    case 'function':
    case 'undefined':
      return typeof value
  }

  return typeof value
}

/** Fingerprints effective storage names in canonical relation and property order. */
function columnNamesFingerprint(
  handles: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
  resolved: ResolvedColumnNames,
): string {
  const entries = handles.map((handle) => {
    const identity = identities.resolve(handle.getTableMetadata().relation)
    return JSON.stringify([
      identity.namespace.map(({ role, identifier }) => [role, identifier.comparisonKey]),
      identity.relation.comparisonKey,
      Object.keys(handle.getSchema().entries)
        .sort()
        .map((property) => [property, resolved(handle, property)]),
    ])
  })

  return JSON.stringify(entries.sort())
}

export {
  physicalColumnName,
  validateColumnNames,
  resolveColumnNames,
  columnNamesFingerprint,
}
export type { ResolvedColumnNames }
