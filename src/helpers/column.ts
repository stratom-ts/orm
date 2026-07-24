import type { Kysely } from 'kysely'
import type { BaseIssue, BaseSchema } from 'valibot'
import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import type { TableSchema } from './table'
import { MigrationError } from '@/utils'
import {
  getColumnMetadata,
  getReferenceMetadata,
  getTableMetadata,
  isNullable,
} from '@/schemas'
import type { ColumnMetadata, ReferenceMetadata } from '@/schemas'

/**
 * Resolves column config from schema, metadata, and dialect type inference.
 *
 * @param columnSchema - Valibot schema for the column
 * @param columnMetadata - Column metadata, if present
 * @param referenceMetadata - Reference metadata, if present
 * @param adapter - Dialect adapter for type inference
 * @returns Resolved data type, nullability, default, unique, and autoIncrement
 *
 * @example
 * ```ts
 * const meta = getColumnMetadata(emailSchema)
 * const info = getColumnInfo(emailSchema, meta, undefined)
 * // { dataType: 'varchar(255)', nullable: false, ... }
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
 * Returns whether a column has any non-null values.
 *
 * @param trx - Kysely instance or transaction
 * @param table - Table name
 * @param column - Column name
 * @returns `true` if any non-null values exist
 *
 * @example
 * ```ts
 * if (await checkColumnHasData(db, 'users', 'email')) {
 *   // unsafe to drop
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
 * Returns whether a column has any NULL values.
 *
 * @param trx - Kysely instance or transaction
 * @param table - Table name
 * @param column - Column name
 * @returns `true` if any NULL values exist
 *
 * @example
 * ```ts
 * if (await checkColumnHasNulls(db, 'users', 'email')) {
 *   // unsafe to set NOT NULL
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
 * Adds a column to an existing table using its schema definition.
 *
 * @param trx - Kysely instance or transaction
 * @param tableName - Target table
 * @param schema - Table schema containing the column
 * @param columnName - Column to add
 * @param adapter - Dialect adapter for type inference
 * @throws MigrationError - When the column is missing from the schema
 *
 * @example
 * ```ts
 * await addColumn(db, 'users', UserSchema, 'phone')
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
    getColumnInfo(
      columnSchema as never,
      columnMetadata,
      referenceMetadata,
      adapter,
    )
  const tableMetadata = getTableMetadata(schema)

  const columnBuilder = trx.schema
    .alterTable(tableName)
    .addColumn(columnName, dataType, (cb) => {
      let col = cb
      if (!nullable) col = col.notNull()
      if (tableMetadata && columnName === tableMetadata.primaryKey)
        col = col.primaryKey()
      if (referenceMetadata?.table && referenceMetadata.key) {
        col = col.references(
          `${referenceMetadata.table}.${referenceMetadata.key}`,
        )
        if (referenceMetadata.onDelete) col = col.onDelete(referenceMetadata.onDelete)
      }
      if (unique && columnName !== tableMetadata?.primaryKey) col = col.unique()
      if (autoIncrement) col = col.autoIncrement()
      if (columnMetadata?.generated === 'always')
        col = col.generatedAlwaysAsIdentity()
      else if (columnMetadata?.generated === 'byDefault')
        col = col.generatedByDefaultAsIdentity()
      if (defaultValue !== undefined && defaultValue !== null)
        col = col.defaultTo(defaultValue)
      return col
    })
  await columnBuilder.execute()
}
