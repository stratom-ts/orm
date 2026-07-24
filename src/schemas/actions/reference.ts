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
import { isTableMetadata } from './table'
import { getColumnMetadata } from './column'
import type { ReferenceMetadata } from './types'

/**
 * A metadata action for references definitions.
 * @param schema - The schema to reference
 * @param key - The key to reference
 * @returns A Valibot MetadataAction that can be used in a pipe
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

  const dataType = referencedColumnMetadata?.type || 'varchar(255)'

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
 * Type guard to check if metadata is reference metadata.
 */
export function isReferenceMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is ReferenceMetadata {
  return metadata !== undefined && metadata.kind === 'reference'
}

/**
 * Extracts reference metadata from a schema if it exists.
 */
export function getReferenceMetadata(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): ReferenceMetadata | undefined {
  const schemaMetadata = getMetadata(schema) as
    | Record<string, unknown>
    | undefined
  return isReferenceMetadata(schemaMetadata) ? schemaMetadata : undefined
}
