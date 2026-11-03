import { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
import { normalizeSqliteDataType } from './normalize'
import { inferSqliteColumnTypeFromFacts } from './storage'

/** SQLite desired-schema lowering and physical type behavior. */
export const sqliteSchema = {
  lowerDesiredSchema: lowerSqliteDesiredSchema,
  inferColumnType: inferSqliteColumnTypeFromFacts,
  normalizeDataType: normalizeSqliteDataType,
}
