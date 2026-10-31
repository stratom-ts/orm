import type { RelationIdentityInput } from '@/schemas'
import type { TableHandle } from '@/types'

const sources = new WeakMap<RelationIdentityInput, TableHandle>()

/** Retains the exact table selected before SQL occurrence aliases are assigned. */
export function recordQueryRelation(
  relation: RelationIdentityInput,
  handle: TableHandle,
): void {
  sources.set(relation, handle)
}

/** Reads source provenance without resolving the occurrence against another scope. */
export function queryRelationSource(
  relation: RelationIdentityInput,
): TableHandle | undefined {
  return sources.get(relation)
}
