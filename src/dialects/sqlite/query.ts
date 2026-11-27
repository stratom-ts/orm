import { quoteIdentifier } from './compile'
import { sqliteExpressionComparable, sqliteExpressionResult } from './expressionResult'
import {
  mapSqliteParamValue,
  mapSqliteResultValue,
  validateSqliteValueMapping,
} from './mapping'
import { resolveSqliteQuery } from './queryAddressing'
import { resolveSqliteNumericAssignment } from './storage'

/** SQLite query addressing and value mapping. */
export const sqliteQuery = {
  expressionResult: sqliteExpressionResult,
  expressionComparable: sqliteExpressionComparable,
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
