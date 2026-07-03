export type KyselyColumnConfig = {
  /** Auto-generated — wrapped in Generated<T> */
  generated?: boolean
  /** Immutable after insert — ColumnType<T, T, never> */
  readonly?: boolean
  /** Object stored as JSON — JSONColumnType<T> */
  json?: boolean
  /** Date values serialized as strings — ColumnType<Date, string, string> */
  dateAsString?: boolean
}
