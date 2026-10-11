import type { CompiledQuery, OperationCommand } from './types'

/** Compiles the lifecycle SQL shared by PostgreSQL and SQLite operation sessions. */
export function compileCommonOperationCommand(command: OperationCommand): CompiledQuery {
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
