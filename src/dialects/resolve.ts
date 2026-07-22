import type { SQLDialect } from 'db0'

import { SchemaError } from '@/utils/error'

import { postgresDialect } from './postgres'
import type { Dialect } from './types'

const DIALECTS: Partial<Record<SQLDialect, Dialect>> = {
  postgresql: postgresDialect,
}

/**
 * Resolves a db0 connector dialect id to a stratom dialect plugin.
 *
 * @throws SchemaError - When the connector dialect is not supported
 */
export function resolveDialect(id: SQLDialect): Dialect {
  const dialect = DIALECTS[id]
  if (!dialect) {
    throw new SchemaError({
      message: `unsupported connector dialect "${id}"; supported: postgresql`,
    })
  }
  return dialect
}
