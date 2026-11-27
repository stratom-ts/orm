import { compileCommonOperationCommand } from '../operations'
import type { CompiledQuery, OperationCommand } from '../types'

import { createDb0PostgresOperationSessionProvider } from './operationSession'

/**
 * Compiles PostgreSQL operation lifecycle commands without exposing physical policy to
 * Client.
 */
export function compilePostgresOperationCommand(
  command: OperationCommand,
): CompiledQuery {
  if (
    command.kind === 'begin' &&
    command.isolationLevel === 'serializable' &&
    command.behavior === undefined
  ) {
    return { sql: 'begin isolation level serializable', params: [] }
  }

  return compileCommonOperationCommand(command)
}

/** PostgreSQL operation-session adaptation and lifecycle command compilation. */
export const postgresOperations = {
  createSessionProvider: createDb0PostgresOperationSessionProvider,
  compile: compilePostgresOperationCommand,
  cursor: {
    declare: (name: string, query: CompiledQuery): CompiledQuery => ({
      ...query,
      sql: `DECLARE "${name}" NO SCROLL CURSOR WITHOUT HOLD FOR ${query.sql}`,
    }),
    fetch: (name: string, count: number): CompiledQuery => ({
      sql: `FETCH FORWARD ${count} FROM "${name}"`,
      params: [],
    }),
    close: (name: string): CompiledQuery => ({ sql: `CLOSE "${name}"`, params: [] }),
  },
}
