import type { CatalogSnapshot, Dialect } from '../types'

import { compilePostgres } from './compile'
import { inferPostgresColumnType } from './infer'
import { introspectPostgres } from './introspect'
import { mapPostgresParamValue, mapPostgresResultValue } from './mapping'
import { normalizePostgresDataType } from './normalize'
import { formatPostgresDefault, normalizePostgresDefaultExpression } from './validate'

/**
 * PostgreSQL dialect plugin for the db0 stack.
 *
 * Provides type inference, SQL compilation, introspection, and value mapping
 * for PostgreSQL databases.
 *
 * @example
 *   import { postgresDialect } from '@/dialects/postgres'
 *
 *   const query = postgresDialect.compile({ kind: 'select_all', table: 'users' })
 */
export const postgresDialect: Dialect = {
  id: 'postgresql',
  relationIdentity: 'postgresql',

  inferColumnType(schema) {
    return inferPostgresColumnType(schema)
  },

  normalizeDataType(dataType) {
    return normalizePostgresDataType(dataType)
  },

  normalizeDefaultValue(value) {
    return normalizePostgresDefaultExpression(formatPostgresDefault(value))
  },

  async introspect(executor: unknown): Promise<CatalogSnapshot> {
    return introspectPostgres(executor)
  },

  compile(node) {
    return compilePostgres(node)
  },

  mapResultValue(dataType, value) {
    return mapPostgresResultValue(dataType, value)
  },

  mapParamValue(dataType, value) {
    return mapPostgresParamValue(dataType, value)
  },
}
