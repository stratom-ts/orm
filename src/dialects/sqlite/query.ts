import { quoteIdentifier } from './compile'
import {
  mapSqliteParamValue,
  mapSqliteResultValue,
  validateSqliteValueMapping,
} from './mapping'
import { resolveSqliteQuery } from './queryAddressing'
import { resolveSqliteNumericAssignment } from './storage'

/** SQLite query addressing and value mapping. */
export const sqliteQuery = {
  rawSql: {
    quoteIdentifier,
    placeholder: (_position: number): string => '?',
  },
  numericAssignmentType: resolveSqliteNumericAssignment,
  validateValueMapping: validateSqliteValueMapping,
  resolve: resolveSqliteQuery,
  mapResultValue: mapSqliteResultValue,
  mapParamValue: mapSqliteParamValue,
}
