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
import { isTableMetadata } from './table'
import { getColumnMetadata } from './column'
import type { ReferenceMetadata, ReferentialAction } from './types'

interface WrapperSchema {
  wrapped: AnySchema
}

/** Minimal table-handle shape accepted by `reference()` (avoids circular imports). */
type ReferenceTargetHandle = {
  readonly name: string
  readonly schema?: string
  readonly definition: SchemaWithPipe<
    readonly [
      ObjectSchema<ObjectEntries, undefined>,
      TitleAction<unknown, string>,
      MetadataAction<unknown, Record<string, unknown>>,
    ]
  >
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
 * @param schema - Schema that may be wrapped
 * @returns Inner schema with pipe structure intact
 *
 * @example
 * ```ts
 * const inner = unwrapWrapper(optional(pipe(string(), column({ type: 'uuid' }))))
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

function isReferenceTargetHandle(
  value: ReferenceTarget,
): value is ReferenceTargetHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'definition' in value &&
    'name' in value
  )
}

/**
 * Builds a foreign-key column schema from a referenced table schema/handle and key.
 *
 * @param tableOrSchema - Referenced table schema or `defineTable` handle
 * @param key - Column on the referenced table
 * @param options - Optional FK actions (`onDelete` / `onUpdate`)
 * @returns Piped schema for the FK column with reference metadata
 *
 * @example
 * ```ts
 * const PostSchema = pipe(
 *   object({
 *     id: pipe(string(), column({ type: 'uuid' })),
 *     authorId: reference(UserSchema, 'id', { onDelete: 'cascade' }),
 *   }),
 *   title('posts'),
 *   table({ name: 'posts', primaryKey: 'id' }),
 * )
 * ```
 */
export function reference<
  T extends ReferenceTarget,
  K extends T extends ReferenceTargetHandle
    ? keyof T['definition']['entries']
    : T extends ReferenceTargetSchema
      ? keyof T['entries']
      : never,
>(
  tableOrSchema: T,
  key: K,
  options?: ReferenceOptions,
): SchemaWithPipe<
  readonly [
    T extends ReferenceTargetHandle
      ? T['definition']['entries'][K & keyof T['definition']['entries']]
      : T extends ReferenceTargetSchema
        ? T['entries'][K & keyof T['entries']]
        : never,
    MetadataAction<
      InferOutput<
        T extends ReferenceTargetHandle
          ? T['definition']['entries'][K & keyof T['definition']['entries']]
          : T extends ReferenceTargetSchema
            ? T['entries'][K & keyof T['entries']]
            : never
      >,
      ReferenceMetadata
    >,
  ]
> {
  const schema: ReferenceTargetSchema = isReferenceTargetHandle(tableOrSchema)
    ? tableOrSchema.definition
    : tableOrSchema

  const schemaMetadata = getMetadata(schema) as Record<string, unknown>
  const tableMeta = isTableMetadata(schemaMetadata) ? schemaMetadata : null

  const referencedColumnSchema = schema.entries[key as string] as
    | AnySchema
    | undefined

  const referencedColumnMetadata = referencedColumnSchema
    ? getColumnMetadata(referencedColumnSchema)
    : undefined

  const dataType =
    referencedColumnMetadata?.type ||
    (referencedColumnSchema
      ? postgresDialect.inferColumnType(referencedColumnSchema)
      : 'varchar(255)')

  const tableName = isReferenceTargetHandle(tableOrSchema)
    ? tableOrSchema.name
    : tableMeta?.name || ''

  const pgSchema = isReferenceTargetHandle(tableOrSchema)
    ? tableOrSchema.schema
    : tableMeta?.schema

  return pipe(
    schema.entries[key as string] as never,
    metadata({
      kind: 'reference',
      ...(pgSchema !== undefined ? { schema: pgSchema } : {}),
      table: tableName,
      key: key as string,
      dataType,
      ...(options?.onDelete !== undefined
        ? { onDelete: options.onDelete }
        : {}),
      ...(options?.onUpdate !== undefined
        ? { onUpdate: options.onUpdate }
        : {}),
    }),
  ) as never
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
 * @param schema - Column schema that may include `reference()` metadata
 * @returns Reference metadata, or `undefined` if none
 *
 * @example
 * ```ts
 * const meta = getReferenceMetadata(PostSchema.entries.authorId)
 * // { kind: 'reference', table: 'users', key: 'id', ... }
 * ```
 */
export function getReferenceMetadata(
  schema: AnySchema,
): ReferenceMetadata | undefined {
  const schemaMetadata = getMetadata(unwrapWrapper(schema)) as
    | Record<string, unknown>
    | undefined
  return isReferenceMetadata(schemaMetadata) ? schemaMetadata : undefined
}
