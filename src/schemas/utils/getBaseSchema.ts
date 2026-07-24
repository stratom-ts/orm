import type { BaseIssue, BaseSchema, PipeItem } from 'valibot'

interface WrapperSchema {
  wrapped: BaseSchema<unknown, unknown, BaseIssue<unknown>>
}

/**
 * Get the base schema from wrapper schemas (optional, nullable, nullish, etc.).
 *
 * Recursively unwraps wrapper schemas to find the underlying base schema type.
 * Handles wrapper types like optional, nullable, nullish, and their non-* variants.
 *
 * @param schema - The schema to extract the base type from
 * @returns The unwrapped base schema
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
