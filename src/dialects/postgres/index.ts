import type { Dialect } from '../types'

import { compilePostgres } from './compile'
import { inferPostgresColumnType } from './infer'
import { introspectPostgres } from './introspect'
import { lowerPostgresDesiredSchema } from './lowerDesiredSchema'
import { mapPostgresParamValue, mapPostgresResultValue } from './mapping'
import { executePostgresMigration, lowerPostgresMigrationPlan } from './migration'
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
 *   const query = postgresDialect.compile({
 *     kind: 'select',
 *     table: 'users',
 *     selection: [{ kind: 'all' }],
 *   })
 */
export const postgresDialect: Dialect = {
  id: 'postgresql',
  relationIdentity: 'postgresql',
  catalog: { introspectCatalog: introspectPostgres },
  migration: {
    lower: lowerPostgresMigrationPlan,
    execute: executePostgresMigration,
  },

  /**
   * Lowers an authored schema into PostgreSQL table ASTs.
   *
   * @example
   *   postgresDialect.lowerDesiredSchema(authoredSchema)
   *
   * @param graph - Canonically registered authored schema graph.
   */
  lowerDesiredSchema(graph) {
    return lowerPostgresDesiredSchema(graph)
  },

  /**
   * Infers the PostgreSQL data type for a column schema.
   *
   * @example
   *   postgresDialect.inferColumnType(string()) // 'text'
   *
   * @param schema - Column schema to inspect.
   */
  inferColumnType(schema) {
    return inferPostgresColumnType(schema)
  },

  /**
   * Normalizes a PostgreSQL data type for comparison.
   *
   * @example
   *   postgresDialect.normalizeDataType('int4') // 'integer'
   *
   * @param dataType - PostgreSQL data type to normalize.
   */
  normalizeDataType(dataType) {
    return normalizePostgresDataType(dataType)
  },

  /**
   * Formats and normalizes a declared PostgreSQL default value.
   *
   * @example
   *   postgresDialect.normalizeDefaultValue('now()') // 'now()'
   *
   * @param value - Declared default value.
   */
  normalizeDefaultValue(value) {
    return normalizePostgresDefaultExpression(formatPostgresDefault(value))
  },

  /**
   * Compiles a SQL AST node into a PostgreSQL query.
   *
   * @example
   *   postgresDialect.compile({ kind: 'select', table: 'users', selection: [{ kind: 'all' }] })
   *
   * @param node - SQL AST node to compile.
   */
  compile(node) {
    return compilePostgres(node)
  },

  /**
   * Maps a PostgreSQL result value to its JavaScript representation.
   *
   * @example
   *   postgresDialect.mapResultValue('jsonb', '{"active":true}')
   *
   * @param dataType - PostgreSQL result data type.
   * @param value - Raw database result value.
   */
  mapResultValue(dataType, value) {
    return mapPostgresResultValue(dataType, value)
  },

  /**
   * Maps a JavaScript value to its PostgreSQL parameter representation.
   *
   * @example
   *   postgresDialect.mapParamValue('jsonb', { active: true })
   *
   * @param dataType - PostgreSQL parameter data type.
   * @param value - JavaScript value to map.
   */
  mapParamValue(dataType, value) {
    return mapPostgresParamValue(dataType, value)
  },
}
