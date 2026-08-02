import type {
  InferOutput,
  MetadataAction,
  ObjectEntries,
  ObjectSchema,
  SchemaWithPipe,
  TitleAction,
} from 'valibot'
import { getMetadata, metadata, pipe } from 'valibot'

import type { AnySchema } from '@/types/schema'

import { findSchemaMetadata } from './metadata'
import { isTableMetadata } from './table'
import type { ReferenceMetadata, ReferentialAction } from './types'

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
 * Type guard for table handle objects (checks for `getSchema` and `getTableMetadata`).
 *
 * @example
 *   if (isReferenceTargetHandle(value)) {
 *     const meta = value.getTableMetadata()
 *   }
 *
 * @param value - Value to check.
 *
 * @returns `true` if `value` is a reference target handle
 */
function isReferenceTargetHandle(value: ReferenceTarget): value is ReferenceTargetHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ReferenceTargetHandle).getSchema === 'function' &&
    typeof (value as ReferenceTargetHandle).getTableMetadata === 'function'
  )
}

type ReferenceHandleSchemaEntries<T extends ReferenceTargetHandle> = ReturnType<
  T['getSchema']
>['entries']

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
      target: {
        relation: {
          ...(pgSchema === undefined
            ? {}
            : { namespace: [{ role: 'schema' as const, spelling: pgSchema }] }),
          relation: tableName,
        },
        column: key as string,
      },
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
  return findSchemaMetadata<ReferenceMetadata>(schema, 'reference')
}
