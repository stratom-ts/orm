import type { CompiledQuery, OperationCommand } from '../types'

import { createDb0PostgresOperationSessionProvider } from './operationSession'

/**
 * Compiles PostgreSQL operation lifecycle commands without exposing physical policy to
 * Client.
 */
export function compilePostgresOperationCommand(
  command: OperationCommand,
): CompiledQuery {
  switch (command.kind) {
    case 'ping':
      return { sql: 'select 1', params: [] }
    case 'begin':
    case 'commit':
    case 'rollback':
      return { sql: command.kind, params: [] }
    case 'createSavepoint':
      return { sql: `savepoint sp_${command.id}`, params: [] }
    case 'rollbackToSavepoint':
      return { sql: `rollback to savepoint sp_${command.id}`, params: [] }
    case 'releaseSavepoint':
      return { sql: `release savepoint sp_${command.id}`, params: [] }
  }
}

/** PostgreSQL operation-session adaptation and lifecycle command compilation. */
export const postgresOperations = {
  createSessionProvider: createDb0PostgresOperationSessionProvider,
  compile: compilePostgresOperationCommand,
}
