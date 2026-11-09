import { enrichMigrationError } from '@/migrations/migrationDiagnostics'
import type { MigrationCleanupFailure } from '@/utils/error'
import { DriverError, QueryError, TaggedError, isErrorTag } from '@/utils/error'

/** Internal envelope for a primary defect accompanied by secondary cleanup failures. */
class OperationCleanupError extends TaggedError('OperationCleanupError')<{
  message: string
  cause: unknown
  cleanupFailures: readonly MigrationCleanupFailure[]
}> {}

/** Returns the primary rejection when cleanup required an internal envelope. */
export function operationPrimaryFailure(error: unknown): unknown {
  return error instanceof OperationCleanupError ? error.cause : error
}

/** Reads cleanup evidence carried directly by a structured failure. */
export function operationCleanupFailures(
  error: unknown,
): readonly MigrationCleanupFailure[] {
  if (
    error instanceof OperationCleanupError ||
    isErrorTag(error, 'MigrationError') ||
    isErrorTag(error, 'QueryError') ||
    isErrorTag(error, 'DriverError')
  )
    return error.cleanupFailures ?? []

  return []
}

/** Adds cleanup evidence without mutating the primary failure or hiding its diagnostics. */
export function withOperationCleanupFailure(error: unknown, failure: unknown): unknown {
  const cleanupFailures = [
    ...operationCleanupFailures(error),
    { stage: 'sessionCleanup' as const, cause: failure },
  ]

  const primary = operationPrimaryFailure(error)

  if (isErrorTag(primary, 'DriverError')) {
    return new DriverError({
      message: primary.message,
      dialect: primary.dialect,
      sql: primary.sql,
      code: primary.code,
      cause: primary.cause,
      kind: primary.kind,
      retryable: primary.retryable,
      constraint: primary.constraint,
      table: primary.table,
      columns: primary.columns,
      cleanupFailures,
    })
  }

  if (isErrorTag(primary, 'QueryError'))
    return new QueryError({ message: primary.message, cause: primary, cleanupFailures })

  if (isErrorTag(primary, 'MigrationError')) {
    return enrichMigrationError(primary, {
      cleanupFailures: [{ stage: 'sessionCleanup', cause: failure }],
    })
  }

  return new OperationCleanupError({
    message: 'Operation failed and session cleanup also failed',
    cause: primary,
    cleanupFailures,
  })
}
