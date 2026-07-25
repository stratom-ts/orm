import type { BaseIssue, PipeItem } from 'valibot'

import type { AnySchema } from '@/types/schema'

interface WrapperSchema {
  wrapped: AnySchema
}

/**
 * Unwraps optional/nullable/nullish wrappers and pipes to the base schema.
 *
 * @example
 *   const base = getBaseSchema(optional(pipe(string(), minLength(1))))
 *   // string schema
 *
 * @param schema - Schema that may be wrapped or piped.
 *
 * @returns Innermost base schema type
 */
export function getBaseSchema(schema: AnySchema): AnySchema {
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
    AnySchema,
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
    return getBaseSchema(baseSchema as AnySchema)
  }

  return schema
}
