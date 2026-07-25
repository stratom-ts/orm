import type { MetadataAction } from 'valibot'
import { getMetadata, metadata } from 'valibot'

import type { AnySchema } from '@/types/schema'

import type { TableIndex, TableMetadata } from './types'

/**
 * Attaches table metadata to a Valibot object schema for migrations.
 *
 * @example
 *   const UserSchema = pipe(
 *     object({ id: pipe(string(), column({ type: 'uuid' })) }),
 *     title('users'),
 *     table({
 *       name: 'users',
 *       primaryKey: 'id',
 *       indexes: [{ columns: ['email'], unique: true }],
 *       schema: 'public',
 *     }),
 *   )
 *
 * @param config - Table name, primary key(s), optional indexes and DB schema.
 *
 * @returns Metadata action for use in a `pipe` after `title()`
 */
export function table<
  TInput = unknown,
  const TConfig extends {
    name: string
    primaryKey: string | readonly string[]
    indexes?: TableIndex[]
    schema?: string
  } = { name: string; primaryKey: string },
>(config: TConfig): MetadataAction<TInput, TableMetadata<TConfig['name']>> {
  const primaryKey = Array.isArray(config.primaryKey)
    ? [...config.primaryKey]
    : config.primaryKey

  return metadata({
    kind: 'table',
    name: config.name,
    primaryKey,
    ...(config.indexes !== undefined ? { indexes: config.indexes } : {}),
    ...(config.schema !== undefined ? { schema: config.schema } : {}),
  }) as MetadataAction<TInput, TableMetadata<TConfig['name']>>
}

/**
 * Type guard for table metadata (`kind: 'table'`).
 *
 * @example
 *   if (isTableMetadata(meta)) console.log(meta.primaryKey)
 *
 * @param metadata - Value to check.
 *
 * @returns `true` if `metadata` is `TableMetadata`
 */
export function isTableMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is TableMetadata {
  return metadata !== undefined && metadata.kind === 'table'
}

/**
 * Reads table metadata from a schema, if present.
 *
 * @example
 *   const meta = getTableMetadata(UserSchema)
 *   // { kind: 'table', name: 'users', primaryKey: 'id' }
 *
 * @param schema - Schema that may include `table()` metadata.
 *
 * @returns Table metadata, or `undefined` if none
 */
export function getTableMetadata(schema: AnySchema): TableMetadata | undefined {
  const schemaMetadata = getMetadata(schema) as Record<string, unknown> | undefined
  return isTableMetadata(schemaMetadata) ? schemaMetadata : undefined
}
