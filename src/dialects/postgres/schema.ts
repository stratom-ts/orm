import { lowerPostgresDesiredSchema } from './lowerDesiredSchema'
import { normalizePostgresDataType } from './normalize'
import { inferPostgresColumnTypeFromFacts } from './storage'

/** PostgreSQL desired-schema lowering and physical type behavior. */
export const postgresSchema = {
  lowerDesiredSchema: lowerPostgresDesiredSchema,
  inferColumnType: inferPostgresColumnTypeFromFacts,
  normalizeDataType: normalizePostgresDataType,
}
