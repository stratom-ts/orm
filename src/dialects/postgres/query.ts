import { quoteIdentifier } from './compile'
import {
  mapPostgresParamValue,
  mapPostgresResultValue,
  validatePostgresValueMapping,
} from './mapping'
import { resolvePostgresQuery } from './queryAddressing'
import { resolvePostgresNumericAssignment } from './storage'

/** PostgreSQL query addressing and value mapping. */
export const postgresQuery = {
  rawSql: {
    quoteIdentifier,
    placeholder: (position: number): string => `$${position}`,
  },
  numericAssignmentType: resolvePostgresNumericAssignment,
  validateValueMapping: validatePostgresValueMapping,
  resolve: resolvePostgresQuery,
  mapResultValue: mapPostgresResultValue,
  mapParamValue: mapPostgresParamValue,
}
