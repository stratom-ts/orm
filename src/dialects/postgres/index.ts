import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type {
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import {
  POSTGRES_PHYSICAL_NAMING,
  createPhysicalNameRegistry,
  generatePhysicalName,
  validatePhysicalName,
} from '@/migrations/physicalNaming'

import type { Dialect } from '../types'

import { compilePostgres } from './compile'
import { inferPostgresColumnType } from './infer'
import { introspectPostgres } from './introspect'
import { lowerPostgresDesiredSchema } from './lowerDesiredSchema'
import { mapPostgresParamValue, mapPostgresResultValue } from './mapping'
import { executePostgresMigration, lowerPostgresMigrationPlan } from './migration'
import { normalizePostgresDataType } from './normalize'
import { createDb0PostgresqlOperationSessionProvider } from './operationSession'
import { formatPostgresDefault, normalizePostgresDefaultExpression } from './validate'

export { createDb0PostgresqlOperationSessionProvider } from './operationSession'

const POSTGRES_IDENTITY = 'postgresql' as const

const POSTGRES_IDENTITY_MODULE = {
  create(options: {
    context: NamespaceContext
    registrationDefault?: readonly NamespaceIdentifierInput[]
  }) {
    return createCanonicalRelationIdentityModule({
      adapter: POSTGRES_IDENTITY,
      ...options,
    })
  },
}

const POSTGRES_NAMING = {
  generate: (seed: Parameters<typeof generatePhysicalName>[0]) =>
    generatePhysicalName(seed, POSTGRES_PHYSICAL_NAMING),
  validate: (name: string, description: string) =>
    validatePhysicalName(name, description, POSTGRES_PHYSICAL_NAMING),
  createRegistry: () => createPhysicalNameRegistry(POSTGRES_PHYSICAL_NAMING),
}

const normalizePostgresDefaultValue = (value: string | number | boolean | null) =>
  normalizePostgresDefaultExpression(formatPostgresDefault(value))

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
  identity: POSTGRES_IDENTITY_MODULE,
  naming: POSTGRES_NAMING,
  schema: {
    lowerDesiredSchema: lowerPostgresDesiredSchema,
    inferColumnType: inferPostgresColumnType,
    normalizeDataType: normalizePostgresDataType,
    normalizeDefaultValue: normalizePostgresDefaultValue,
  },
  query: {
    compile: compilePostgres,
    mapResultValue: mapPostgresResultValue,
    mapParamValue: mapPostgresParamValue,
  },
  catalog: { introspectCatalog: introspectPostgres },
  operations: {
    createSessionProvider: createDb0PostgresqlOperationSessionProvider,
  },
  migration: {
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
  relationIdentity: POSTGRES_IDENTITY,
}
