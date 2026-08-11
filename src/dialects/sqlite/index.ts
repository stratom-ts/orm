import type { DialectCore } from '../types'

import { compileSqlite } from './compile'
import { inferSqliteColumnType } from './infer'
import { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
import { mapSqliteParamValue, mapSqliteResultValue } from './mapping'
import { normalizeSqliteDataType } from './normalize'
import { formatSqliteDefault, normalizeSqliteDefaultExpression } from './validate'

/** SQLite production core facet; assembly/catalog/runtime belongs to a later ticket. */
export const sqliteCore: DialectCore = {
  id: 'sqlite',
  relationIdentity: 'sqlite',
  lowerDesiredSchema: lowerSqliteDesiredSchema,
  inferColumnType: inferSqliteColumnType,
  normalizeDataType: normalizeSqliteDataType,
  normalizeDefaultValue(value) {
    return normalizeSqliteDefaultExpression(formatSqliteDefault(value))
  },
  compile: compileSqlite,
  mapResultValue(dataType, value) {
    return mapSqliteResultValue(dataType, value)
  },
  mapParamValue(dataType, value) {
    return mapSqliteParamValue(dataType, value)
  },
  mapResultValueContext: mapSqliteResultValue,
  mapParamValueContext: mapSqliteParamValue,
}

export { compileSqlite } from './compile'
export { inferSqliteColumnType } from './infer'
export { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
export { mapSqliteParamValue, mapSqliteResultValue } from './mapping'
export { normalizeSqliteDataType } from './normalize'
export {
  assertSafeSqliteDataType,
  formatSqliteDefault,
  formatSqliteLiteral,
  normalizeSqliteDefaultExpression,
} from './validate'
