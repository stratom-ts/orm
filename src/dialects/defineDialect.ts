import type { DialectMigrationAdapter } from '@/ddl/migrationProgram'

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
    query,
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
