import type { InferOutput } from 'valibot'
import type { AnySchema } from './schema'
import type { ColumnRef } from './tableHandle'
import type { TableSchema } from '@/schemas'

type DBType<T> = T extends undefined ? never : T

// ---------------------------------------------------------------------------
// Schema unwrapping utilities (type-level mirrors of the runtime helpers)
// ---------------------------------------------------------------------------

type UnwrapSchema<S> = S extends {
  kind: 'schema'
  type: 'optional'
  wrapped: infer W
}
  ? UnwrapSchema<W>
  : S extends { kind: 'schema'; type: 'nullable'; wrapped: infer W }
    ? UnwrapSchema<W>
    : S extends { kind: 'schema'; type: 'nullish'; wrapped: infer W }
      ? UnwrapSchema<W>
      : S extends { kind: 'schema'; type: 'non_optional'; wrapped: infer W }
        ? UnwrapSchema<W>
        : S extends { kind: 'schema'; type: 'non_nullable'; wrapped: infer W }
          ? UnwrapSchema<W>
          : S extends { kind: 'schema'; type: 'non_nullish'; wrapped: infer W }
            ? UnwrapSchema<W>
            : S

type ColumnMetaOf<S> =
  UnwrapSchema<S> extends {
    pipe: readonly [...unknown[], { kind: 'metadata'; metadata: infer M }]
  }
    ? M
    : never

// NOTE: `[ColumnMetaOf<S>] extends [never]` guards against columns with no
// `column()` metadata. Without the guard, `ColumnMetaOf<S>` is `never`, and
// `never extends X` is `true`, so metadata-less (type-inferred) columns would
// be misclassified — e.g. treated as generated-always and dropped from the
// insert/update views.
type IsGeneratedAlways<S> = [ColumnMetaOf<S>] extends [never]
  ? false
  : ColumnMetaOf<S> extends { kind: 'column'; generated: 'always' }
    ? true
    : false

type IsGeneratedByDefault<S> = [ColumnMetaOf<S>] extends [never]
  ? false
  : ColumnMetaOf<S> extends { kind: 'column'; generated: 'byDefault' }
    ? true
    : false

type IsReadonlyColumn<S> = [ColumnMetaOf<S>] extends [never]
  ? false
  : ColumnMetaOf<S> extends { kind: 'column'; readonly: true }
    ? true
    : false

type HasDefaultValue<S> = [ColumnMetaOf<S>] extends [never]
  ? false
  : ColumnMetaOf<S> extends { kind: 'column'; default: infer D }
    ? [D] extends [never]
      ? false
      : D extends undefined
        ? false
        : true
    : false

/** optional / nullish → omit-on-insert (not necessarily SQL NULL). */
type IsOptionalSchema<S> = S extends { kind: 'schema'; type: 'optional' }
  ? true
  : S extends { kind: 'schema'; type: 'nullish' }
    ? true
    : false

/** SQL NULL-capable: nullable / nullish only (not plain optional). */
type IsSqlNullableSchema<S> = S extends { kind: 'schema'; type: 'nullable' }
  ? true
  : S extends { kind: 'schema'; type: 'nullish' }
    ? true
    : false

type IsInsertOptional<S> =
  IsGeneratedAlways<S> extends true
    ? never
    : IsGeneratedByDefault<S> extends true
      ? true
      : HasDefaultValue<S> extends true
        ? true
        : IsOptionalSchema<S> extends true
          ? true
          : false

type NonNullColumnValue<S> = S extends AnySchema
  ? DBType<InferOutput<S>> extends infer V
    ? Exclude<V, null>
    : never
  : never

/**
 * Select value: SQL-nullable columns are `T | null`; optional-only stays non-null
 * (omit-on-insert with NOT NULL + default, or application always supplies a value).
 */
type SelectColumnValue<S> =
  IsSqlNullableSchema<S> extends true
    ? NonNullColumnValue<S> | null
    : NonNullColumnValue<S>

type InsertColumnValue<S> =
  IsSqlNullableSchema<S> extends true
    ? NonNullColumnValue<S> | null
    : NonNullColumnValue<S>

/**
 * Select view: full row as returned from the database.
 * Nested object columns without `reference` remain plain object (JSON-shaped).
 */
export type InferSelectFromSchema<S extends TableSchema> = {
  [K in keyof S['entries']]-?: SelectColumnValue<S['entries'][K]>
}

type RequiredInsertKeys<S extends TableSchema> = {
  [K in keyof S['entries']]-?: IsGeneratedAlways<S['entries'][K]> extends true
    ? never
    : IsInsertOptional<S['entries'][K]> extends true
      ? never
      : K
}[keyof S['entries']]

type OptionalInsertKeys<S extends TableSchema> = {
  [K in keyof S['entries']]-?: IsGeneratedAlways<S['entries'][K]> extends true
    ? never
    : IsInsertOptional<S['entries'][K]> extends true
      ? K
      : never
}[keyof S['entries']]

/**
 * Insert view: omit always-generated; optional defaults / byDefault / optional wrappers.
 */
export type InferInsertFromSchema<S extends TableSchema> = {
  [K in RequiredInsertKeys<S>]-?: InsertColumnValue<S['entries'][K]>
} & {
  [K in OptionalInsertKeys<S>]?: InsertColumnValue<S['entries'][K]>
}

/**
 * Update view: partial patch; omit readonly and always-generated columns.
 */
export type InferUpdateFromSchema<S extends TableSchema> = {
  [K in keyof S['entries'] as IsGeneratedAlways<S['entries'][K]> extends true
    ? never
    : IsReadonlyColumn<S['entries'][K]> extends true
      ? never
      : K]?: InsertColumnValue<S['entries'][K]>
}

/** Resolve a table schema from a handle (`definition`) or raw Valibot table schema. */
type SchemaOf<T> = T extends { definition: infer D }
  ? D extends TableSchema
    ? D
    : never
  : T extends TableSchema
    ? T
    : never

/**
 * Select row type for a table handle or Valibot table schema.
 */
export type InferSelect<T> = [SchemaOf<T>] extends [never]
  ? never
  : InferSelectFromSchema<SchemaOf<T>>

/**
 * Insert input type for a table handle or Valibot table schema.
 */
export type InferInsert<T> = [SchemaOf<T>] extends [never]
  ? never
  : InferInsertFromSchema<SchemaOf<T>>

/**
 * Update patch type for a table handle or Valibot table schema.
 */
export type InferUpdate<T> = [SchemaOf<T>] extends [never]
  ? never
  : InferUpdateFromSchema<SchemaOf<T>>

/** Column name from a `ColumnRef` or string literal used in select/returning lists. */
type SelectedColumnName<C> =
  C extends ColumnRef<string, infer N extends string>
    ? N
    : C extends string
      ? C
      : never

/** Table name on a handle (`name`) when available. */
type TableNameOf<T> = T extends { name: infer N extends string } ? N : never

/** Every field of `T` widened with `| null` (outer-join side). */
export type NullableFields<T> = {
  [K in keyof T]: T[K] | null
}

type MaybeJoinNullable<
  TValue,
  TTable extends string,
  TNullable extends string,
> = TTable extends TNullable ? TValue | null : TValue

type SelectedColumnBaseValue<T, C> =
  C extends ColumnRef<infer TTable, infer N extends string, infer TType>
    ? [TableNameOf<T>] extends [TTable]
      ? N extends keyof InferSelect<T>
        ? InferSelect<T>[N]
        : Exclude<TType, undefined>
      : Exclude<TType, undefined>
    : C extends string
      ? C extends keyof InferSelect<T>
        ? InferSelect<T>[C]
        : unknown
      : never

/**
 * Value type for one selected column item.
 * Same-table refs/strings use {@link InferSelect}; cross-table `ColumnRef`s use
 * the ref's payload (minus `undefined` from optional wrappers). Outer-join
 * nullable tables widen the value with `| null`.
 */
type SelectedColumnValue<T, C, TNullable extends string = never> =
  C extends ColumnRef<infer TTable, string, unknown>
    ? MaybeJoinNullable<SelectedColumnBaseValue<T, C>, TTable, TNullable>
    : C extends string
      ? MaybeJoinNullable<
          SelectedColumnBaseValue<T, C>,
          TableNameOf<T>,
          TNullable
        >
      : never

/**
 * Row type for a column-list `select` / `returning`: only the selected keys,
 * each required. Same-table columns match {@link InferSelect}; cross-table
 * `ColumnRef`s resolve from the ref; bare string names unknown on `T` stay
 * `unknown`. Pass `TNullable` (table-name union) for outer-join sides.
 */
export type InferSelectedColumns<
  T,
  TCols extends readonly (ColumnRef | string)[],
  TNullable extends string = never,
> = {
  [K in SelectedColumnName<TCols[number]>]-?: SelectedColumnValue<
    T,
    Extract<TCols[number], ColumnRef<string, K> | K>,
    TNullable
  >
}

/** `selectAll(side)` row fragment, nullable when that side is outer-joined. */
export type InferSelectAllSide<TSide, TNullable extends string = never> =
  TableNameOf<TSide> extends TNullable
    ? NullableFields<InferSelect<TSide>>
    : InferSelect<TSide>

/** Merge an additional selection into `TResult` once an explicit select exists. */
export type MergeSelection<
  HasSelection extends boolean,
  TResult,
  TNew,
> = HasSelection extends true ? TResult & TNew : TNew
