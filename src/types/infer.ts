import type {
  ColumnType,
  Generated,
  GeneratedAlways,
  JSONColumnType,
} from 'kysely'
import type { InferOutput } from 'valibot'
import type { TableSchema } from '@/helpers/table'
import type { KyselyColumnConfig } from './kysely'

type DBType<T> = T extends undefined ? never : T

// ---------------------------------------------------------------------------
// Schema unwrapping utilities (type-level mirrors of the runtime helpers)
// ---------------------------------------------------------------------------

type UnwrapSchema<S> =
  S extends { kind: 'schema'; type: 'optional'; wrapped: infer W }
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

/** `true` if the unwrapped schema pipe ends with reference metadata. */
type HasReferenceMetadata<S> =
  UnwrapSchema<S> extends { pipe: readonly [...unknown[], { kind: 'metadata'; metadata: { kind: 'reference' } }] }
    ? true
    : false

/** `true` if the base schema is a non-reference Valibot object. */
type IsObjectSchema<S> =
  HasReferenceMetadata<S> extends true
    ? false
  : UnwrapSchema<S> extends { pipe: readonly [infer First, ...unknown[]] }
    ? First extends { kind: 'schema'; type: 'object' }
      ? true
      : false
  : UnwrapSchema<S> extends { kind: 'schema'; type: 'object' }
    ? true
    : false

/** `true` if any `KyselyColumnConfig` flag was set (not the empty/sentinel case). */
type HasExplicitKeys<C> =
  [C] extends [NoColumnConfig] ? false :
  C extends { generated?: never; readonly?: never; json?: never; dateAsString?: never }
    ? false
    : true

/**
 * Sentinel when a column has no config entry so auto-detection can run.
 */
export type NoColumnConfig = { readonly __sentinel__: true }

/** Applies Generated / JSON / readonly wrapping from config and schema metadata. */
type ApplyColumnType<T, Config extends KyselyColumnConfig | NoColumnConfig, Schema> =
  Config extends { generated: true } ? Generated<T> :
  Config extends { readonly: true } ? ColumnType<T, T, never> :
  Config extends { json: true } ? WrapJson<T> :
  Config extends { dateAsString: true } ? ColumnType<Date, string, string> :
  HasExplicitKeys<Config> extends true ? T :
  UnwrapSchema<Schema> extends { pipe: readonly [...unknown[], { kind: 'metadata'; metadata: { kind: 'column'; readonly: true } }] } ? ColumnType<T, T, never> :
  UnwrapSchema<Schema> extends { pipe: readonly [...unknown[], { kind: 'metadata'; metadata: { kind: 'column'; generated: 'always' } }] } ? GeneratedAlways<T> :
  UnwrapSchema<Schema> extends { pipe: readonly [...unknown[], { kind: 'metadata'; metadata: { kind: 'column'; generated: 'byDefault' } }] } ? Generated<T> :
  IsObjectSchema<Schema> extends true ? WrapJson<T> :
  T

/** Guards `JSONColumnType` to object | null. */
type WrapJson<T> = T extends object | null ? JSONColumnType<T> : T

type ConfigForKey<C, K> =
  K extends keyof C
    ? ([C[K]] extends [never] ? NoColumnConfig : C[K])
    : NoColumnConfig

/**
 * Plain row type from a table schema (`InferOutput` per column).
 *
 * @example
 * ```ts
 * type User = InferRow<typeof UserSchema>
 * ```
 */
export type InferRow<S extends TableSchema> = {
  [K in keyof S['entries']]-?: DBType<InferOutput<S['entries'][K]>>
}

/**
 * Kysely table type with Generated/JSON/readonly wrapping applied.
 *
 * @example
 * ```ts
 * type Users = InferTable<typeof UserSchema>
 * type Users = InferTable<typeof UserSchema, { id: { generated: true } }>
 * ```
 */
export type InferTable<
  S extends TableSchema,
  C extends Record<string, KyselyColumnConfig> = Record<string, never>,
> = {
  [K in keyof S['entries']]-?:
    ApplyColumnType<
      DBType<InferOutput<S['entries'][K]>>,
      ConfigForKey<C, K>,
      S['entries'][K]
    >
}

/**
 * Kysely database type from a record of table schemas.
 *
 * @example
 * ```ts
 * type DB = InferDB<{ users: typeof UserSchema; posts: typeof PostSchema }>
 * ```
 */
export type InferDB<
  Schemas extends Record<string, TableSchema>,
  Configs extends Record<string, Record<string, KyselyColumnConfig>> = Record<string, never>,
> = {
  [K in keyof Schemas]:
    InferTable<Schemas[K], K extends keyof Configs ? Configs[K] : Record<string, never>>
}

/**
 * Kysely database type from a schema array, keyed by `table({ name })`.
 *
 * @example
 * ```ts
 * type DB = InferDBFromArray<readonly [typeof UserSchema, typeof PostSchema]>
 * ```
 */
export type InferDBFromArray<T extends readonly TableSchema<string>[]> = {
  [K in T[number] as K extends TableSchema<infer N> ? N : never]: InferTable<K>
}
