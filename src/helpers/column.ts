import type { Kysely } from 'kysely'
import type { BaseIssue, BaseSchema } from 'valibot'
import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import type { TableSchema } from './table'
import { MigrationError } from '@/utils'
import { getColumnMetadata, getReferenceMetadata, isNullable } from '@/schemas'
import type { ColumnMetadata, ReferenceMetadata } from '@/schemas'

/**
 * Extracts column information from a schema definition.
 *
 * Combines metadata from the schema (column metadata, reference metadata)
 * with inferred type information to produce complete column configuration.
 *
 * @param columnSchema - The Valibot schema for the column
 * @param columnMetadata - Optional metadata from the column definition
 * @param referenceMetadata - Optional metadata from a reference definition
 * @returns Object containing column type, nullability, default value, uniqueness, and auto-increment settings
 *
 * @example
 * ```typescript
 * import { string, pipe } from 'valibot'
 * import { column } from 'schema-orm'
 *
 * const schema = pipe(
 *   string(),
 *   column({ type: 'varchar', unique: true }),
 * )
 *
 * const info = getColumnInfo(schema, schema.metadata?.column, undefined)
 * ```
 */
export function getColumnInfo(
  columnSchema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
  columnMetadata: ColumnMetadata | undefined,
  referenceMetadata: ReferenceMetadata | undefined,
  adapter: DialectAdapter = postgresAdapter,
) {
  const columnMetadataType = columnMetadata?.type
  const referenceMetadataType = referenceMetadata?.dataType
  const dataType =
    columnMetadataType ||
    referenceMetadataType ||
    adapter.inferColumnType(columnSchema)
  const nullable = isNullable(columnSchema)
  const defaultValue: string | number | boolean | null | undefined =
    columnMetadata?.default
  const unique = columnMetadata?.unique ?? false
  const autoIncrement = columnMetadata?.autoIncrement ?? false
  return { dataType, nullable, defaultValue, unique, autoIncrement }
}

/**
 * Checks if a column has any non-null data in a table.
 *
 * Used to verify if a column can be safely dropped - if it has data,
 * the migration should fail to prevent data loss.
 *
 * @param trx - The database transaction instance
 * @param table - The name of the table
 * @param column - The name of the column to check
 * @returns True if the column has any non-null data, false otherwise
 * @example
 * ```ts
 * const hasData = await checkColumnHasData(db, 'users', 'email')
 * if (hasData) {
 *   console.log('Cannot drop column - it contains data')
 * }
 * ```
 */
export async function checkColumnHasData(
  trx: Kysely<any>, // oxlint-disable-line typescript/no-explicit-any
  table: string,
  column: string,
): Promise<boolean> {
  const result = await trx
    .selectFrom(table as never)
    .select((eb) => eb.fn.countAll().as('count'))
    .where(column as never, 'is not', null)
    .executeTakeFirst()
  return Number(result?.count ?? 0) > 0
}

/**
 * Checks if a column has any null values in a table.
 *
 * Used to verify if a column can be safely set as NOT NULL - if it has
 * null values, the migration should fail.
 *
 * @param trx - The database transaction instance
 * @param table - The name of the table
 * @param column - The name of the column to check
 * @returns True if the column has any null values, false otherwise
 * @example
 * ```ts
 * const hasNulls = await checkColumnHasNulls(db, 'users', 'email')
 * if (hasNulls) {
 *   console.log('Cannot set NOT NULL - column has null values')
 * }
 * ```
 */
export async function checkColumnHasNulls(
  trx: Kysely<any>, // oxlint-disable-line typescript/no-explicit-any
  table: string,
  column: string,
): Promise<boolean> {
  const result = await trx
    .selectFrom(table as never)
    .select((eb) => eb.fn.countAll().as('count'))
    .where(column as never, 'is', null)
    .executeTakeFirst()
  return Number(result?.count ?? 0) > 0
}

/**
 * Adds a new column to an existing database table.
 *
 * Extracts column metadata from the schema and applies the appropriate
 * constraints including nullability, uniqueness, default values,
 * and auto-increment settings.
 *
 * @param trx - The database transaction instance
 * @param tableName - The name of the table to add the column to
 * @param schema - The Valibot schema containing the column definition
 * @param columnName - The name of the column to add
 * @returns Promise that resolves when the column is added
 * @throws MigrationError if the column is not found in the schema
 * @example
 * ```ts
 * await addColumn(db, 'users', UserSchema, 'phone')
 * // Adds 'phone' column to 'users' table with constraints from schema
 * ```
 */
export async function addColumn(
  trx: Kysely<any>, // oxlint-disable-line typescript/no-explicit-any
  tableName: string,
  schema: TableSchema,
  columnName: string,
  adapter: DialectAdapter = postgresAdapter,
): Promise<void> {
  const entries = schema.entries as Record<string, unknown>
  const columnSchema = entries[columnName]
  if (!columnSchema) {
    throw new MigrationError({
      message: `Column ${columnName} not found in schema`,
    })
  }
  const columnMetadata = getColumnMetadata(columnSchema as never)
  const referenceMetadata = getReferenceMetadata(columnSchema as never)
  const { dataType, nullable, defaultValue, unique, autoIncrement } =
    getColumnInfo(columnSchema as never, columnMetadata, referenceMetadata, adapter)

  const columnBuilder = trx.schema
    .alterTable(tableName)
    .addColumn(columnName, dataType, (cb) => {
      let col = cb
      if (!nullable) col = col.notNull()
      if (autoIncrement) col = col.autoIncrement()
      if (unique) col = col.unique()
      if (defaultValue !== undefined && defaultValue !== null)
        col = col.defaultTo(defaultValue)
      return col
    })
  await columnBuilder.execute()
}
