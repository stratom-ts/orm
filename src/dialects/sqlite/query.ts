import { quoteIdentifier } from './compile'
import {
  mapSqliteParamValue,
  mapSqliteResultValue,
  numericAssignmentType,
  validateSqliteValueMapping,
} from './mapping'
import { resolveSqliteQuery } from './queryAddressing'

/** SQLite query addressing and value mapping. */
export const sqliteQuery = {
  rawSql: {
    quoteIdentifier,
    placeholder: (_position: number): string => '?',
  },
  numericAssignmentType,
  validateValueMapping: validateSqliteValueMapping,
  resolve: resolveSqliteQuery,
  mapResultValue: mapSqliteResultValue,
  mapParamValue: mapSqliteParamValue,
}
