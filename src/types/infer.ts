import type { InferOutput } from 'valibot'
import type { TableSchema } from '@/helpers/table'

type DBType<T> = T extends undefined ? never : T

export type InferRow<S extends TableSchema> = {
  [K in keyof S['entries']]-?: DBType<InferOutput<S['entries'][K]>>
}

export type InferDB<Schemas extends Record<string, TableSchema>> = {
  [K in keyof Schemas]: InferRow<Schemas[K]>
}

export type InferDBFromArray<T extends readonly TableSchema<string>[]> = {
  [K in T[number] as K extends TableSchema<infer N> ? N : never]: InferRow<K>
}
