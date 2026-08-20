import type { AnySchema } from '@/types/schema'

type MetadataRecord = Record<string, unknown> & { kind: string }

type TraversableSchema = AnySchema & {
  pipe?: readonly unknown[]
  wrapped?: AnySchema
}

/**
 * Reads metadata from a Valibot action value.
 *
 * @param value - Potential metadata action.
 *
 * @returns The action metadata, or `undefined` when absent
 */
function actionMetadata(value: unknown): MetadataRecord | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('metadata' in value) ||
    typeof value.metadata !== 'object' ||
    value.metadata === null
  ) {
    return undefined
  }

  return value.metadata as MetadataRecord
}

/**
 * Finds the nearest metadata action of one kind across nested pipes and wrappers.
 *
 * @example
 *   const metadata = findSchemaMetadata<ColumnMetadata>(schema, 'column')
 *
 * @param schema - Schema whose pipes and wrappers should be searched.
 * @param kind - Metadata discriminant to find.
 *
 * @returns The nearest matching metadata, or `undefined` when absent
 */
export function findSchemaMetadata<T extends MetadataRecord>(
  schema: AnySchema,
  kind: T['kind'],
): T | undefined {
  const traversable = schema as TraversableSchema

  if (traversable.pipe) {
    const actions = traversable.pipe.slice(1)

    for (let index = actions.length - 1; index >= 0; index--) {
      const metadata = actionMetadata(actions[index])
      if (metadata?.kind === kind) return metadata as T
    }

    // The first schema inside reference() describes the target value, not local
    // source-column options. A more-local column action would have returned above.
    if (
      kind === 'column' &&
      actions.some((action) => actionMetadata(action)?.kind === 'reference')
    ) {
      return undefined
    }

    const first = traversable.pipe[0]

    if (typeof first === 'object' && first !== null && 'kind' in first) {
      const nested = findSchemaMetadata<T>(first as AnySchema, kind)
      if (nested) return nested
    }
  }

  if (traversable.wrapped) {
    return findSchemaMetadata<T>(traversable.wrapped, kind)
  }

  return undefined
}
