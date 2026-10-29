import { inferSqliteColumnFacts } from './infer'
import { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
import { normalizeSqliteDataType, normalizeSqliteDefaultValue } from './normalize'

/** SQLite desired-schema lowering and physical type behavior. */
export const sqliteSchema = {
  lowerDesiredSchema: lowerSqliteDesiredSchema,
  inferColumnType: inferSqliteColumnFacts,
  normalizeDataType: normalizeSqliteDataType,
  normalizeDefaultValue: normalizeSqliteDefaultValue,
}
