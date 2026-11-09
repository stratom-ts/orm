import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { ColumnRef, InferSelect, InferUpdate, TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'
import { QueryError } from '@/utils/error'

import type { ValueMapper } from './mapping'
import { validateUpdatePatchWithStructuredValues } from './validate'

const additions = new WeakSet()
const ADD = Symbol('stratom.add')

/** Opaque update-only addition, with SQL null propagation. */
type Addition<T = number | null> = Readonly<{
  [ADD]: T
  column: ColumnRef
  delta: number
}>

/**
 * Adds a finite number to a native numeric column in update `.set(...)`.
 * Negative deltas decrement. Nullable sources propagate null. Integer targets
 * require integer sources and deltas. Custom value mappings are unsupported.
 * Computed results rely on database constraints; Valibot refinements and
 * transforms do not run on them. RETURNING uses normal result mapping.
 */
function add<T extends number | null>(
  column: ColumnRef<string, string, T>,
  delta: number,
): Addition<T> {
  const candidate: unknown = column

  if (
    typeof candidate !== 'object' ||
    candidate === null ||
    !('column' in candidate) ||
    typeof candidate.column !== 'string'
  )
    throw new QueryError({ message: 'add requires a numeric column reference' })

  if (typeof delta !== 'number' || !Number.isFinite(delta))
    throw new QueryError({ message: 'add requires a finite number delta' })

  const token = Object.freeze({ [ADD]: undefined as unknown as T, column, delta })
  additions.add(token)
  return token
}

/** Recognizes only tokens created by add, never lookalike objects. */
function isAddition(value: unknown): value is Addition {
  return typeof value === 'object' && value !== null && additions.has(value)
}

type NumericAddition<T> = [Exclude<T, null | undefined>] extends [number]
  ? number extends Exclude<T, null | undefined>
    ? Addition<number> | (null extends T ? Addition<number | null> : never)
    : never
  : never

/** Literal update values plus compatible numeric additions on writable columns. */
type UpdatePatch<T extends TableHandle> = {
  [K in keyof InferUpdate<T>]?:
    | InferUpdate<T>[K]
    | NumericAddition<K extends keyof InferSelect<T> ? InferSelect<T>[K] : never>
}

/** Validates addition ownership and compatibility without parsing computed values. */
function prepareUpdatePatch(
  handle: TableHandle,
  patch: unknown,
  mapper: ValueMapper | undefined,
): Record<string, unknown> {
  const cleaned = validateUpdatePatchWithStructuredValues(handle, patch, isAddition)
  for (const [target, value] of Object.entries(cleaned)) {
    if (!isAddition(value)) continue

    const source = value.column.column

    if (
      !source ||
      !Object.hasOwn(handle.getSchema().entries, source) ||
      (handle as unknown as Record<string, unknown>)[source] !== value.column
    ) {
      throw new QueryError({
        message: 'add requires a column from the exact updated table handle',
      })
    }

    const entries = handle.getSchema().entries as Record<string, AnySchema>
    const sourceFacts = extractStorageFacts(entries[source])
    const targetFacts = extractStorageFacts(entries[target])

    if (!mapper) throw new QueryError({ message: 'add requires a numeric value mapper' })

    const sourceType = mapper.numericAssignmentType(handle, source)
    const targetType = mapper.numericAssignmentType(handle, target)

    if (sourceFacts.nullable && !targetFacts.nullable)
      throw new QueryError({ message: 'nullable addition requires a nullable target' })

    if (
      targetType === 'integer' &&
      (sourceType !== 'integer' || !Number.isInteger(value.delta))
    ) {
      throw new QueryError({
        message: 'integer addition requires an integer source and delta',
      })
    }

    mapper.mapParam(handle, target, value.delta)
  }

  return cleaned
}

export type { Addition, UpdatePatch }

export { add, isAddition, prepareUpdatePatch }
