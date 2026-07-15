import type { ObjectEntries } from 'valibot'
import type { SqlDataType } from '@/dialects/types'

/**
 * Referential action for foreign-key ON DELETE / ON UPDATE.
 */
export type ReferentialAction =
  | 'cascade'
  | 'restrict'
  | 'no action'
  | 'set null'
  | 'set default'

/**
 * Named or composite index definition.
 */
export type IndexConfig = {
  /** Explicit index name; dialect may generate one when omitted */
  name?: string
  /** Columns participating in the index (order preserved) */
  columns: string[]
  /** Whether the index enforces uniqueness */
  unique?: boolean
}

/**
 * Index entry: a single column name, or a full index config.
 */
export type TableIndex = string | IndexConfig

/**
 * Table-level metadata attached via `table()`.
 */
export type TableMetadata<N extends string = string> = {
  /** Discriminant for table metadata */
  kind: 'table'
  /** Database table name */
  name: N
  /** Primary key column name, or composite key column list */
  primaryKey: string | string[]
  /** Indexes (string = single-column non-unique; object = named/composite/unique) */
  indexes?: TableIndex[]
  /** Database schema (Postgres namespace) */
  schema?: string
}

/** Column property names of a table's Valibot entries. */
export type ColumnKey<TCols extends ObjectEntries> = keyof TCols & string

/**
 * Named or composite index definition constrained to a table's own columns.
 */
export type IndexConfigOf<TCols extends ObjectEntries> = {
  /** Explicit index name; dialect may generate one when omitted */
  name?: string
  /** Columns participating in the index (order preserved) */
  columns: ColumnKey<TCols>[]
  /** Whether the index enforces uniqueness */
  unique?: boolean
}

/**
 * Index entry constrained to a table's own columns: a single column name, or
 * a full index config.
 */
export type TableIndexOf<TCols extends ObjectEntries> =
  | ColumnKey<TCols>
  | IndexConfigOf<TCols>

/**
 * Table-level options passed to `defineTable(name, columns, options)`.
 * `primaryKey` and index `columns` are constrained to the declared columns.
 */
export type TableOptions<TCols extends ObjectEntries> = {
  /** Primary key column name, or composite key column list */
  primaryKey: ColumnKey<TCols> | readonly ColumnKey<TCols>[]
  /** Database schema (Postgres namespace) */
  schema?: string
  /** Indexes (string = single-column non-unique; object = named/composite/unique) */
  indexes?: TableIndexOf<TCols>[]
}

/**
 * Column-level metadata attached via `column()`.
 */
export type ColumnMetadata = {
  /** Discriminant for column metadata */
  kind: 'column'
  /** SQL column type (e.g. `'text'`, `'varchar(255)'`, `'integer'`) */
  type?: SqlDataType
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
  /** Immutable after insert */
  readonly?: boolean
  /** SQL ON UPDATE expression (e.g. `'now()'`) */
  onUpdate?: string
  /** Override dialect mapping for values written as query params. */
  mapParam?: (value: unknown) => unknown
  /** Override dialect mapping for values read from result rows. */
  mapResult?: (value: unknown) => unknown
}

/**
 * Foreign-key metadata attached via `reference()`.
 */
export type ReferenceMetadata = {
  /** Discriminant for reference metadata */
  kind: 'reference'
  /**
   * Postgres schema/namespace of the referenced table.
   * Omitted means the default schema (`public`).
   */
  schema?: string
  /** Referenced table name */
  table: string
  /** Referenced column name */
  key: string
  /** Referenced column data type */
  dataType?: SqlDataType
  /** ON DELETE action */
  onDelete?: ReferentialAction
  /** ON UPDATE action */
  onUpdate?: ReferentialAction
}
