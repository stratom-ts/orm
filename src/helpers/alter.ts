import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import { addColumn, checkColumnHasData, checkColumnHasNulls } from './column'
import type { ColumnDiff } from './diff'
import { diffTableSchema } from './diff'
import type { TableSchema } from './table'
import { MigrationError } from '@/utils'
import type { ColumnMetadata, Kysely } from 'kysely'

/**
 * Safely alters a column in a table by updating its data type and nullability.
 * Throws a MigrationError if the column has NULL values when trying to set NOT NULL.
 *
 * @param trx - The Kysely database transaction instance
 * @param tableName - The name of the table containing the column
 * @param column - The column diff object containing current and local column metadata
 *
 * @example
 * ```ts
 * await alterColumnSafe(trx, 'users', {
 *   name: 'email',
 *   local: { dataType: 'varchar(255)', nullable: false },
 *   current: { dataType: 'varchar(100)', isNullable: true }
 * })
 * ```
 */
async function alterColumnSafe<T>(
  trx: Kysely<T>,
  tableName: string,
  column: ColumnDiff,
  _adapter: DialectAdapter = postgresAdapter,
): Promise<void> {
  if (!column.current) return
  const nullable = column.local.nullable ?? true

  if (!nullable && column.current.isNullable) {
    const hasNulls = await checkColumnHasNulls(trx, tableName, column.name)
    if (hasNulls) {
      throw new MigrationError({
        message: `Cannot set column '${tableName}.${column.name}' as NOT NULL - ${column.name} has NULL values.`,
      })
    }
  }

  if (column.local.dataType !== column.current.dataType) {
    await trx.schema
      .alterTable(tableName)
      .alterColumn(column.name, (ac) =>
        ac.setDataType(column.local.dataType as never),
      )
      .execute()
  }

  if (!nullable && column.current.isNullable) {
    await trx.schema
      .alterTable(tableName)
      .alterColumn(column.name, (ac) => ac.setNotNull())
      .execute()
  } else if (nullable && !column.current.isNullable) {
    await trx.schema
      .alterTable(tableName)
      .alterColumn(column.name, (ac) => ac.dropNotNull())
      .execute()
  }
}

/**
 * Safely alters a table schema by comparing the desired schema with the current database columns.
 * Handles column additions, modifications, and removals while validating data integrity.
 * Throws MigrationError if attempting to drop columns with existing data or set NOT NULL on columns with NULL values.
 *
 * @param trx - The Kysely database transaction instance
 * @param schema - The desired table schema definition
 * @param dbColumns - The current column metadata from the database
 *
 * @example
 * ```ts
 * const dbColumns = await trx.introspection.getTableColumns('users')
 * await alterTableSafe(trx, userSchema, dbColumns)
 * ```
 */
export async function alterTableSafe<T>(
  trx: Kysely<T>,
  schema: TableSchema,
  dbColumns: ColumnMetadata[],
  adapter: DialectAdapter = postgresAdapter,
): Promise<void> {
  const diff = diffTableSchema(schema, dbColumns, adapter)
  if (!diff) return

  if (diff.removed.length > 0) {
    for (const columnName of diff.removed) {
      const hasData = await checkColumnHasData(trx, diff.tableName, columnName)
      if (hasData) {
        throw new MigrationError({
          message: `Cannot drop column '${diff.tableName}.${columnName}' - table has rows with data. Migrate data first.`,
        })
      }
      await trx.schema
        .alterTable(diff.tableName)
        .dropColumn(columnName)
        .execute()
    }
  }

  if (diff.added.length > 0) {
    for (const column of diff.added) {
      await addColumn(trx, diff.tableName, schema, column.name)
    }
  }

  if (diff.modified.length > 0) {
    for (const column of diff.modified) {
      await alterColumnSafe(trx, diff.tableName, column, adapter)
    }
  }
}
