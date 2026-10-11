import { inferSqliteColumnType } from './infer'
import { lowerSqliteDesiredSchema } from './lowerDesiredSchema'
import { normalizeSqliteDataType } from './normalize'
import { normalizeSqliteDefaultValue } from './validate'

/** SQLite desired-schema lowering and physical type behavior. */
export const sqliteSchema = {
  lowerDesiredSchema: lowerSqliteDesiredSchema,
  inferColumnType: inferSqliteColumnType,
  normalizeDataType: normalizeSqliteDataType,
  normalizeDefaultValue: normalizeSqliteDefaultValue,
}
