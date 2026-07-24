import type { CatalogSnapshot, Dialect } from '../types'

import { compilePostgres } from './compile'
import { inferPostgresColumnType } from './infer'
import { introspectPostgres } from './introspect'
import { mapPostgresParamValue, mapPostgresResultValue } from './mapping'
import { normalizePostgresDataType } from './normalize'

export { compilePostgres } from './compile'
export { inferPostgresColumnType } from './infer'
export { introspectPostgres } from './introspect'
export { mapPostgresParamValue, mapPostgresResultValue } from './mapping'
export { normalizePostgresDataType, postgresBaseType } from './normalize'
export { assertSafePostgresDataType, formatPostgresDefault } from './validate'

/**
 * PostgreSQL dialect plugin for the db0 stack.
 *
 * Provides type inference, SQL compilation, introspection, and value mapping
 * for PostgreSQL databases.
 *
 * @example```ts
 * import { postgresDialect } from '@/dialects/postgres'
 * import { resolveDialect } from '@/dialects'
 *
 * const dialect = resolveDialect('postgresql')
 * const query = dialect.compile({ kind: 'select_all', table: 'users' })
 * ```
 */
export const postgresDialect: Dialect = {
  id: 'postgresql',

  inferColumnType(schema) {
    return inferPostgresColumnType(schema)
  },

  normalizeDataType(dataType) {
    return normalizePostgresDataType(dataType)
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
