import type { MigrationCapabilityIssue } from '@/ddl/migrationProgram'

import { SqliteValidationError } from '../validate'

/** Internal control-flow error for a known SQLite migration limitation. */
export class SqliteMigrationCapabilityError extends Error {
  readonly _tag = 'SqliteMigrationCapabilityError'

  constructor(
    readonly code: MigrationCapabilityIssue['code'],
    message: string,
  ) {
    super(message)
    this.name = 'SqliteMigrationCapabilityError'
  }
}

/** Raises a recognized capability issue while compiling a SQLite migration. */
export function capabilityError(message: string): SqliteMigrationCapabilityError {
  return new SqliteMigrationCapabilityError('compile_failure', message)
}

/** Converts only known validator failures into migration capability control flow. */
export function capabilityCheck<T>(
  operation: () => T,
  code: MigrationCapabilityIssue['code'] = 'compile_failure',
): T {
  try {
    return operation()
  } catch (cause) {
    if (cause instanceof SqliteValidationError && cause.defect !== true)
      throw new SqliteMigrationCapabilityError(code, cause.message)

    throw cause
  }
}
