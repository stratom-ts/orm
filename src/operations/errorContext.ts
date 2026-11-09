import type { OperationCommand } from '@/dialects'
import { DriverError, QueryError, isErrorTag } from '@/utils/error'

/** Adds safe operation context without changing native causes or cleanup evidence. */
export function contextualOperationError(cause: unknown, message: string): unknown {
  let contextual: DriverError | QueryError

  if (isErrorTag(cause, 'DriverError')) {
    contextual = new DriverError({
      message,
      dialect: cause.dialect,
      ...(cause.code === undefined ? {} : { code: cause.code }),
      sql: cause.sql,
      cause: cause.cause,
      ...(cause.cleanupFailures ? { cleanupFailures: cause.cleanupFailures } : {}),
      kind: cause.kind,
      retryable: cause.retryable,
      ...(cause.constraint === undefined ? {} : { constraint: cause.constraint }),
      ...(cause.table === undefined ? {} : { table: cause.table }),
      ...(cause.columns === undefined ? {} : { columns: cause.columns }),
    })
  } else if (isErrorTag(cause, 'QueryError')) {
    contextual = new QueryError({
      message: `${message}: ${cause.message}`,
      cause,
      ...(cause.cleanupFailures ? { cleanupFailures: cause.cleanupFailures } : {}),
    })
  } else return cause

  return contextual
}

/** Formats portable lifecycle context without parsing emitted SQL. */
export function operationCommandErrorMessage(
  dialectId: string,
  command: OperationCommand,
): string {
  if (command.kind === 'ping') return `${dialectId} database ping failed`

  if ('id' in command)
    return `${dialectId} transaction ${command.kind} savepoint ${command.id} failed`

  return `${dialectId} database transaction ${command.kind} failed`
}
