import type {
  InferOutput,
  MetadataAction,
  ObjectEntries,
  ObjectSchema,
  SchemaWithPipe,
  TitleAction,
} from 'valibot'
import { getMetadata, metadata, pipe } from 'valibot'

import { postgresDialect } from '@/dialects'
import type { AnySchema } from '@/types/schema'

import { getColumnMetadata } from './column'
import { isTableMetadata } from './table'
import type { ReferenceMetadata, ReferentialAction } from './types'

interface WrapperSchema {
  wrapped: AnySchema
}

/** Minimal table-handle shape accepted by `reference()` (avoids circular imports). */
type ReferenceTargetHandle = {
  getSchema(): SchemaWithPipe<
    readonly [
      ObjectSchema<ObjectEntries, undefined>,
      TitleAction<unknown, string>,
      MetadataAction<unknown, Record<string, unknown>>,
    ]
  >
  getTableMetadata(): { name: string; schema?: string }
}

type ReferenceTargetSchema = SchemaWithPipe<
  readonly [
    ObjectSchema<ObjectEntries, undefined>,
    TitleAction<unknown, string>,
    MetadataAction<unknown, Record<string, unknown>>,
  ]
>

export type ReferenceTarget = ReferenceTargetSchema | ReferenceTargetHandle

export type ReferenceOptions = {
  onDelete?: ReferentialAction
  onUpdate?: ReferentialAction
}

/**
 * Unwraps optional/nullable/nullish wrappers while preserving pipes.
 *
 * @example
 *   const inner = unwrapWrapper(optional(pipe(string(), column({ type: 'uuid' }))))
 *
 * @param schema - Schema that may be wrapped.
 *
 * @returns Inner schema with pipe structure intact
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

function isReferenceTargetHandle(value: ReferenceTarget): value is ReferenceTargetHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReferenceTargetHandle).getSchema === 'function' &&
    typeof (value as ReferenceTargetHandle).getTableMetadata === 'function'
  )
}

/**
 * Builds a foreign-key column schema from a referenced table schema/handle and key.
 *
 * @example
 *   const PostSchema = pipe(
 *     object({
 *       id: pipe(string(), column({ type: 'uuid' })),
 *       authorId: reference(UserSchema, 'id', { onDelete: 'cascade' }),
 *     }),
 *     title('posts'),
 *     table({ name: 'posts', primaryKey: 'id' }),
 *   )
 *
 * @param tableOrSchema - Referenced table schema or `defineTable` handle.
 * @param key - Column on the referenced table.
 * @param options - Optional FK actions (`onDelete` / `onUpdate`)
 *
 * @returns Piped schema for the FK column with reference metadata
 */
type ReferenceHandleSchemaEntries<T extends ReferenceTargetHandle> = ReturnType<
  T['getSchema']
>['entries']

export function reference<
  T extends ReferenceTarget,
  K extends (T extends ReferenceTargetHandle
    ? keyof ReferenceHandleSchemaEntries<T>
    : T extends ReferenceTargetSchema
      ? keyof T['entries']
      : never),
>(
  tableOrSchema: T,
  key: K,
  options?: ReferenceOptions,
): SchemaWithPipe<
  readonly [
    T extends ReferenceTargetHandle
      ? ReferenceHandleSchemaEntries<T>[K & keyof ReferenceHandleSchemaEntries<T>]
      : T extends ReferenceTargetSchema
        ? T['entries'][K & keyof T['entries']]
        : never,
    MetadataAction<
      InferOutput<
        T extends ReferenceTargetHandle
          ? ReferenceHandleSchemaEntries<T>[K & keyof ReferenceHandleSchemaEntries<T>]
          : T extends ReferenceTargetSchema
            ? T['entries'][K & keyof T['entries']]
            : never
      >,
      ReferenceMetadata
    >,
  ]
> {
  const schema: ReferenceTargetSchema = isReferenceTargetHandle(tableOrSchema)
    ? tableOrSchema.getSchema()
    : tableOrSchema

  const schemaMetadata = getMetadata(schema) as Record<string, unknown>
  const tableMeta = isTableMetadata(schemaMetadata) ? schemaMetadata : null

  const referencedColumnSchema = schema.entries[key as string] as AnySchema | undefined

  const referencedColumnMetadata = referencedColumnSchema
    ? getColumnMetadata(referencedColumnSchema)
    : undefined

  const dataType =
    referencedColumnMetadata?.type ||
    (referencedColumnSchema
      ? postgresDialect.inferColumnType(referencedColumnSchema)
      : 'varchar(255)')

  const tableInfo = isReferenceTargetHandle(tableOrSchema)
    ? tableOrSchema.getTableMetadata()
    : null

  const tableName = tableInfo?.name ?? tableMeta?.name ?? ''

  const pgSchema = tableInfo ? tableInfo.schema : tableMeta?.schema

  return pipe(
    schema.entries[key as string] as never,
    metadata({
      kind: 'reference',
      ...(pgSchema !== undefined ? { schema: pgSchema } : {}),
      table: tableName,
      key: key as string,
      dataType,
      ...(options?.onDelete !== undefined ? { onDelete: options.onDelete } : {}),
      ...(options?.onUpdate !== undefined ? { onUpdate: options.onUpdate } : {}),
    }),
  ) as never
}

/**
 * Type guard for reference metadata (`kind: 'reference'`).
 *
 * @example
 *   if (isReferenceMetadata(meta)) console.log(meta.table, meta.key)
 *
 * @param metadata - Value to check.
 *
 * @returns `true` if `metadata` is `ReferenceMetadata`
 */
export function isReferenceMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is ReferenceMetadata {
  return metadata !== undefined && metadata.kind === 'reference'
}

/**
 * Reads reference metadata from a schema, unwrapping nullability wrappers first.
 *
 * @example
 *   const meta = getReferenceMetadata(PostSchema.entries.authorId)
 *   // { kind: 'reference', table: 'users', key: 'id', ... }
 *
 * @param schema - Column schema that may include `reference()` metadata.
 *
 * @returns Reference metadata, or `undefined` if none
 */
export function getReferenceMetadata(schema: AnySchema): ReferenceMetadata | undefined {
  const schemaMetadata = getMetadata(unwrapWrapper(schema)) as
    | Record<string, unknown>
    | undefined
  return isReferenceMetadata(schemaMetadata) ? schemaMetadata : undefined
}
