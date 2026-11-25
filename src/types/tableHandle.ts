import type { RelationIdentityInput, TableMetadata, TableSchema } from '@/schemas'

import type { InferSelectFromSchema } from './views'

/** Runtime brand for table handles returned by `defineTable`. */
const TABLE_HANDLE = Symbol.for('stratom.TableHandle')

/** Stable typed reference to a table column (for where/select/join/orderBy). */
type ColumnRef<
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

type SchemaNameOf<S extends TableSchema> = S extends TableSchema<infer N> ? N : string

type ColumnRefsOf<
  S extends TableSchema,
  TRelation extends RelationIdentityInput = RelationIdentityInput,
> = {
  readonly [K in keyof ColumnEntries<S> & string]: ColumnRef<
    SchemaNameOf<S>,
    K,
    InferSelectFromSchema<S>[K],
    TRelation
  >
}

type HandleTableMetadata<
  TName extends string,
  TRelation extends RelationIdentityInput,
> = TableMetadata<TName, TRelation>

/**
 * Table handle produced by `defineTable` — the unit accepted by `createDatabase` /
 * `db.from`. A schema with arbitrary column names omits the column map, which
 * would otherwise treat handle methods as columns.
 */
type TableHandle<
  S extends TableSchema = TableSchema,
  TRelation extends RelationIdentityInput = RelationIdentityInput,
> = {
  readonly [TABLE_HANDLE]: true
  /** Underlying Valibot table schema (source of validation + column metadata). */
  getSchema(): S
  /** Table metadata from `table()` / `getTableMetadata()`. */
  getTableMetadata(): HandleTableMetadata<SchemaNameOf<S>, TRelation>
} & (string extends keyof ColumnEntries<S> ? unknown : ColumnRefsOf<S, TRelation>)

/** Internal read-source interface; it does not grant physical-table authority. */
type ReadSource = {
  getSchema(): Pick<TableSchema, 'entries'>
  getTableMetadata(): Pick<TableMetadata, 'name' | 'relation'>
}

export type { ReadSource }

export type { ColumnRef, SchemaNameOf, ColumnRefsOf, TableHandle }
export { TABLE_HANDLE }
