import type { BaseIssue, BaseSchema, MetadataAction } from 'valibot'
import { getMetadata, metadata } from 'valibot'
import type { ColumnMetadata } from './types'

/**
 * A metadata action for column definitions.
 * @param config - Column metadata configuration
 * @returns A Valibot MetadataAction that can be used in a pipe
 */
export function column<TInput = unknown>(
  config: Omit<ColumnMetadata, 'kind'>,
): MetadataAction<TInput, ColumnMetadata> {
  return metadata({ ...config, kind: 'column' })
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
 */
export function getColumnMetadata(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): ColumnMetadata | undefined {
  const schemaMetadata = getMetadata(schema) as Record<string, unknown> | undefined
  return isColumnMetadata(schemaMetadata) ? schemaMetadata : undefined
}
