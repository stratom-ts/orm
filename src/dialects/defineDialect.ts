import type { DialectMigrationAdapter } from '@/ddl/migrationProgram'

import { compileColumnQuery } from './columnQuery'
import type { Dialect } from './types'

type DialectDefinition = Omit<Dialect, 'migration'> &
  Pick<DialectMigrationAdapter, 'lower' | 'execute'>

/** Binds one dialect's facets to its derived Migration adapter. */
export function defineDialect({
  id,
  classifyDriverError,
  identity,
  naming,
  schema,
  query,
  catalog,
  operations,
  lower,
  execute,
}: DialectDefinition): Dialect {
  return {
    id,
    classifyDriverError,
    identity,
    naming,
    schema,
    query: {
      rawSql: query.rawSql,
      validateValueMapping: query.validateValueMapping?.bind(query),
      mapParamValue: query.mapParamValue?.bind(query),
      mapResultValue: query.mapResultValue?.bind(query),
      resolve(handles, options) {
        const resolved = query.resolve(handles, options)
        return {
          compile: (node) => compileColumnQuery(resolved, node),
          findRelationMatches: resolved.findRelationMatches.bind(resolved),
          findColumnMatches: resolved.findColumnMatches.bind(resolved),
        }
      },
    },
    catalog,
    operations,
    migration: {
      planning: { identity, naming, schema },
      catalog,
      lower,
      execute,
    },
  }
}
