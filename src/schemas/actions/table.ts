import type { BaseIssue, BaseSchema, MetadataAction } from 'valibot'
import { getMetadata, metadata } from 'valibot'
import type { TableMetadata } from './types'

/**
 * Attaches table metadata to a Valibot object schema for migrations.
 *
 * @param config - Table name, primary key, optional indexes and DB schema
 * @returns Metadata action for use in a `pipe` after `title()`
 *
 * @example
 * ```ts
 * const UserSchema = pipe(
 *   object({ id: pipe(string(), column({ type: 'uuid' })) }),
 *   title('users'),
 *   table({ name: 'users', primaryKey: 'id', indexes: ['email'] }),
 * )
 * ```
 */
export function table<
  TInput = unknown,
  const TConfig extends { name: string; primaryKey: string; indexes?: string[]; schema?: string } = { name: string; primaryKey: string },
>(
  config: TConfig,
): MetadataAction<TInput, TableMetadata<TConfig['name']>> {
  return metadata({ ...config, kind: 'table' })
}

/**
 * Type guard for table metadata (`kind: 'table'`).
 *
 * @param metadata - Value to check
 * @returns `true` if `metadata` is `TableMetadata`
 *
 * @example
 * ```ts
 * if (isTableMetadata(meta)) console.log(meta.primaryKey)
 * ```
 */
export function isTableMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is TableMetadata {
  return metadata !== undefined && metadata.kind === 'table'
}

/**
 * Reads table metadata from a schema, if present.
 *
 * @param schema - Schema that may include `table()` metadata
 * @returns Table metadata, or `undefined` if none
 *
 * @example
 * ```ts
 * const meta = getTableMetadata(UserSchema)
 * // { kind: 'table', name: 'users', primaryKey: 'id' }
 * ```
 */
export function getTableMetadata(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): TableMetadata | undefined {
  const schemaMetadata = getMetadata(schema) as
    | Record<string, unknown>
    | undefined
  return isTableMetadata(schemaMetadata) ? schemaMetadata : undefined
}
