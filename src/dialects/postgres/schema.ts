import { inferPostgresColumnType } from './infer'
import { lowerPostgresDesiredSchema } from './lowerDesiredSchema'
import { normalizePostgresDataType } from './normalize'
import { formatPostgresDefault, normalizePostgresDefaultExpression } from './validate'

/** Formats and normalizes a primitive PostgreSQL column default. */
const normalizePostgresDefaultValue = (value: string | number | boolean | null) =>
  normalizePostgresDefaultExpression(formatPostgresDefault(value))

/** PostgreSQL desired-schema lowering and physical type behavior. */
export const postgresSchema = {
  lowerDesiredSchema: lowerPostgresDesiredSchema,
  inferColumnType: inferPostgresColumnType,
  normalizeDataType: normalizePostgresDataType,
  normalizeDefaultValue: normalizePostgresDefaultValue,
}
