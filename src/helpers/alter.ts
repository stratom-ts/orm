import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import { addColumn, checkColumnHasData, checkColumnHasNulls } from './column'
import type { ColumnDiff } from './diff'
import { diffTableSchema } from './diff'
import type { TableSchema } from './table'
import { MigrationError } from '@/utils'
import type { ColumnMetadata, Kysely } from 'kysely'

/**
 * Updates a column's data type and nullability with data-integrity checks.
 *
 * @param trx - Kysely transaction
 * @param tableName - Table containing the column
 * @param column - Diff between local and database column definitions
 * @param adapter - Dialect adapter for type normalization
 * @throws MigrationError - When setting NOT NULL on a column that has NULL values
 *
 * @example
 * ```ts
 * await alterColumnSafe(trx, 'users', {
 *   name: 'email',
 *   local: { dataType: 'varchar(255)', nullable: false },
 *   current: { dataType: 'varchar(100)', isNullable: true },
 * })
 * ```
 */
async function alterColumnSafe<T>(
  trx: Kysely<T>,
  tableName: string,
  column: ColumnDiff,
  adapter: DialectAdapter = postgresAdapter,
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

  const localNorm = adapter.normalizeDataType(column.local.dataType)
  const currentNorm = adapter.normalizeDataType(column.current.dataType)
  if (localNorm !== currentNorm) {
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
 * Applies schema diffs to a table: add, modify, and drop columns safely.
 *
 * @param trx - Kysely transaction
 * @param schema - Desired table schema
 * @param dbColumns - Current database column metadata
 * @param adapter - Dialect adapter for type inference and normalization
 * @throws MigrationError - When dropping a column with data or setting NOT NULL on NULLs
 *
 * @example
 * ```ts
 * const dbColumns = await trx.introspection.getTables()
 * await alterTableSafe(trx, userSchema, dbColumns[0].columns)
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
      await addColumn(trx, diff.tableName, schema, column.name, adapter)
    }
  }

  if (diff.modified.length > 0) {
    for (const column of diff.modified) {
      await alterColumnSafe(trx, diff.tableName, column, adapter)
    }
  }
}
