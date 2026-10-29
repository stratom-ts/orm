import type { AnySchema } from '@/types/schema'

const WRAPPERS = new Set([
  'optional',
  'exact_optional',
  'undefinedable',
  'nullable',
  'nullish',
  'non_optional',
  'non_nullable',
  'non_nullish',
])

/** Unwraps native authoring schemas, optionally descending through pipeline heads. */
export function unwrapSchema(schema: AnySchema, pipes: boolean): AnySchema {
  const node = schema as AnySchema & { wrapped?: AnySchema; pipe?: readonly AnySchema[] }

  if (WRAPPERS.has(schema.type) && node.wrapped) return unwrapSchema(node.wrapped, pipes)

  const first = node.pipe?.[0]

  if (first && (pipes || WRAPPERS.has(schema.type))) return unwrapSchema(first, pipes)

  return schema
}
