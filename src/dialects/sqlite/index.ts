import { defineDialect } from '../defineDialect'

import { sqliteCatalog } from './catalog'
import { sqliteIdentity } from './identity'
import { inferSqliteColumnType } from './infer'
import { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
import {
  mapSqliteParamValue,
  mapSqliteResultValue,
  validateSqliteValueMapping,
} from './mapping'
import { executeSqliteMigration, lowerSqliteMigrationPlan } from './migration'
import { sqliteNaming } from './naming'
import { normalizeSqliteDataType } from './normalize'
import { sqliteOperations } from './operations'
import { resolveSqliteQuery } from './queryAddressing'
import { normalizeSqliteDefaultValue } from './validate'

export {
  SQLITE_IDENTITY_POLICY,
  asciiFoldSqliteIdentifier,
  sqliteIdentity,
} from './identity'
export { inferSqliteColumnType } from './infer'
export { sqliteCatalog } from './catalog'
export { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
export { mapSqliteParamValue, mapSqliteResultValue } from './mapping'
export { SQLITE_PHYSICAL_NAMING, sqliteNaming } from './naming'
export { normalizeSqliteDataType, normalizeSqliteDefaultExpression } from './normalize'
export { resolveSqliteQuery } from './queryAddressing'
export { createDb0NodeSqliteOperationSessionProvider } from './operationSession'
export { compileSqliteOperationCommand, sqliteOperations } from './operations'
export { executeSqliteMigration, lowerSqliteMigrationPlan } from './migration'
export {
  assertSafeSqliteDataType,
  formatSqliteDefaultExpression,
  formatSqliteLiteral,
  normalizeSqliteDefaultValue,
} from './validate'
export {
  compileSqlite,
  createSqliteQueryRelationResolver,
  resolveSqliteQueryRelation,
} from './compile'

/** SQLite physical desired-schema and comparison policies. */
export const sqliteSchema = {
  lowerDesiredSchema: lowerSqliteDesiredSchema,
  inferColumnType: inferSqliteColumnType,
  normalizeDataType: normalizeSqliteDataType,
  normalizeDefaultValue: normalizeSqliteDefaultValue,
}

/** SQLite query addressing and value mapping. */
export const sqliteQuery = {
  validateValueMapping: validateSqliteValueMapping,
  resolve: resolveSqliteQuery,
  mapParamValue: mapSqliteParamValue,
  mapResultValue: mapSqliteResultValue,
}

/** Complete SQLite >=3.37 member for the exact db0 0.4.0 node-sqlite connector. */
export const sqliteDialect = defineDialect({
  id: 'sqlite',
  identity: sqliteIdentity,
  naming: sqliteNaming,
  schema: sqliteSchema,
  query: sqliteQuery,
  catalog: sqliteCatalog,
  operations: sqliteOperations,
  lower: lowerSqliteMigrationPlan,
  execute: executeSqliteMigration,
})
