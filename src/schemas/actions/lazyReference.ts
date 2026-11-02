import { getMetadata } from 'valibot'

import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

import { findSchemaMetadata } from './metadata'
import type { ReferenceOptions, ReferenceTarget } from './reference'
import { getReferenceMetadata } from './reference'
import { createRelationInput, sameRelationInput } from './relation'
import type { ReferenceMetadata } from './types'

/** Deferred reference intent. Reading metadata does not evaluate the target. */
type LazyReferenceMetadata = ReferenceOptions & {
  kind: 'lazy-reference'
  resolve(): ResolvedLazyReference
}

type ResolvedLazyReference = Readonly<{
  metadata: ReferenceMetadata
  schema: AnySchema
}>

/** Reads a deferred target only at an explicit graph-resolution boundary. */
function resolveTarget(target: () => ReferenceTarget, column: string) {
  const value: unknown = target()

  if (typeof value !== 'object' || value === null)
    throw new SchemaError({ message: 'Lazy reference target is missing' })

  const targetValue = value as ReferenceTarget
  const schema = 'getSchema' in targetValue ? targetValue.getSchema() : targetValue
  const table =
    'getTableMetadata' in targetValue
      ? targetValue.getTableMetadata()
      : getMetadata(schema)

  const authoredRelation: unknown = table.relation

  if (typeof authoredRelation !== 'object' || authoredRelation === null)
    throw new SchemaError({
      message: 'Lazy reference target is missing relation metadata',
    })

  const entries: unknown = schema.entries

  if (
    typeof entries !== 'object' ||
    entries === null ||
    !Object.hasOwn(schema.entries, column)
  )
    throw new SchemaError({
      message: `Lazy reference targets missing application column ${JSON.stringify(column)}`,
    })

  return { relation: authoredRelation as ReferenceMetadata['target']['relation'], schema }
}

/** Captures stable relation intent while evaluating the target once per graph. */
function createLazyReferenceMetadata(
  target: () => ReferenceTarget,
  column: string,
  options?: ReferenceOptions,
): LazyReferenceMetadata {
  let pinned: ReferenceMetadata['target'] | undefined
  const actions = {
    ...(options?.onDelete === undefined ? {} : { onDelete: options.onDelete }),
    ...(options?.onUpdate === undefined ? {} : { onUpdate: options.onUpdate }),
  }

  return Object.freeze({
    kind: 'lazy-reference',
    ...actions,
    resolve() {
      const { relation, schema } = resolveTarget(target, column)
      const snapshot = createRelationInput(relation.relation, relation.namespace)

      if (snapshot.namespace) {
        for (const segment of snapshot.namespace) Object.freeze(segment)
        Object.freeze(snapshot.namespace)
      }

      Object.freeze(snapshot)

      if (pinned && !sameRelationInput(pinned.relation, snapshot))
        throw new SchemaError({
          message: 'Lazy reference target identity changed after resolution',
        })

      pinned ??= Object.freeze({ relation: snapshot, column })
      return Object.freeze({
        metadata: Object.freeze({ kind: 'reference', target: pinned, ...actions }),
        schema: schema.entries[column],
      })
    },
  })
}

/** Finds deferred intent through the same pipes and wrappers as eager references. */
function getLazyReferenceMetadata(schema: AnySchema): LazyReferenceMetadata | undefined {
  const metadata = findSchemaMetadata<ReferenceMetadata | LazyReferenceMetadata>(schema, [
    'reference',
    'lazy-reference',
  ])

  return metadata?.kind === 'lazy-reference' ? metadata : undefined
}

/** Resolves declarations once within one complete registration or query graph. */
function createReferenceResolver(
  validate?: (source: AnySchema, target: AnySchema, metadata: ReferenceMetadata) => void,
) {
  const resolved = new Map<LazyReferenceMetadata, ResolvedLazyReference>()
  return (schema: AnySchema): ReferenceMetadata | undefined => {
    const lazy = getLazyReferenceMetadata(schema)

    if (!lazy) return getReferenceMetadata(schema)

    let result = resolved.get(lazy)

    if (!result) {
      result = lazy.resolve()
      resolved.set(lazy, result)
    }

    validate?.(schema, result.schema, result.metadata)
    return result.metadata
  }
}

export type { LazyReferenceMetadata }

export { createLazyReferenceMetadata, getLazyReferenceMetadata, createReferenceResolver }
