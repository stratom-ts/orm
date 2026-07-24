import type { Kysely, TableMetadata } from 'kysely'
import { createIndexes, createTableFromSchema } from '@helpers/index'
import { alterTableSafe } from '@helpers/alter'
import type { TableSchema } from '@helpers/table'
import { getTableMetadata } from '@schemas/index'

async function migrateTable(
  db: Kysely<unknown>,
  trx: Kysely<unknown>,
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

export async function runMigrations(
  db: Kysely<unknown>,
  schemas: TableSchema[],
): Promise<void> {
  const existingTables = await db.introspection.getTables()
  await db.transaction().execute(async (trx) => {
    for (const schema of schemas) {
      await migrateTable(db, trx, schema, existingTables)
    }
  })
}
