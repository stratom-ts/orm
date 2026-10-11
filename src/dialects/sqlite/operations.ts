import type { CompiledQuery, OperationCommand } from '../types'

import { createDb0NodeSqliteOperationSessionProvider } from './operationSession'

/** Compiles SQLite lifecycle commands for the pinned native operation session. */
export function compileSqliteOperationCommand(command: OperationCommand): CompiledQuery {
  switch (command.kind) {
    case 'ping':
      return { sql: 'select 1', params: [] }
    case 'begin':
      return { sql: 'begin', params: [] }
    case 'commit':
      return { sql: 'commit', params: [] }
    case 'rollback':
      return { sql: 'rollback', params: [] }
    case 'createSavepoint':
      return { sql: `savepoint sp_${command.id}`, params: [] }
    case 'rollbackToSavepoint':
      return { sql: `rollback to savepoint sp_${command.id}`, params: [] }
    case 'releaseSavepoint':
      return { sql: `release savepoint sp_${command.id}`, params: [] }
  }
}

/** SQLite operation-session adaptation and lifecycle command compilation. */
export const sqliteOperations = {
  createSessionProvider: createDb0NodeSqliteOperationSessionProvider,
  compile: compileSqliteOperationCommand,
}
