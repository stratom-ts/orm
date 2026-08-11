import type { Equals } from '@/types/equals'

type ErrorHandlers<T> = {
  [K in Extract<T, { _tag: string }>['_tag']]?: (
    error: Extract<T, { _tag: K }>,
  ) => Exclude<T, { _tag: string }>
}

export type Attempt<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: unknown }>

/** Settles an asynchronous operation without introducing another error boundary. */
export async function attempt<T>(operation: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await operation() }
  } catch (error) {
    return { ok: false, error }
  }
}

/** Settles a synchronous operation without introducing another error boundary. */
export function attemptSync<T>(operation: () => T): Attempt<T> {
  try {
    return { ok: true, value: operation() }
  } catch (error) {
    return { ok: false, error }
  }
}

/**
 * Creates a tagged `Error` subclass with a fixed `_tag` discriminant.
 *
 * @example
 *   class NotFound extends TaggedError('NotFound')<{ id: string }> {}
 *   throw new NotFound({ id: '42' })
 *
 * @param tag - Discriminant string stored on instances as `_tag`
 *
 * @returns Error constructor that accepts optional payload fields
 */
export function TaggedError<Tag extends string>(
  tag: Tag,
): {
  new <A extends Record<string, unknown> = Record<string, unknown>>(
    ...args: Equals<A, Record<string, unknown>> extends true
      ? []
      : [
          args: {
            readonly [P in keyof A as P extends '_tag' ? never : P]: A[P]
          },
        ]
  ): Error & { readonly _tag: Tag } & Readonly<A>
} {
  class BaseError extends Error {
    readonly _tag = tag

    /**
     * Creates a tagged error from payload fields.
     *
     * @param args - Payload fields assigned to the error.
     */
    constructor(args: Record<string, unknown>) {
      super()
      if (args) {
        Object.assign(this, args)
      }
    }
  }
  BaseError.prototype.name = tag
  return BaseError as never
}

/**
 * Handles a tagged error when `value._tag` matches `tag`; otherwise returns `value`.
 *
 * @example
 *   const result = catchTag(err, 'MigrationError', (e) => e.message)
 *
 * @param value - Result or error that may carry `_tag`
 * @param tag - Tag to match.
 * @param callback - Handler invoked with the matching error.
 *
 * @returns Callback result, or `value` with that tag excluded from the type
 */
export function catchTag<T, E extends Extract<T, { _tag: string }>['_tag'], V>(
  value: T,
  tag: E,
  callback: (error: Extract<T, { _tag: E }>) => V,
) {
  if (value instanceof Error && '_tag' in value && value._tag === tag) {
    return callback(value as Extract<T, { _tag: E }>)
  }

  return value as Exclude<T, { _tag: E }>
}

/**
 * Dispatches a tagged error to a matching handler by `_tag`.
 *
 * @example
 *   const result = catchTags(err, {
 *     MigrationError: (e) => e.message,
 *   })
 *
 * @param value - Result or error that may carry `_tag`
 * @param handlers - Map of tag to handler.
 *
 * @returns Handler result, or `value` if no tag matched
 */
export function catchTags<T, E extends ErrorHandlers<T>>(value: T, handlers: E) {
  for (const [tag, callback] of Object.entries<(error: unknown) => unknown>(
    handlers as Record<string, (error: unknown) => unknown>,
  )) {
    if (value instanceof Error && '_tag' in value && value._tag === tag) {
      return callback(value) as Exclude<T, { _tag: keyof E }>
    }
  }

  return value as Exclude<T, { _tag: keyof E }>
}

/**
 * Error thrown when a migration cannot be applied safely.
 *
 * @example
 *   throw new MigrationError({ message: 'Cannot drop column with data' })
 */
export class MigrationError extends TaggedError('MigrationError')<{
  message: string
  cause?: unknown
  stage?: MigrationExecutionStage
  outcome?: MigrationExecutionOutcome
  retryable?: boolean
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
  cleanupFailures?: readonly MigrationCleanupFailure[]
}> {}

/** Observable stage at which migration execution stopped. */
export type MigrationExecutionStage =
  | 'lock'
  | 'transaction'
  | 'introspection'
  | 'planning'
  | 'permission'
  | 'lowering'
  | 'precondition'
  | 'ddl'
  | 'commit'
  | 'rollback'
  | 'unlock'
  | 'sessionCleanup'

/** Database effect known after a migration execution attempt. */
export type MigrationExecutionOutcome =
  | 'unchanged'
  | 'rolledBack'
  | 'applied'
  | 'partial'
  | 'unknown'

/** Secondary cleanup failure retained without replacing the primary cause. */
export type MigrationCleanupFailure = Readonly<{
  stage: 'rollback' | 'unlock' | 'sessionCleanup'
  cause: unknown
}>

/**
 * Error thrown when table/column metadata is invalid or incomplete.
 *
 * @example
 *   throw new SchemaError({ message: 'table() metadata is required' })
 */
export class SchemaError extends TaggedError('SchemaError')<{
  message: string
}> {}

/**
 * Error thrown when a query cannot be executed (closed client, driver failure, etc.).
 *
 * @example
 *   throw new QueryError({ message: 'Database has been closed' })
 */
export class QueryError extends TaggedError('QueryError')<{
  message: string
  cause?: unknown
}> {}

/**
 * Error thrown when insert/update payloads fail Valibot validation.
 *
 * @example
 *   throw new ValidationError({
 *     message: 'Invalid insert payload',
 *     issues: result.issues,
 *   })
 */
export class ValidationError extends TaggedError('ValidationError')<{
  message: string
  issues?: unknown
  cause?: unknown
}> {}

/** Error thrown when an internal contract or invariant is violated. */
export class InvariantError extends TaggedError('InvariantError')<{
  message: string
}> {
  constructor(message: string) {
    super({ message })
  }
}
