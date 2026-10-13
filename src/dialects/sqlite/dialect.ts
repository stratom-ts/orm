import { defineDialect } from '../defineDialect'

import { sqliteCatalog } from './catalog'
import { sqliteClassifyDriverError } from './classifyDriverError'
import { sqliteIdentity } from './identity'
import { executeSqliteMigration, lowerSqliteMigrationPlan } from './migration'
import { sqliteNaming } from './naming'
import { sqliteOperations } from './operations'
import { sqliteQuery } from './query'
import { sqliteSchema } from './schema'

/** Complete SQLite >=3.37 member for the exact db0 0.4.0 node-sqlite connector. */
export const sqliteDialect = defineDialect({
  id: 'sqlite',
  classifyDriverError: sqliteClassifyDriverError,
  identity: sqliteIdentity,
  naming: sqliteNaming,
  schema: sqliteSchema,
  query: sqliteQuery,
  catalog: sqliteCatalog,
  operations: sqliteOperations,
  lower: lowerSqliteMigrationPlan,
  execute: executeSqliteMigration,
})
