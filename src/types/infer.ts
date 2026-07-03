import type { ColumnType, Generated, JSONColumnType } from 'kysely'
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

/**
 * Whether a schema (after unwrapping optional/nullable/nullish) has
 * a MetadataAction whose metadata.kind is 'reference' anywhere in
 * its pipe.
 */
type HasReferenceMetadata<S> =
  UnwrapSchema<S> extends { pipe: readonly [...unknown[], { kind: 'metadata'; metadata: { kind: 'reference' } }] }
    ? true
    : false

/**
 * Whether the base (unwrapped) schema is a Valibot object schema
 * that is NOT a reference column.
 */
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

/**
 * Whether any KyselyColumnConfig key was explicitly set (as opposed
 * to the default empty object `{}`).
 */
type HasExplicitKeys<C extends KyselyColumnConfig> =
  C extends { generated?: never; readonly?: never; json?: never; dateAsString?: never }
    ? false
    : true

/**
 * Applies Kysely column type wrapping based on explicit config flags
 * and automatic schema detection.
 *
 * Priority:
 * 1. Explicit config flags always win
 * 2. If user set any config flag explicitly (even `false`), skip auto-detection
 * 3. Auto-detect: Valibot object schemas that aren't references → JSONColumnType<T>
 */
type ApplyColumnType<T, Config extends KyselyColumnConfig, Schema> =
  Config extends { generated: true } ? Generated<T> :
  Config extends { readonly: true } ? ColumnType<T, T, never> :
  Config extends { json: true } ? WrapJson<T> :
  Config extends { dateAsString: true } ? ColumnType<Date, string, string> :
  HasExplicitKeys<Config> extends true ? T :
  IsObjectSchema<Schema> extends true ? WrapJson<T> :
  T

/** JSONColumnType requires T extends object | null, so guard it. */
type WrapJson<T> = T extends object | null ? JSONColumnType<T> : T

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type InferRow<S extends TableSchema> = {
  [K in keyof S['entries']]-?: DBType<InferOutput<S['entries'][K]>>
}

export type InferTable<
  S extends TableSchema,
  C extends Record<string, KyselyColumnConfig> = Record<string, never>,
> = {
  [K in keyof S['entries']]-?:
    ApplyColumnType<
      DBType<InferOutput<S['entries'][K]>>,
      K extends keyof C ? C[K] : Record<string, never>,
      S['entries'][K]
    >
}

export type InferDB<
  Schemas extends Record<string, TableSchema>,
  Configs extends Record<string, Record<string, KyselyColumnConfig>> = Record<string, never>,
> = {
  [K in keyof Schemas]:
    InferTable<Schemas[K], K extends keyof Configs ? Configs[K] : Record<string, never>>
}

export type InferDBFromArray<T extends readonly TableSchema<string>[]> = {
  [K in T[number] as K extends TableSchema<infer N> ? N : never]: InferRow<K>
}
