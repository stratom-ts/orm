import {
  mapSqliteParamValue,
  mapSqliteResultValue,
  validateSqliteValueMapping,
} from './mapping'
import { resolveSqliteQuery } from './queryAddressing'

/** SQLite query addressing and value mapping. */
export const sqliteQuery = {
  validateValueMapping: validateSqliteValueMapping,
  resolve: resolveSqliteQuery,
  mapParamValue: mapSqliteParamValue,
  mapResultValue: mapSqliteResultValue,
}
