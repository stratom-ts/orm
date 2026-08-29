import type { InferOutput } from 'valibot'

import type { RelationIdentityInput, TableMetadata, TableSchema } from '@/schemas'

/** Runtime brand for table handles returned by `defineTable`. */
export const TABLE_HANDLE = Symbol.for('stratom.TableHandle')

/** Stable typed reference to a table column (for where/select/join/orderBy). */
export type ColumnRef<
  TTable extends string = string,
  TColumn extends string = string,
  TType = unknown,
  TRelation extends RelationIdentityInput = RelationIdentityInput & {
    relation: TTable
  },
> = {
  readonly relation: TRelation
  readonly column: TColumn
  readonly __type: TType
}

type ColumnEntries<S extends TableSchema> = S['entries']

export type SchemaNameOf<S extends TableSchema> =
  S extends TableSchema<infer N> ? N : string

export type ColumnRefsOf<
  S extends TableSchema,
  TRelation extends RelationIdentityInput = RelationIdentityInput,
> = {
  readonly [K in keyof ColumnEntries<S> & string]: ColumnRef<
    SchemaNameOf<S>,
    K,
    InferOutput<ColumnEntries<S>[K]>,
    TRelation
  >
}

type HandleTableMetadata<
  TName extends string,
  TRelation extends RelationIdentityInput,
> = TableMetadata<TName, TRelation>

/**
 * Table handle produced by `defineTable` — the unit accepted by `createDatabase` /
 * `db.from`.
 */
export type TableHandle<
  S extends TableSchema = TableSchema,
  TRelation extends RelationIdentityInput = RelationIdentityInput,
> = {
  readonly [TABLE_HANDLE]: true
  /** Underlying Valibot table schema (source of validation + column metadata). */
  getSchema(): S
  /** Table metadata from `table()` / `getTableMetadata()`. */
  getTableMetadata(): HandleTableMetadata<SchemaNameOf<S>, TRelation>
} & ColumnRefsOf<S, TRelation>
