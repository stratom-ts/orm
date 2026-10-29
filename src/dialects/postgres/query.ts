import { quoteIdentifier } from './compile'
import {
  mapPostgresParamValue,
  mapPostgresResultValue,
  validatePostgresValueMapping,
} from './mapping'
import { resolvePostgresQuery } from './queryAddressing'

/** PostgreSQL query addressing and value mapping. */
export const postgresQuery = {
  rawSql: {
    quoteIdentifier,
    placeholder: (position: number): string => `$${position}`,
  },
  validateValueMapping: validatePostgresValueMapping,
  resolve: resolvePostgresQuery,
  mapResultValue: mapPostgresResultValue,
  mapParamValue: mapPostgresParamValue,
}
