import { defineDialect } from '../defineDialect'

import { postgresCatalog } from './catalog'
import { postgresClassifyDriverError } from './classifyDriverError'
import { postgresIdentity } from './identity'
import { executePostgresMigration, lowerPostgresMigrationPlan } from './migration'
import { postgresNaming } from './naming'
import { postgresOperations } from './operations'
import { postgresQuery } from './query'
import { postgresSchema } from './schema'

/**
 * Complete PostgreSQL dialect member for the db0 stack.
 *
 * Provides PostgreSQL identity, naming, schema, query, catalog, operation-session,
 * and migration behavior through cohesive facets.
 *
 * @example
 *   import { postgresDialect } from '@/dialects/postgres'
 *
 *   const query = postgresDialect.query.resolve([]).compile({
 *     kind: 'select',
 *     relation: { relation: 'users' },
 *     selection: [{ kind: 'all' }],
 *   })
 */
export const postgresDialect = /* @__PURE__ */ defineDialect({
  id: 'postgresql',
  classifyDriverError: postgresClassifyDriverError,
  identity: postgresIdentity,
  naming: postgresNaming,
  schema: postgresSchema,
  query: postgresQuery,
  catalog: postgresCatalog,
  operations: postgresOperations,
  lower: lowerPostgresMigrationPlan,
  execute: executePostgresMigration,
})
