import type { BaseIssue, BaseSchema, MetadataAction } from 'valibot'
import { getMetadata, metadata } from 'valibot'
import type { TableMetadata } from './types'

/**
 * A metadata action for table definitions.
 * @param config - Table metadata configuration
 * @returns A Valibot MetadataAction that can be used in a pipe
 */
export function table<TInput = unknown>(
  config: Omit<TableMetadata, 'kind'>,
): MetadataAction<TInput, TableMetadata> {
  return metadata({ ...config, kind: 'table' })
}

/**
 * Type guard to check if metadata is table metadata.
 */
export function isTableMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is TableMetadata {
  return metadata !== undefined && metadata.kind === 'table'
}

/**
 * Extracts table metadata from a schema if it exists.
 */
export function getTableMetadata(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): TableMetadata | undefined {
  const schemaMetadata = getMetadata(schema) as Record<string, unknown> | undefined
  return isTableMetadata(schemaMetadata) ? schemaMetadata : undefined
}
