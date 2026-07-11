import type { Equals } from '@/types/equals'

type ErrorHandlers<T> = {
  [K in Extract<T, { _tag: string }>['_tag']]?: (
    error: Extract<T, { _tag: K }>,
  ) => Exclude<T, { _tag: string }>
}

/**
 * Creates a tagged `Error` subclass with a fixed `_tag` discriminant.
 *
 * @param tag - Discriminant string stored on instances as `_tag`
 * @returns Error constructor that accepts optional payload fields
 *
 * @example
 * ```ts
 * class NotFound extends TaggedError('NotFound')<{ id: string }> {}
 * throw new NotFound({ id: '42' })
 * ```
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
 * @param value - Result or error that may carry `_tag`
 * @param tag - Tag to match
 * @param callback - Handler invoked with the matching error
 * @returns Callback result, or `value` with that tag excluded from the type
 *
 * @example
 * ```ts
 * const result = catchTag(err, 'MigrationError', (e) => e.message)
 * ```
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
 * @param value - Result or error that may carry `_tag`
 * @param handlers - Map of tag to handler
 * @returns Handler result, or `value` if no tag matched
 *
 * @example
 * ```ts
 * const result = catchTags(err, {
 *   MigrationError: (e) => e.message,
 * })
 * ```
 */
export function catchTags<T, E extends ErrorHandlers<T>>(
  value: T,
  handlers: E,
) {
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
 * ```ts
 * throw new MigrationError({ message: 'Cannot drop column with data' })
 * ```
 */
export class MigrationError extends TaggedError('MigrationError')<{
  message: string
}> {}
