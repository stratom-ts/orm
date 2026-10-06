import type { SQLDialect } from 'db0'

import { SchemaError } from '@/utils/error'

import { postgresDialect } from './postgres'
import { sqliteDialect } from './sqlite'
import type { Dialect } from './types'

const DIALECTS = new Map<string, Dialect>([
  [postgresDialect.id, postgresDialect],
  [sqliteDialect.id, sqliteDialect],
])

/**
 * Registers an isolated contract-test dialect and returns exact cleanup.
 *
 * This seam intentionally is not exported by the dialect barrel: production support
 * remains the static registration above.
 */
export function registerDialectForTest(dialect: Dialect): () => void {
  if (
    typeof dialect.id !== 'string' ||
    dialect.id.length === 0 ||
    dialect.id.trim() !== dialect.id ||
    dialect.id.includes('\0')
  ) {
    throw new SchemaError({ message: 'dialect id must be a non-empty identifier' })
  }

  if (DIALECTS.has(dialect.id)) {
    throw new SchemaError({ message: `dialect "${dialect.id}" is already registered` })
  }

  DIALECTS.set(dialect.id, dialect)

  return () => {
    if (DIALECTS.get(dialect.id) === dialect) DIALECTS.delete(dialect.id)
  }
}

/**
 * Resolves a db0 connector dialect id to a stratom dialect plugin.
 *
 * @example
 *   const dialect = resolveDialect('postgresql')
 *
 * @param id - Database dialect identifier from the db0 connector.
 *
 * @returns Dialect plugin for the given connector
 *
 * @throws SchemaError - When the connector dialect is not supported
 */
export function resolveDialect(id: SQLDialect): Dialect {
  const dialect = DIALECTS.get(id)

  if (!dialect) {
    throw new SchemaError({
      message: `unsupported connector dialect "${id}"; supported: ${[...DIALECTS.keys()].join(', ')}`,
    })
  }

  return dialect
}
