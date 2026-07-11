import type { BaseIssue, BaseSchema, PipeItem } from 'valibot'

interface WrapperSchema {
  wrapped: BaseSchema<unknown, unknown, BaseIssue<unknown>>
}

/**
 * Unwraps optional/nullable/nullish wrappers and pipes to the base schema.
 *
 * @param schema - Schema that may be wrapped or piped
 * @returns Innermost base schema type
 *
 * @example
 * ```ts
 * const base = getBaseSchema(optional(pipe(string(), minLength(1))))
 * // string schema
 * ```
 */
export function getBaseSchema(
  schema: BaseSchema<unknown, unknown, BaseIssue<unknown>>,
): BaseSchema<unknown, unknown, BaseIssue<unknown>> {
  if (
    schema.type === 'optional' ||
    schema.type === 'nullable' ||
    schema.type === 'nullish' ||
    schema.type === 'non_optional' ||
    schema.type === 'non_nullable' ||
    schema.type === 'non_nullish'
  ) {
    const wrappedSchema = (schema as unknown as WrapperSchema).wrapped
    return getBaseSchema(wrappedSchema)
  }

  if (!('pipe' in schema)) {
    return schema
  }

  const pipeSchema = schema.pipe as readonly [
    BaseSchema<unknown, unknown, BaseIssue<unknown>>,
    ...PipeItem<unknown, unknown, BaseIssue<unknown>>[],
  ]

  const baseSchema = pipeSchema[0]

  if (
    baseSchema &&
    typeof baseSchema === 'object' &&
    baseSchema !== null &&
    'kind' in baseSchema &&
    baseSchema.kind === 'schema'
  ) {
    return getBaseSchema(
      baseSchema as BaseSchema<unknown, unknown, BaseIssue<unknown>>,
    )
  }

  return schema
}
