import { compileCommonOperationCommand } from '../operations'
import type { CompiledQuery, OperationCommand } from '../types'

import { createDb0NodeSqliteOperationSessionProvider } from './operationSession'

/** Compiles SQLite lifecycle commands for the pinned native operation session. */
export function compileSqliteOperationCommand(command: OperationCommand): CompiledQuery {
  return compileCommonOperationCommand(command)
}

/** SQLite operation-session adaptation and lifecycle command compilation. */
export const sqliteOperations = {
  createSessionProvider: createDb0NodeSqliteOperationSessionProvider,
  compile: compileSqliteOperationCommand,
}
