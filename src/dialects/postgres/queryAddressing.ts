import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'

import { resolvePostgresQueryRelation } from './compile'

/**
 * Finds registered table handles that address the same PostgreSQL query relation.
 *
 * Omitted qualification is equivalent to an explicit `public` schema.
 *
 * @param handles - Registered handles available to the current query path.
 * @param relation - Authored relation intent to resolve.
 */
export function findPostgresQueryRelationMatches(
  handles: readonly TableHandle[],
  relation: RelationIdentityInput,
): readonly TableHandle[] {
  const expected = resolvePostgresQueryRelation(relation)

  return handles.filter((handle) => {
    const candidate = resolvePostgresQueryRelation(handle.getTableMetadata().relation)
    return candidate.schema === expected.schema && candidate.table === expected.table
  })
}

/**
 * Finds registered table columns that address the same PostgreSQL member spelling.
 *
 * PostgreSQL query compilation quotes authored identifiers, so query-time member
 * addressing remains exact.
 *
 * @param handle - Table handle whose schema columns should be searched.
 * @param column - Authored column spelling to resolve.
 */
export function findPostgresQueryColumnMatches(
  handle: TableHandle,
  column: string,
): readonly string[] {
  return Object.keys(handle.getSchema().entries).filter(
    (candidate) => candidate === column,
  )
}
