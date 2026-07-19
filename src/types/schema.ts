import type { BaseIssue, BaseSchema } from 'valibot'

/** Any Valibot schema, irrespective of its input/output/issue types. */
export type AnySchema = BaseSchema<unknown, unknown, BaseIssue<unknown>>
