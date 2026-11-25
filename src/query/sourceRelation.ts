import type { RelationIdentityInput } from '@/schemas'
import type { ReadSource } from '@/types/tableHandle'

const sources = new WeakMap<RelationIdentityInput, ReadSource>()

/** Retains the exact table selected before SQL occurrence aliases are assigned. */
export function recordQueryRelation(
  relation: RelationIdentityInput,
  handle: ReadSource,
): void {
  sources.set(relation, handle)
}

/** Reads source provenance without resolving the occurrence against another scope. */
export function queryRelationSource(
  relation: RelationIdentityInput,
): ReadSource | undefined {
  return sources.get(relation)
}
