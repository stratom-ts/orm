import type { MetadataAction } from 'valibot'
import { getMetadata, metadata } from 'valibot'

import type { AnySchema } from '@/types/schema'

import type { ColumnMetadata } from './types'

interface WrapperSchema {
  wrapped: AnySchema
}

/**
 * Unwraps optional/nullable/nullish wrappers while preserving pipes.
 *
 * @param schema - Schema that may be wrapped
 * @returns Inner schema with pipe structure intact
 *
 * @example
 * ```ts
 * const inner = unwrapWrapper(optional(pipe(string(), column({ type: 'text' }))))
 * ```
 */
function unwrapWrapper(schema: AnySchema): AnySchema {
  if (
    schema.type === 'optional' ||
    schema.type === 'nullable' ||
    schema.type === 'nullish' ||
    schema.type === 'non_optional' ||
    schema.type === 'non_nullable' ||
    schema.type === 'non_nullish'
  ) {
    return unwrapWrapper((schema as unknown as WrapperSchema).wrapped)
  }
  return schema
}

/**
 * Attaches column metadata to a Valibot schema for migrations and typing.
 *
 * @param config - Column options (type, default, unique, generated, etc.)
 * @returns Metadata action for use in a `pipe`
 *
 * @example
 * ```ts
 * const email = pipe(string(), column({ type: 'varchar(255)', unique: true }))
 * ```
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
 * @param metadata - Value to check
 * @returns `true` if `metadata` is `ColumnMetadata`
 *
 * @example
 * ```ts
 * if (isColumnMetadata(meta)) console.log(meta.type)
 * ```
 */
export function isColumnMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is ColumnMetadata {
  return metadata !== undefined && metadata.kind === 'column'
}

/**
 * Reads column metadata from a schema, unwrapping nullability wrappers first.
 *
 * @param schema - Column schema that may include `column()` metadata
 * @returns Column metadata, or `undefined` if none
 *
 * @example
 * ```ts
 * const meta = getColumnMetadata(pipe(string(), column({ type: 'text' })))
 * // { kind: 'column', type: 'text' }
 * ```
 */
export function getColumnMetadata(
  schema: AnySchema,
): ColumnMetadata | undefined {
  const schemaMetadata = getMetadata(unwrapWrapper(schema)) as
    | Record<string, unknown>
    | undefined
  return isColumnMetadata(schemaMetadata) ? schemaMetadata : undefined
}
