import { mapPostgresParamValue, mapPostgresResultValue } from './mapping'
import { resolvePostgresQuery } from './queryAddressing'

/** PostgreSQL query addressing and value mapping. */
export const postgresQuery = {
  resolve: resolvePostgresQuery,
  mapResultValue: mapPostgresResultValue,
  mapParamValue: mapPostgresParamValue,
}
