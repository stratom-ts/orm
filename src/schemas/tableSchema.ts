import type {
  MetadataAction,
  ObjectEntries,
  ObjectSchema,
  SchemaWithPipe,
  TitleAction,
} from 'valibot'
import type { TableMetadata } from './actions/types'

/** Valibot object schema with `title()` and `table()` metadata. */
export type TableSchema<N extends string = string> = SchemaWithPipe<
  readonly [
    ObjectSchema<ObjectEntries, undefined>,
    TitleAction<unknown, string>,
    MetadataAction<unknown, TableMetadata<N>>,
  ]
>
