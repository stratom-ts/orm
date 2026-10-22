import {
  mapPostgresParamValue,
  mapPostgresResultValue,
  validatePostgresValueMapping,
} from './mapping'
import { resolvePostgresQuery } from './queryAddressing'

/** PostgreSQL query addressing and value mapping. */
export const postgresQuery = {
  validateValueMapping: validatePostgresValueMapping,
  resolve: resolvePostgresQuery,
  mapResultValue: mapPostgresResultValue,
  mapParamValue: mapPostgresParamValue,
}
