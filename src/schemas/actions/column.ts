import type { BaseIssue, BaseSchema, MetadataAction } from 'valibot'
import { getMetadata, metadata } from 'valibot'
import type { ColumnMetadata } from './types'

interface WrapperSchema {
  wrapped: BaseSchema<unknown, unknown, BaseIssue<unknown>>
}

/**
 * Unwraps Valibot wrapper schemas (optional, nullable, nullish) to find
 * the inner schema. Unlike getBaseSchema, this preserves pipe structures.
 */
function unwrapWrapper(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): BaseSchema<unknown, unknown, BaseIssue<unknown>> {
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
 * A metadata action for column definitions.
 * @param config - Column metadata configuration
 * @returns A Valibot MetadataAction that can be used in a pipe
 */
export function column<
  TInput = unknown,
  TConfig extends Omit<ColumnMetadata, 'kind'> = Omit<ColumnMetadata, 'kind'>,
>(
  config: TConfig,
): MetadataAction<TInput, TConfig & { kind: 'column' }> {
  return metadata({ ...config, kind: 'column' }) as MetadataAction<TInput, TConfig & { kind: 'column' }>
}

/**
 * Type guard to check if metadata is column metadata.
 */
export function isColumnMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is ColumnMetadata {
  return metadata !== undefined && metadata.kind === 'column'
}

/**
 * Extracts column metadata from a schema if it exists.
 *
 * Unwraps Valibot wrapper schemas (optional, nullable, nullish) to find
 * column metadata inside them.
 */
export function getColumnMetadata(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): ColumnMetadata | undefined {
  const schemaMetadata = getMetadata(unwrapWrapper(schema)) as
    | Record<string, unknown>
    | undefined
  return isColumnMetadata(schemaMetadata) ? schemaMetadata : undefined
}
