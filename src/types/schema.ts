import type { BaseIssue, BaseSchema, BaseSchemaAsync } from 'valibot'

/** Any Valibot schema, irrespective of its input/output/issue types. */
export type AnySchema = BaseSchema<unknown, unknown, BaseIssue<unknown>>

/** Any Valibot async schema, irrespective of its input/output/issue types. */
export type AnySchemaAsync = BaseSchemaAsync<unknown, unknown, BaseIssue<unknown>>
