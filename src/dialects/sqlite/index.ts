import { inferSqliteColumnType } from './infer'
import { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
import { mapSqliteParamValue, mapSqliteResultValue } from './mapping'
import { normalizeSqliteDataType } from './normalize'
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

/** Ready SQLite schema facet; it is not a complete registered dialect member. */
export const sqliteSchema = {
  lowerDesiredSchema: lowerSqliteDesiredSchema,
  inferColumnType: inferSqliteColumnType,
  normalizeDataType: normalizeSqliteDataType,
  normalizeDefaultValue: normalizeSqliteDefaultValue,
}

/** Ready SQLite query facet; it is not a complete registered dialect member. */
export const sqliteQuery = {
  resolve: resolveSqliteQuery,
  mapParamValue: mapSqliteParamValue,
  mapResultValue: mapSqliteResultValue,
}
