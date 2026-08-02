import type { MetadataAction } from 'valibot'
import { metadata } from 'valibot'

import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

import { findSchemaMetadata } from './metadata'
import type { ColumnGeneration, ColumnMetadata } from './types'

function sameGeneration(left: ColumnGeneration, right: ColumnGeneration): boolean {
  return (
    left === right ||
    (left.kind === 'identity' && right.kind === 'identity' && left.mode === right.mode)
  )
}

/** Reconciles tagged and legacy generation fields into one canonical intent. */
export function normalizeColumnGeneration(
  metadata: Pick<ColumnMetadata, 'generation' | 'generated' | 'autoIncrement'>,
): ColumnGeneration | undefined {
  const declarations: ColumnGeneration[] = []
  if (metadata.generation !== undefined) declarations.push(metadata.generation)
  if (metadata.generated !== undefined) {
    declarations.push({ kind: 'identity', mode: metadata.generated })
  }
  if (metadata.autoIncrement) {
    declarations.push({ kind: 'identity', mode: 'byDefault' })
  }

  const normalized = declarations[0]
  if (normalized && declarations.some((value) => !sameGeneration(normalized, value))) {
    throw new SchemaError({
      message: 'generation, generated, and autoIncrement must describe the same strategy',
    })
  }
  return normalized
}

/** Rewrites generation metadata to the canonical tagged field for adapter lowering. */
export function normalizeColumnMetadata(metadata: ColumnMetadata): ColumnMetadata {
  const generation = normalizeColumnGeneration(metadata)
  const normalized = { ...metadata }
  delete normalized.generated
  delete normalized.autoIncrement
  delete normalized.generation
  if (generation !== undefined) normalized.generation = generation
  return normalized
}

/**
 * Attaches column metadata to a Valibot schema for migrations and typing.
 *
 * @example
 *   const email = pipe(string(), column({ type: 'varchar(255)', unique: true }))
 *
 * @param config - Column options (type, default, unique, generated, etc.)
 *
 * @returns Metadata action for use in a `pipe`
 */
export function column<
  TInput = unknown,
  TConfig extends Omit<ColumnMetadata, 'kind'> = Omit<ColumnMetadata, 'kind'>,
>(config: TConfig): MetadataAction<TInput, TConfig & { kind: 'column' }> {
  return metadata({ ...config, kind: 'column' }) as MetadataAction<
    TInput,
    TConfig & { kind: 'column' }
  >
}

/**
 * Type guard for column metadata (`kind: 'column'`).
 *
 * @example
 *   if (isColumnMetadata(meta)) console.log(meta.type)
 *
 * @param metadata - Value to check.
 *
 * @returns `true` if `metadata` is `ColumnMetadata`
 */
export function isColumnMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is ColumnMetadata {
  return metadata !== undefined && metadata.kind === 'column'
}

/**
 * Reads column metadata from a schema, unwrapping nullability wrappers first.
 *
 * @example
 *   const meta = getColumnMetadata(pipe(string(), column({ type: 'text' })))
 *   // { kind: 'column', type: 'text' }
 *
 * @param schema - Column schema that may include `column()` metadata.
 *
 * @returns Column metadata, or `undefined` if none
 */
export function getColumnMetadata(schema: AnySchema): ColumnMetadata | undefined {
  return findSchemaMetadata<ColumnMetadata>(schema, 'column')
}
