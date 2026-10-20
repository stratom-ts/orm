import { inferSqliteColumnType } from './infer'
import { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
import { normalizeSqliteDataType, normalizeSqliteDefaultValue } from './normalize'

/** SQLite desired-schema lowering and physical type behavior. */
export const sqliteSchema = {
  lowerDesiredSchema: lowerSqliteDesiredSchema,
  inferColumnType: inferSqliteColumnType,
  normalizeDataType: normalizeSqliteDataType,
  normalizeDefaultValue: normalizeSqliteDefaultValue,
}
