/**
 * Per-column flags for Kysely type wrapping in `InferTable` / `InferDB`.
 */
export type KyselyColumnConfig = {
  /** Wrap as `Generated<T>` */
  generated?: boolean
  /** Immutable after insert (`ColumnType<T, T, never>`) */
  readonly?: boolean
  /** Store as JSON (`JSONColumnType<T>`) */
  json?: boolean
  /** Date as string I/O (`ColumnType<Date, string, string>`) */
  dateAsString?: boolean
}
