import type { InferOutput } from 'valibot'

import type { TableMetadata, TableSchema } from '@/schemas'

/** Runtime brand for table handles returned by `defineTable`. */
export const TABLE_HANDLE = Symbol.for('stratom.TableHandle')

/** Stable typed reference to a table column (for where/select/join/orderBy). */
export type ColumnRef<
  TTable extends string = string,
  TColumn extends string = string,
  TType = unknown,
  TSchema extends string | undefined = string | undefined,
> = {
  readonly table: TTable
  readonly column: TColumn
  readonly schema: TSchema
  readonly __type: TType
}

type ColumnEntries<S extends TableSchema> = S['entries']

export type SchemaNameOf<S extends TableSchema> =
  S extends TableSchema<infer N> ? N : string

export type ColumnRefsOf<
  S extends TableSchema,
  TSchema extends string | undefined = string | undefined,
> = {
  readonly [K in keyof ColumnEntries<S> & string]: ColumnRef<
    SchemaNameOf<S>,
    K,
    InferOutput<ColumnEntries<S>[K]>,
    TSchema
  >
}

type HandleTableMetadata<
  TName extends string,
  TSchema extends string | undefined,
> = TSchema extends string
  ? TableMetadata<TName> & { schema: TSchema }
  : Omit<TableMetadata<TName>, 'schema'> & { schema?: undefined }

/**
 * Table handle produced by `defineTable` — the unit accepted by `createDatabase` /
 * `db.from`.
 */
export type TableHandle<
  S extends TableSchema = TableSchema,
  TSchema extends string | undefined = string | undefined,
> = {
  readonly [TABLE_HANDLE]: true
  /** Underlying Valibot table schema (source of validation + column metadata). */
  getSchema(): S
  /** Table metadata from `table()` / `getTableMetadata()`. */
  getTableMetadata(): HandleTableMetadata<SchemaNameOf<S>, TSchema>
} & ColumnRefsOf<S, TSchema>
