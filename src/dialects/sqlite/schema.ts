import { inferSqliteColumnTypeFromFacts } from './infer'
import { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
import { normalizeSqliteDataType } from './normalize'

/** SQLite desired-schema lowering and physical type behavior. */
export const sqliteSchema = {
  lowerDesiredSchema: lowerSqliteDesiredSchema,
  inferColumnType: inferSqliteColumnTypeFromFacts,
  normalizeDataType: normalizeSqliteDataType,
}
