import type { MetadataAction } from 'valibot'
import { getMetadata, metadata } from 'valibot'

import type { AnySchema } from '@/types/schema'

import { createRelationInput } from './relation'
import type { NamespaceIdentifierInput } from './relation'
import type { TableIndex, TableMetadata } from './types'

type TableActionConfig = {
  name: string
  primaryKey: string | readonly string[]
  indexes?: TableIndex[]
  namespace?: readonly NamespaceIdentifierInput[]
}

/**
 * Attaches table metadata to a Valibot object schema for migrations.
 *
 * @example
 *   const UserSchema = pipe(
 *     object({ id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) }),
 *     title('users'),
 *     table({
 *       name: 'users',
 *       primaryKey: 'id',
 *       indexes: [{ columns: ['email'], unique: true }],
 *       namespace: [{ role: 'schema', spelling: 'public' }],
 *     }),
 *   )
 *
 * @param config - Table name, primary key(s), optional indexes and namespace intent.
 *
 * @returns Metadata action for use in a `pipe` after `title()`
 */
export function table<TInput = unknown, const TName extends string = string>(
  config: TableActionConfig & { name: TName },
): MetadataAction<TInput, TableMetadata<TName>> {
  const relation = createRelationInput(config.name, config.namespace)
  const primaryKey = Array.isArray(config.primaryKey)
    ? [...config.primaryKey]
    : config.primaryKey

  return metadata({
    kind: 'table',
    name: config.name,
    relation,
    primaryKey,
    ...(config.indexes !== undefined ? { indexes: config.indexes } : {}),
  }) as MetadataAction<TInput, TableMetadata<TName>>
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
  return metadata?.kind === 'table'
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
