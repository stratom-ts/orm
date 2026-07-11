import type { Kysely } from 'kysely'
import type {
  MetadataAction,
  ObjectEntries,
  ObjectSchema,
  SchemaWithPipe,
  TitleAction,
} from 'valibot'
import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import { getColumnInfo } from './column'
import { MigrationError } from '@/utils'
import {
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
} from '@/schemas'
import type { TableMetadata as TableMetadataType } from '@/schemas'

/** Valibot object schema with `title()` and `table()` metadata. */
export type TableSchema<N extends string = string> = SchemaWithPipe<
  readonly [
    ObjectSchema<ObjectEntries, undefined>,
    TitleAction<unknown, string>,
    MetadataAction<unknown, TableMetadataType<N>>,
  ]
>

/**
 * Compiles a `CREATE TABLE` query from a Valibot table schema.
 *
 * @param db - Kysely instance
 * @param schema - Table schema with `table()` metadata
 * @param adapter - Dialect adapter for type inference
 * @returns Compiled create-table query
 * @throws MigrationError - When table metadata is missing
 *
 * @example
 * ```ts
 * const UserSchema = pipe(
 *   object({
 *     id: pipe(string(), column({ type: 'uuid' })),
 *     email: pipe(string(), column({ type: 'varchar(255)' })),
 *   }),
 *   title('users'),
 *   table({ name: 'users', primaryKey: 'id' }),
 * )
 * const query = createTableFromSchema(db, UserSchema)
 * ```
 */
export function createTableFromSchema<T>(
  db: Kysely<T>,
  schema: TableSchema,
  adapter: DialectAdapter = postgresAdapter,
) {
  const metadata = getTableMetadata(schema)
  if (!metadata) {
    throw new MigrationError({
      message:
        'Error creating table from schema: Schema must provide a table metadata definition',
    })
  }
  const tableName = metadata.name
  const schemaModule = metadata.schema
    ? db.schema.withSchema(metadata.schema)
    : db.schema
  let table = schemaModule.createTable(tableName)

  for (const [column, columnSchema] of Object.entries(schema.entries)) {
    if (columnSchema.kind !== 'schema') continue

    const columnMetadata = getColumnMetadata(columnSchema)
    const referenceMetadata = getReferenceMetadata(columnSchema)
    const { dataType, nullable, defaultValue, unique, autoIncrement } =
      getColumnInfo(columnSchema, columnMetadata, referenceMetadata, adapter)

    table = table.addColumn(column, dataType, (columnBuilder) => {
      let col = columnBuilder
      if (!nullable) col = col.notNull()
      if (column === metadata.primaryKey) col = col.primaryKey()
      if (referenceMetadata?.table && referenceMetadata.key) {
        col = col.references(
          `${referenceMetadata.table}.${referenceMetadata.key}`,
        )
        if (referenceMetadata.onDelete) col = col.onDelete(referenceMetadata.onDelete)
      }
      if (unique && column !== metadata.primaryKey) col = col.unique()
      if (autoIncrement) col = col.autoIncrement()
      if (columnMetadata?.generated === 'always')
        col = col.generatedAlwaysAsIdentity()
      else if (columnMetadata?.generated === 'byDefault')
        col = col.generatedByDefaultAsIdentity()
      if (defaultValue !== undefined && defaultValue !== null)
        col = col.defaultTo(defaultValue)
      return col
    })
  }
  return table.compile()
}
