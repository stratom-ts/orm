import { inferPostgresColumnType } from './infer'
import { lowerPostgresDesiredSchema } from './lowerDesiredSchema'
import { normalizePostgresDataType, normalizePostgresDefaultValue } from './normalize'

/** PostgreSQL desired-schema lowering and physical type behavior. */
export const postgresSchema = {
  lowerDesiredSchema: lowerPostgresDesiredSchema,
  inferColumnType: inferPostgresColumnType,
  normalizeDataType: normalizePostgresDataType,
  normalizeDefaultValue: normalizePostgresDefaultValue,
}
