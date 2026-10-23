import type { InferInput, InferOutput } from 'valibot'

import type { ColumnGeneration, TableSchema } from '@/schemas'
import type { Prettify } from '@/types/prettify'

import type { AnySchema } from './schema'
import type { ColumnRef } from './tableHandle'

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
    : S extends { kind: 'schema'; type: 'exact_optional'; wrapped: infer W }
      ? UnwrapSchema<W>
      : S extends { kind: 'schema'; type: 'undefinedable'; wrapped: infer W }
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

type ColumnGenerationOf<S> =
  ColumnMetaOf<S> extends { generation: infer G } ? Extract<G, ColumnGeneration> : never

// NOTE: `[ColumnMetaOf<S>] extends [never]` guards against columns with no
// `column()` metadata. Without the guard, `ColumnMetaOf<S>` is `never`, and
// `never extends X` is `true`, so metadata-less (type-inferred) columns would
// be misclassified — e.g. treated as generated-always and dropped from the
// insert/update views.
type IsGeneratedAlways<S> = [ColumnMetaOf<S>] extends [never]
  ? false
  : [ColumnGenerationOf<S>] extends [never]
    ? false
    : ColumnGenerationOf<S> extends { kind: 'identity'; mode: 'always' }
      ? true
      : ColumnGenerationOf<S> extends { kind: 'computed' }
        ? true
        : false

type IsGeneratedByDefault<S> = [ColumnMetaOf<S>] extends [never]
  ? false
  : [ColumnGenerationOf<S>] extends [never]
    ? false
    : ColumnGenerationOf<S> extends { kind: 'identity'; mode: 'byDefault' }
      ? true
      : false

type IsReadonlyColumn<S> = [ColumnMetaOf<S>] extends [never]
  ? false
  : ColumnMetaOf<S> extends { kind: 'column'; readonly: true }
    ? true
    : false

type HasDefaultValue<S> = [ColumnMetaOf<S>] extends [never]
  ? false
  : ColumnMetaOf<S> extends { kind: 'column'; databaseDefault: infer D }
    ? [D] extends [never]
      ? false
      : D extends undefined
        ? false
        : true
    : false

/** Optional / nullish → omit-on-insert (not necessarily SQL NULL). */
type IsOptionalSchema<S> = S extends { kind: 'schema'; type: 'optional' }
  ? true
  : S extends { kind: 'schema'; type: 'exact_optional' }
    ? true
    : S extends { kind: 'schema'; type: 'nullish' }
      ? true
      : S extends {
            kind: 'schema'
            type: 'undefinedable' | 'non_optional' | 'non_nullable' | 'non_nullish'
          }
        ? false
        : S extends { kind: 'schema'; type: 'nullable'; wrapped: infer W }
          ? IsOptionalSchema<W>
          : false

type IsSqlNullablePipe<
  TItems extends readonly unknown[],
  TNullable extends boolean,
> = TItems extends readonly [infer TItem, ...infer TRest]
  ? IsSqlNullablePipe<
      TRest,
      TItem extends { kind: 'schema' }
        ? IsSqlNullableSchema<TItem>
        : TItem extends {
              kind: 'transformation'
              type: 'to_number' | 'to_boolean' | 'parse_boolean' | 'to_date' | 'to_string'
            }
          ? false
          : TNullable
    >
  : TNullable

/** SQL NULL-capable after wrappers and pipeline actions in their runtime order. */
type IsSqlNullableSchema<S> = S extends { pipe: readonly [infer TFirst, ...infer TRest] }
  ? IsSqlNullablePipe<TRest, IsSqlNullableSchema<TFirst>>
  : S extends { kind: 'schema'; type: 'nullable' }
    ? true
    : S extends { kind: 'schema'; type: 'nullish' }
      ? true
      : S extends { kind: 'schema'; type: 'non_nullable' | 'non_nullish' }
        ? false
        : S extends {
              kind: 'schema'
              type: 'optional' | 'exact_optional' | 'undefinedable' | 'non_optional'
              wrapped: infer W
            }
          ? IsSqlNullableSchema<W>
          : S extends {
                kind: 'schema'
                type: 'union' | 'variant' | 'intersect' | 'null' | 'literal'
              }
            ? S extends AnySchema
              ? null extends InferOutput<S>
                ? true
                : false
              : false
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

type NullableOutputValue<S> = S extends AnySchema ? Extract<InferOutput<S>, null> : never

/**
 * Select value: SQL-nullable columns are `T | null`; optional-only stays non-null
 * (omit-on-insert with NOT NULL + default, or application always supplies a value).
 */
type SelectColumnValue<S> =
  IsSqlNullableSchema<S> extends true
    ? NonNullColumnValue<S> | null
    : NonNullColumnValue<S> | NullableOutputValue<S>

type InsertColumnValue<S> = S extends AnySchema
  ? DBType<InferInput<S>> | (IsSqlNullableSchema<S> extends true ? null : never)
  : never

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

/** Insert view: omit always-generated; optional defaults / byDefault / optional wrappers. */
export type InferInsertFromSchema<S extends TableSchema> = {
  [K in RequiredInsertKeys<S>]-?: InsertColumnValue<S['entries'][K]>
} & {
  [K in OptionalInsertKeys<S>]?: InsertColumnValue<S['entries'][K]>
}

/** Update view: partial patch; omit readonly and always-generated columns. */
export type InferUpdateFromSchema<S extends TableSchema> = {
  [
    K in keyof S['entries'] as IsGeneratedAlways<S['entries'][K]> extends true
      ? never
      : IsReadonlyColumn<S['entries'][K]> extends true
        ? never
        : K
  ]?: InsertColumnValue<S['entries'][K]>
}

/** Resolve a table schema from a handle (`getSchema`) or raw Valibot table schema. */
type SchemaOf<T> = T extends {
  /**
   * Returns the table's original Valibot schema for validation and metadata lookup.
   *
   * @returns The table's original Valibot schema for validation and metadata lookup.
   */
  getSchema(): infer D
}
  ? D extends TableSchema
    ? D
    : never
  : T extends TableSchema
    ? T
    : never

/** Select row type for a table handle or Valibot table schema. */
export type InferSelect<T> = [SchemaOf<T>] extends [never]
  ? never
  : Prettify<InferSelectFromSchema<SchemaOf<T>>>

/** Insert input type for a table handle or Valibot table schema. */
export type InferInsert<T> = [SchemaOf<T>] extends [never]
  ? never
  : Prettify<InferInsertFromSchema<SchemaOf<T>>>

/** Update patch type for a table handle or Valibot table schema. */
export type InferUpdate<T> = [SchemaOf<T>] extends [never]
  ? never
  : Prettify<InferUpdateFromSchema<SchemaOf<T>>>

/** Column name from a `ColumnRef` or string literal used in select/returning lists. */
type SelectedColumnName<C> =
  C extends ColumnRef<string, infer N extends string> ? N : C extends string ? C : never

/** Table name on a handle (`getTableMetadata().name`) when available. */
export type TableNameOf<T> = T extends {
  /**
   * Returns the relation, primary-key, index, and ownership metadata attached to the
   * table.
   *
   * @returns The relation, primary-key, index, and ownership metadata attached to the
   *   table.
   */
  getTableMetadata(): { name: infer N extends string }
}
  ? N
  : never

/** Authored relation identity used to distinguish same-named relations. */
export type TableIdentityOf<T> = T extends {
  /**
   * Returns the relation, primary-key, index, and ownership metadata attached to the
   * table.
   *
   * @returns The relation, primary-key, index, and ownership metadata attached to the
   *   table.
   */
  getTableMetadata(): infer TMetadata
}
  ? TMetadata extends { relation: infer TRelation }
    ? TRelation
    : never
  : never

/** Every field of `T` widened with `| null` (outer-join side). */
export type NullableFields<T> = {
  [K in keyof T]: T[K] | null
}

type MaybeJoinNullable<TValue, TIdentity, TNullable> = TIdentity extends TNullable
  ? TValue | null
  : TIdentity extends { relation: infer TRelation }
    ? TRelation extends Extract<TNullable, string>
      ? TValue | null
      : TValue
    : TValue

type ColumnIdentity<C> =
  C extends ColumnRef<string, string, unknown, infer TRelation> ? TRelation : never

type SelectedColumnBaseValue<T, C> =
  C extends ColumnRef<string, infer N extends string, infer TType>
    ? [TableIdentityOf<T>] extends [ColumnIdentity<C>]
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
type SelectedColumnValue<T, C, TNullable = never> = C extends ColumnRef
  ? MaybeJoinNullable<SelectedColumnBaseValue<T, C>, ColumnIdentity<C>, TNullable>
  : C extends string
    ? MaybeJoinNullable<SelectedColumnBaseValue<T, C>, TableIdentityOf<T>, TNullable>
    : never

/**
 * Row type for a column-list `select` / `returning`: only the selected keys,
 * each required. Same-table columns match {@link InferSelect}; cross-table
 * `ColumnRef`s resolve from the ref; bare string names unknown on `T` stay
 * `unknown`. Pass `TNullable` (table-identity union) for outer-join sides.
 */
export type InferSelectedColumns<
  T,
  TCols extends readonly (ColumnRef | string)[],
  TNullable = never,
> = {
  [K in SelectedColumnName<TCols[number]>]-?: SelectedColumnValue<
    T,
    Extract<TCols[number], ColumnRef<string, K> | K>,
    TNullable
  >
}

/** `selectAll(side)` row fragment, nullable when that side is outer-joined. */
export type InferSelectAllSide<TSide, TNullable = never> =
  TableIdentityOf<TSide> extends TNullable
    ? NullableFields<InferSelect<TSide>>
    : InferSelect<TSide>

/** Merge an additional selection into `TResult` once an explicit select exists. */
export type MergeSelection<
  HasSelection extends boolean,
  TResult,
  TNew,
> = HasSelection extends true ? TResult & TNew : TNew

/**
 * Implicit `select *` after a join includes the joined table's columns.
 * Once the consumer has narrowed with `.select` / `.selectAll`, joins only
 * affect row filtering / nullability tracking — not the projection type.
 */
export type MergeJoinStar<
  HasSelection extends boolean,
  TResult,
  TSideRow,
> = HasSelection extends true ? TResult : TResult & TSideRow

/**
 * Right join with implicit `*`: root columns become nullable, the joined side
 * is added, and any previously merged non-root fields are preserved.
 */
export type RightJoinStarResult<THandle, TResult, TSide> = NullableFields<
  InferSelect<THandle>
> &
  Omit<TResult, keyof InferSelect<THandle>> &
  InferSelect<TSide>
