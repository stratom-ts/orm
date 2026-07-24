import type { Kysely } from 'kysely'
import type {
  MetadataAction,
  ObjectEntries,
  ObjectSchema,
  SchemaWithPipe,
  TitleAction,
} from 'valibot'
import { getColumnInfo } from '@helpers/column'
import { MigrationError } from '@utils/error'
import type { TableMetadata as TableMetadataType } from '@schemas/actions/types'
import {
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
} from '@schemas/index'

export type TableSchema = SchemaWithPipe<
  readonly [
    ObjectSchema<ObjectEntries, undefined>,
    TitleAction<unknown, string>,
    MetadataAction<unknown, TableMetadataType>,
  ]
>

/**
 * Creates a database table from a Valibot schema with table metadata.
 *
 * Extracts table and column metadata from the schema to build a complete
 * table definition including columns, primary key, foreign keys, constraints,
 * and default values.
 *
 * @param db - The Kysely database instance
 * @param schema - The Valibot schema with table metadata
 * @returns Compiled query for creating the database table
 * @throws MigrationError if schema does not provide table metadata
 * @example
 * ```ts
 * import { pipe, object, string, title } from 'valibot'
 * import { table, column } from 'schema-orm'
 *
 * const UserSchema = pipe(
 *   object({
 *     id: pipe(string(), column({ type: 'uuid' })),
 *     email: pipe(string(), column({ type: 'varchar(255)' })),
 *     name: pipe(string(), column({ type: 'text' })),
 *   }),
 *   title('users'),
 *   table({ name: 'users', primaryKey: 'id' }),
 * )
 *
 * const query = createTableFromSchema(db, UserSchema)
 * // Returns compiled CREATE TABLE query
 * ```
 */
export function createTableFromSchema<T>(
  db: Kysely<T>,
  schema: TableSchema,
) {
  const metadata = getTableMetadata(schema)
  if (!metadata) {
    throw new MigrationError({
      message:
        'Error creating table from schema: Schema must provide a table metadata definition',
    })
  }
  const tableName = metadata.name
  let table = db.schema.createTable(tableName)

  for (const [column, columnSchema] of Object.entries(schema.entries)) {
    if (columnSchema.kind !== 'schema') continue

    const columnMetadata = getColumnMetadata(columnSchema)
    const referenceMetadata = getReferenceMetadata(columnSchema)
    const { dataType, nullable, defaultValue, unique, autoIncrement } =
      getColumnInfo(columnSchema, columnMetadata, referenceMetadata)

    table = table.addColumn(column, dataType, (columnBuilder) => {
      let col = columnBuilder
      if (!nullable) col = col.notNull()
      if (column === metadata.primaryKey) col = col.primaryKey()
      if (referenceMetadata?.table && referenceMetadata.key)
        col = col.references(
          `${referenceMetadata.table}.${referenceMetadata.key}`,
        )
      if (unique && column !== metadata.primaryKey) col = col.unique()
      if (autoIncrement) col = col.autoIncrement()
      if (defaultValue !== undefined && defaultValue !== null)
        col = col.defaultTo(defaultValue)
      return col
    })
  }
  return table.compile()
}
