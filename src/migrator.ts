import type { Kysely, TableMetadata } from 'kysely'
import { alterTableSafe, createIndexes, createTableFromSchema } from '@/helpers'
import type { TableSchema } from '@/helpers'
import { getTableMetadata } from '@/schemas'

async function migrateTable<T>(
  db: Kysely<T>,
  trx: Kysely<T>,
  schema: TableSchema,
  existingTables: TableMetadata[],
): Promise<void> {
  const table = getTableMetadata(schema)
  if (!table) return

  const existingTable = existingTables.find(
    (existingTable) => existingTable.name === table.name,
  )

  if (!existingTable) {
    await trx.executeQuery(createTableFromSchema(db, schema))
    return
  }

  await alterTableSafe(trx, schema, existingTable.columns)

  const indexQueries = createIndexes(db, table.name, table.indexes)
  for (const query of indexQueries) {
    await trx.executeQuery(query)
  }
}

export async function runMigrations<T>(
  db: Kysely<T>,
  schemas: TableSchema[],
): Promise<void> {
  const existingTables = await db.introspection.getTables()
  await db.transaction().execute(async (trx) => {
    for (const schema of schemas) {
      await migrateTable(db, trx, schema, existingTables)
    }
  })
}
