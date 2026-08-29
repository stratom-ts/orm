import type { Dialect } from '../types'

import { compilePostgres } from './compile'
import { postgresIdentity } from './identity'
import { inferPostgresColumnType } from './infer'
import { introspectPostgres } from './introspect'
import { lowerPostgresDesiredSchema } from './lowerDesiredSchema'
import { mapPostgresParamValue, mapPostgresResultValue } from './mapping'
import { executePostgresMigration, lowerPostgresMigrationPlan } from './migration'
import { postgresNaming } from './naming'
import { normalizePostgresDataType } from './normalize'
import { createDb0PostgresqlOperationSessionProvider } from './operationSession'
import { formatPostgresDefault, normalizePostgresDefaultExpression } from './validate'

export { createDb0PostgresqlOperationSessionProvider } from './operationSession'

const normalizePostgresDefaultValue = (value: string | number | boolean | null) =>
  normalizePostgresDefaultExpression(formatPostgresDefault(value))

const postgresSchema = {
  lowerDesiredSchema: lowerPostgresDesiredSchema,
  inferColumnType: inferPostgresColumnType,
  normalizeDataType: normalizePostgresDataType,
  normalizeDefaultValue: normalizePostgresDefaultValue,
}

const postgresCatalog = { introspectCatalog: introspectPostgres }

const postgresMigrationPlanning = {
  identity: postgresIdentity,
  naming: postgresNaming,
  schema: postgresSchema,
}

/**
 * Complete PostgreSQL dialect member for the db0 stack.
 *
 * Provides PostgreSQL identity, naming, schema, query, catalog, operation-session,
 * and migration behavior through cohesive facets.
 *
 * @example
 *   import { postgresDialect } from '@/dialects/postgres'
 *
 *   const query = postgresDialect.query.compile({
 *     kind: 'select',
 *     table: 'users',
 *     selection: [{ kind: 'all' }],
 *   })
 */
export const postgresDialect: Dialect = {
  id: 'postgresql',
  identity: postgresIdentity,
  naming: postgresNaming,
  schema: postgresSchema,
  query: {
    compile: compilePostgres,
    mapResultValue: mapPostgresResultValue,
    mapParamValue: mapPostgresParamValue,
  },
  catalog: postgresCatalog,
  operations: {
    createSessionProvider: createDb0PostgresqlOperationSessionProvider,
  },
  migration: {
    planning: postgresMigrationPlanning,
    catalog: postgresCatalog,
    lower: lowerPostgresMigrationPlan,
    execute: executePostgresMigration,
  },

  /** @deprecated Use `schema.lowerDesiredSchema`. */
  lowerDesiredSchema: lowerPostgresDesiredSchema,
  /** @deprecated Use `schema.inferColumnType`. */
  inferColumnType: inferPostgresColumnType,
  /** @deprecated Use `schema.normalizeDataType`. */
  normalizeDataType: normalizePostgresDataType,
  /** @deprecated Use `schema.normalizeDefaultValue`. */
  normalizeDefaultValue: normalizePostgresDefaultValue,
  /** @deprecated Use `query.compile`. */
  compile: compilePostgres,
  /** @deprecated Use `query.mapResultValue`. */
  mapResultValue: mapPostgresResultValue,
  /** @deprecated Use `query.mapParamValue`. */
  mapParamValue: mapPostgresParamValue,
  /** @deprecated Use `identity`. */
  relationIdentity: postgresIdentity.id,
}
