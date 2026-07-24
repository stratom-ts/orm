import type { ColumnDataType } from 'kysely'

/**
 * Table metadata configuration for database table type definitions.
 * This ensures all necessary information is provided to generate migrations.
 */
export type TableMetadata<N extends string = string> = {
  /** The kind of metadata - used to distinguish from other metadata types */
  kind: 'table'
  /** The name of the table in the database */
  name: N
  /** The column name that serves as the primary key */
  primaryKey: string
  /** Array of column names to create indexes on */
  indexes?: string[]
  /** Optional schema name for multi-schema databases */
  schema?: string
}

/**
 * Column metadata configuration for database column type definitions.
 */
export type ColumnMetadata = {
  /** The kind of metadata - used to distinguish from other metadata types */
  kind: 'column'
  /** The database column type (e.g., 'text', 'varchar(255)', 'integer', 'timestamp') */
  type: ColumnDataType
  /** Default value for the column */
  default?: string | number | boolean | null
  /** Whether the column is auto-incrementing */
  autoIncrement?: boolean
  /** Whether the column is unique */
  unique?: boolean
  /** Column comment/documentation */
  comment?: string
}

/**
 * Reference metadata configuration for database foreign key relationships.
 */
export type ReferenceMetadata = {
  /** The kind of metadata - used to distinguish from other metadata types */
  kind: 'reference'
  /** The schema that is being referenced */
  schema: string
  /** The table that is being referenced */
  table: string
  /** The key/column that is being referenced */
  key: string
  /** The data type of the referenced column */
  dataType?: ColumnDataType
  /** Action to take on cascade delete */
  onDelete?: 'cascade' | 'restrict' | 'no action' | 'set null' | 'set default'
}
