import type { MetadataAction } from 'valibot'
import { metadata } from 'valibot'

import type { AnySchema } from '@/types/schema'

import { findSchemaMetadata } from './metadata'
import type { ColumnMetadata } from './types'

/**
 * Attaches column metadata to a Valibot schema for migrations and typing.
 *
 * @example
 *   const email = pipe(string(), column({ physicalType: { postgresql: 'varchar(255)' }, unique: true }))
 *
 * @param config - Column storage, constraint, default, and generation options.
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
 *   if (isColumnMetadata(meta)) console.log(meta.physicalType)
 *
 * @param metadata - Value to check.
 *
 * @returns `true` if `metadata` is `ColumnMetadata`
 */
export function isColumnMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is ColumnMetadata {
  return metadata?.kind === 'column'
}

/**
 * Reads column metadata from a schema, unwrapping nullability wrappers first.
 *
 * @example
 *   const meta = getColumnMetadata(
 *     pipe(string(), column({ physicalType: { postgresql: 'text' } })),
 *   )
 *
 * @param schema - Column schema that may include `column()` metadata.
 *
 * @returns Column metadata, or `undefined` if none
 */
export function getColumnMetadata(schema: AnySchema): ColumnMetadata | undefined {
  return findSchemaMetadata<ColumnMetadata>(schema, 'column')
}
