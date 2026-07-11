import type { Kysely, TableMetadata } from 'kysely'
import type { DialectAdapter } from '@/dialects'
import { postgresAdapter } from '@/dialects'
import { alterTableSafe, createIndexes, createTableFromSchema } from '@/helpers'
import type { TableSchema } from '@/helpers'
import { getTableMetadata } from '@/schemas'

/**
 * Creates or alters a single table, then ensures its indexes exist.
 *
 * @param db - Kysely instance (used for compile-time query building)
 * @param trx - Transaction used to apply DDL
 * @param schema - Table schema to migrate
 * @param existingTables - Current database tables from introspection
 * @param adapter - Dialect adapter for type inference and normalization
 */
async function migrateTable<T>(
  db: Kysely<T>,
  trx: Kysely<T>,
  schema: TableSchema,
  existingTables: TableMetadata[],
  adapter: DialectAdapter = postgresAdapter,
): Promise<void> {
  const table = getTableMetadata(schema)
  if (!table) return

  const existingTable = existingTables.find(
    (existingTable) => existingTable.name === table.name,
  )

  if (!existingTable) {
    await trx.executeQuery(createTableFromSchema(db, schema, adapter))
  } else {
    await alterTableSafe(trx, schema, existingTable.columns, adapter)
  }

  const indexQueries = createIndexes(db, table.name, table.indexes)
  for (const query of indexQueries) {
    await trx.executeQuery(query)
  }
}

/**
 * Migrates the database to match the given table schemas in a transaction.
 *
 * @param db - Kysely instance
 * @param schemas - Table schemas to create or alter
 * @param adapter - Dialect adapter for type inference and normalization
 *
 * @example
 * ```ts
 * await runMigrations(db, [UserSchema, PostSchema])
 * ```
 */
export async function runMigrations<T>(
  db: Kysely<T>,
  schemas: TableSchema[],
  adapter: DialectAdapter = postgresAdapter,
): Promise<void> {
  const existingTables = await db.introspection.getTables()
  await db.transaction().execute(async (trx) => {
    for (const schema of schemas) {
      await migrateTable(db, trx, schema, existingTables, adapter)
    }
  })
}
