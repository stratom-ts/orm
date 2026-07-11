import type { ColumnDataType } from 'kysely'

/**
 * Table-level metadata attached via `table()`.
 */
export type TableMetadata<N extends string = string> = {
  /** Discriminant for table metadata */
  kind: 'table'
  /** Database table name */
  name: N
  /** Primary key column name */
  primaryKey: string
  /** Columns to index */
  indexes?: string[]
  /** Database schema (multi-schema DBs) */
  schema?: string
}

/**
 * Column-level metadata attached via `column()`.
 */
export type ColumnMetadata = {
  /** Discriminant for column metadata */
  kind: 'column'
  /** SQL column type (e.g. `'text'`, `'varchar(255)'`, `'integer'`) */
  type?: ColumnDataType
  /** Default value */
  default?: string | number | boolean | null
  /** Auto-increment column */
  autoIncrement?: boolean
  /** Unique constraint */
  unique?: boolean
  /** Column comment */
  comment?: string
  /** Identity generation strategy */
  generated?: 'byDefault' | 'always'
  /** Immutable after insert (`ColumnType<T, T, never>`) */
  readonly?: boolean
  /** SQL ON UPDATE expression (e.g. `'now()'`) */
  onUpdate?: string
}

/**
 * Foreign-key metadata attached via `references()`.
 */
export type ReferenceMetadata = {
  /** Discriminant for reference metadata */
  kind: 'reference'
  /** Referenced schema title */
  schema: string
  /** Referenced table name */
  table: string
  /** Referenced column name */
  key: string
  /** Referenced column data type */
  dataType?: ColumnDataType
  /** ON DELETE action */
  onDelete?: 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default'
}
