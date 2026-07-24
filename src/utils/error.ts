import type { Equals } from '@/types/equals'

type ErrorHandlers<T> = {
  [K in Extract<T, { _tag: string }>['_tag']]?: (
    error: Extract<T, { _tag: K }>,
  ) => Exclude<T, { _tag: string }>
}

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

export class MigrationError extends TaggedError('MigrationError')<{
  message: string
}> {}
