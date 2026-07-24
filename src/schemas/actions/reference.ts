import type {
  BaseIssue,
  BaseSchema,
  InferOutput,
  MetadataAction,
  ObjectEntries,
  ObjectSchema,
  SchemaWithPipe,
  TitleAction,
} from 'valibot'
import { getMetadata, getTitle, metadata, pipe } from 'valibot'
import { postgresAdapter } from '@/dialects'
import { isTableMetadata } from './table'
import { getColumnMetadata } from './column'
import type { ReferenceMetadata } from './types'

interface WrapperSchema {
  wrapped: BaseSchema<unknown, unknown, BaseIssue<unknown>>
}

/**
 * Unwraps optional/nullable/nullish wrappers while preserving pipes.
 *
 * @param schema - Schema that may be wrapped
 * @returns Inner schema with pipe structure intact
 *
 * @example
 * ```ts
 * const inner = unwrapWrapper(optional(pipe(string(), column({ type: 'uuid' }))))
 * ```
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
 * Builds a foreign-key column schema from a referenced table schema and key.
 *
 * @param schema - Referenced table schema
 * @param key - Column on the referenced table
 * @returns Piped schema for the FK column with reference metadata
 *
 * @example
 * ```ts
 * const PostSchema = pipe(
 *   object({
 *     id: pipe(string(), column({ type: 'uuid' })),
 *     authorId: references(UserSchema, 'id'),
 *   }),
 *   title('posts'),
 *   table({ name: 'posts', primaryKey: 'id' }),
 * )
 * ```
 */
export function references<
  T extends SchemaWithPipe<
    readonly [
      ObjectSchema<ObjectEntries, undefined>,
      TitleAction<unknown, string>,
      MetadataAction<unknown, Record<string, unknown>>,
    ]
  >,
  K extends keyof T['entries'],
>(
  schema: T,
  key: K,
): SchemaWithPipe<
  readonly [
    T['entries'][K],
    MetadataAction<InferOutput<T['entries'][K]>, ReferenceMetadata>,
  ]
> {
  const schemaTitle = getTitle(schema)
  const schemaMetadata = getMetadata(schema) as Record<string, unknown>
  const tableMeta = isTableMetadata(schemaMetadata) ? schemaMetadata : null

  const referencedColumnSchema = schema['entries'][key as string] as
    | BaseSchema<unknown, unknown, BaseIssue<unknown>>
    | undefined

  const referencedColumnMetadata = referencedColumnSchema
    ? getColumnMetadata(referencedColumnSchema)
    : undefined

  const dataType =
    referencedColumnMetadata?.type ||
    (referencedColumnSchema
      ? postgresAdapter.inferColumnType(referencedColumnSchema)
      : 'varchar(255)')

  return pipe(
    schema['entries'][key as string] as T['entries'][K],
    metadata({
      kind: 'reference',
      schema: schemaTitle || '',
      table: tableMeta?.name || '',
      key: key as string,
      dataType,
    }),
  )
}

/**
 * Type guard for reference metadata (`kind: 'reference'`).
 *
 * @param metadata - Value to check
 * @returns `true` if `metadata` is `ReferenceMetadata`
 *
 * @example
 * ```ts
 * if (isReferenceMetadata(meta)) console.log(meta.table, meta.key)
 * ```
 */
export function isReferenceMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is ReferenceMetadata {
  return metadata !== undefined && metadata.kind === 'reference'
}

/**
 * Reads reference metadata from a schema, unwrapping nullability wrappers first.
 *
 * @param schema - Column schema that may include `references()` metadata
 * @returns Reference metadata, or `undefined` if none
 *
 * @example
 * ```ts
 * const meta = getReferenceMetadata(PostSchema.entries.authorId)
 * // { kind: 'reference', table: 'users', key: 'id', ... }
 * ```
 */
export function getReferenceMetadata(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): ReferenceMetadata | undefined {
  const schemaMetadata = getMetadata(unwrapWrapper(schema)) as
    | Record<string, unknown>
    | undefined
  return isReferenceMetadata(schemaMetadata) ? schemaMetadata : undefined
}
