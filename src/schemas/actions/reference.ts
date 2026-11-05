import type {
  InferInput,
  InferOutput,
  MetadataAction,
  ObjectEntries,
  ObjectSchema,
  SchemaWithPipe,
  TitleAction,
} from 'valibot'
import { getMetadata, metadata, pipe } from 'valibot'

import type { AnySchema } from '@/types/schema'
import { SchemaError } from '@/utils/error'

import type { LazyReferenceMetadata } from './lazyReference'
import { createLazyReferenceMetadata } from './lazyReference'
import { findSchemaMetadata } from './metadata'
import { isTableMetadata } from './table'
import type { ReferenceMetadata, ReferentialAction } from './types'

/** Minimal table-handle shape accepted by `reference()` (avoids circular imports). */
type ReferenceTargetHandle<TEntries extends ObjectEntries = ObjectEntries> = {
  /**
   * Returns the table's original Valibot schema for validation and metadata lookup.
   *
   * @returns The table's original Valibot schema for validation and metadata lookup.
   */
  getSchema(): ReferenceTargetSchema<TEntries>
  /**
   * Returns the relation, primary-key, index, and ownership metadata attached to the
   * table.
   *
   * @returns The relation, primary-key, index, and ownership metadata attached to the
   *   table.
   */
  getTableMetadata(): {
    relation: ReferenceMetadata['target']['relation']
  }
}

/** Narrows column entries while allowing validation issues from additional columns. */
type ReferenceTargetSchema<TEntries extends ObjectEntries = ObjectEntries> = Omit<
  SchemaWithPipe<
    readonly [
      ObjectSchema<ObjectEntries, undefined>,
      TitleAction<unknown, string>,
      MetadataAction<unknown, Record<string, unknown>>,
    ]
  >,
  'entries'
> & { entries: TEntries }

/** Table handle or raw schema exposing the declared column schemas for a reference. */
type ReferenceTarget<TEntries extends ObjectEntries = ObjectEntries> =
  | ReferenceTargetSchema<TEntries>
  | ReferenceTargetHandle<TEntries>

type ReferenceOptions = {
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
function isReferenceTargetHandle(value: unknown): value is ReferenceTargetHandle {
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
 *       id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
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
function reference<T extends ReferenceTarget, K extends ReferenceColumnKey<T>>(
  tableOrSchema: T,
  key: K,
  options?: ReferenceOptions,
): ReferenceSchema<T, K>
function reference<
  S extends AnySchema,
  T extends ReferenceTarget,
  K extends ReferenceColumnKey<T>,
>(
  schema: S,
  target: () => T,
  key: K &
    (NonNullable<InferOutput<S>> extends NonNullable<InferOutput<ReferencedColumn<T, K>>>
      ? NonNullable<InferInput<S>> extends NonNullable<InferInput<ReferencedColumn<T, K>>>
        ? unknown
        : never
      : never),
  options?: ReferenceOptions,
): SchemaWithPipe<readonly [S, MetadataAction<InferOutput<S>, LazyReferenceMetadata>]>

function reference(
  tableOrSchema: ReferenceTarget | AnySchema,
  keyOrTarget: PropertyKey | (() => ReferenceTarget),
  optionsOrKey?: ReferenceOptions | PropertyKey,
  lazyOptions?: ReferenceOptions,
): unknown {
  if (typeof keyOrTarget === 'function') {
    return pipe(
      tableOrSchema as AnySchema,
      metadata(
        createLazyReferenceMetadata(keyOrTarget, optionsOrKey as string, lazyOptions),
      ),
    )
  }

  const key = keyOrTarget
  const options = optionsOrKey as ReferenceOptions | undefined
  const target = tableOrSchema as ReferenceTarget
  const schema: ReferenceTargetSchema = isReferenceTargetHandle(target)
    ? target.getSchema()
    : target

  const schemaMetadata = getMetadata(schema) as Record<string, unknown>
  const tableMeta = isTableMetadata(schemaMetadata) ? schemaMetadata : null

  const tableInfo = isReferenceTargetHandle(target) ? target.getTableMetadata() : null

  const targetRelation = isReferenceTargetHandle(target)
    ? tableInfo?.relation
    : tableMeta?.relation

  if (targetRelation === undefined) {
    throw new SchemaError({ message: 'reference target is missing relation metadata' })
  }

  if (!Object.hasOwn(schema.entries, key)) {
    throw new SchemaError({
      message: `Reference target application column ${JSON.stringify(key)} is not defined`,
    })
  }

  return pipe(
    schema.entries[key as string] as never,
    metadata({
      kind: 'reference',
      target: {
        relation: targetRelation,
        column: key as string,
      },
      ...(options?.onDelete !== undefined ? { onDelete: options.onDelete } : {}),
      ...(options?.onUpdate !== undefined ? { onUpdate: options.onUpdate } : {}),
    }),
  )
}

/**
 * Type guard for reference metadata (`kind: 'reference'`).
 *
 * @example
 *   if (isReferenceMetadata(meta)) console.log(meta.target)
 *
 * @param metadata - Value to check.
 *
 * @returns `true` if `metadata` is `ReferenceMetadata`
 */
function isReferenceMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is ReferenceMetadata {
  return metadata?.kind === 'reference'
}

/**
 * Reads reference metadata from a schema, unwrapping nullability wrappers first.
 *
 * @example
 *   const meta = getReferenceMetadata(PostSchema.entries.authorId)
 *   // { kind: 'reference', target: { relation: { relation: 'users' }, column: 'id' } }
 *
 * @param schema - Column schema that may include `reference()` metadata.
 *
 * @returns Reference metadata, or `undefined` if none
 */
function getReferenceMetadata(schema: AnySchema): ReferenceMetadata | undefined {
  const metadata = findSchemaMetadata<ReferenceMetadata | LazyReferenceMetadata>(schema, [
    'reference',
    'lazy-reference',
  ])

  return metadata?.kind === 'reference' ? metadata : undefined
}

type ReferenceColumnKey<T extends ReferenceTarget> = T extends ReferenceTargetHandle
  ? keyof ReferenceHandleSchemaEntries<T>
  : T extends ReferenceTargetSchema
    ? keyof T['entries']
    : never

type ReferencedColumn<
  T extends ReferenceTarget,
  K extends PropertyKey,
> = T extends ReferenceTargetHandle
  ? ReferenceHandleSchemaEntries<T>[K & keyof ReferenceHandleSchemaEntries<T>]
  : T extends ReferenceTargetSchema
    ? T['entries'][K & keyof T['entries']]
    : never

type ReferenceSchema<T extends ReferenceTarget, K extends PropertyKey> = SchemaWithPipe<
  readonly [
    ReferencedColumn<T, K>,
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
>

export type { ReferenceTarget, ReferenceOptions }

export { reference, isReferenceMetadata, getReferenceMetadata }
