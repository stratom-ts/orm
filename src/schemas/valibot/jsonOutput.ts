import type { AnySchema } from '@/types/schema'

type JsonSchema = AnySchema & {
  wrapped?: AnySchema
  pipe?: readonly { kind: string }[]
  default?: unknown
  fallback?: unknown
  entries?: Record<string, AnySchema>
  item?: AnySchema
  items?: readonly AnySchema[]
  key?: AnySchema
  value?: AnySchema
  rest?: AnySchema
  options?: readonly AnySchema[]
  literal?: unknown
}

const NULL = JSON.stringify(['literal', null])
const UNDEFINED = JSON.stringify(['undefined'])
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

/** Sorts alternatives independently of schema and object declaration order. */
function canonical(options: readonly string[]): string {
  return JSON.stringify([...new Set(options)].sort())
}

/** Captures literal distinctions without conflating JSON values and type names. */
function literal(value: unknown): string[] | undefined {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return [JSON.stringify(['literal', value])]

  return undefined
}

/** Keeps nested optionality and nullability while ignoring SQL column wrappers. */
function wrappedOutput(
  schema: JsonSchema,
  seen: Set<AnySchema>,
  column: boolean,
): string[] | undefined {
  if (!schema.wrapped) return undefined

  const inner = alternatives(schema.wrapped, seen, column)

  if (!inner || column) return inner
  if (typeof schema.default === 'function') return undefined

  const result = [...inner]

  if (schema.type === 'non_optional' || schema.type === 'non_nullish')
    return result.filter(
      (value) => value !== UNDEFINED && (schema.type !== 'non_nullish' || value !== NULL),
    )

  if (schema.type === 'non_nullable') return result.filter((value) => value !== NULL)

  if (
    (schema.type === 'nullable' || schema.type === 'nullish') &&
    (schema.default === undefined || schema.default === null)
  )
    result.push(NULL)

  if (
    ['optional', 'exact_optional', 'undefinedable', 'nullish'].includes(schema.type) &&
    schema.default === undefined
  )
    result.push(UNDEFINED)

  return result
}

/** Records each member's complete output alternatives rather than only its family. */
function members(
  schemas: readonly AnySchema[],
  seen: Set<AnySchema>,
): string[] | undefined {
  const outputs = schemas.map((schema) => alternatives(schema, seen, false))
  return outputs.every((output) => output !== undefined)
    ? outputs.map(canonical)
    : undefined
}

/** Proves known JSON object fields, including optional fields and typed rest values. */
function objectOutput(schema: JsonSchema, seen: Set<AnySchema>): string[] | undefined {
  const entries = Object.entries(schema.entries ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )

  const outputs = members(
    entries.map(([, value]) => value),
    seen,
  )

  if (!outputs) return undefined

  const fields = entries.map(([key], index) => [key, outputs[index]])

  if (schema.type !== 'object_with_rest') return [JSON.stringify(['object', fields])]

  const rest = schema.rest && alternatives(schema.rest, seen, false)
  return rest ? [JSON.stringify(['object', fields, canonical(rest)])] : undefined
}

/** Proves array element, tuple position, and record key/value output types. */
function collectionOutput(
  schema: JsonSchema,
  seen: Set<AnySchema>,
): string[] | undefined {
  if (schema.type === 'array') {
    const item = schema.item && alternatives(schema.item, seen, false)
    return item ? [JSON.stringify(['array', canonical(item)])] : undefined
  }

  if (schema.type === 'record') {
    const outputs =
      schema.key && schema.value && members([schema.key, schema.value], seen)

    return outputs ? [JSON.stringify(['record', outputs])] : undefined
  }

  if (!['tuple', 'strict_tuple', 'tuple_with_rest'].includes(schema.type))
    return undefined

  const outputs = members(schema.items ?? [], seen)

  if (!outputs) return undefined
  if (schema.type !== 'tuple_with_rest') return [JSON.stringify(['tuple', outputs])]

  const rest = schema.rest && alternatives(schema.rest, seen, false)
  return rest ? [JSON.stringify(['tuple', outputs, canonical(rest)])] : undefined
}

/** Rejects opaque schemas and transformations without executing schema callbacks. */
function alternatives(
  input: AnySchema,
  ancestors: Set<AnySchema>,
  column: boolean,
): string[] | undefined {
  if (ancestors.has(input)) return undefined

  const seen = new Set(ancestors).add(input)
  const schema = input as JsonSchema

  if (schema.fallback !== undefined) return undefined

  if (schema.pipe) {
    if (
      schema.pipe
        .slice(1)
        .some((action) => action.kind !== 'validation' && action.kind !== 'metadata')
    )
      return undefined

    return alternatives(schema.pipe[0] as AnySchema, seen, column)
  }

  if (WRAPPERS.has(schema.type)) return wrappedOutput(schema, seen, column)

  if (['string', 'number', 'boolean'].includes(schema.type))
    return [JSON.stringify([schema.type])]

  if (schema.type === 'null') return [NULL]
  if (schema.type === 'literal') return literal(schema.literal)

  if (schema.type === 'picklist' || schema.type === 'enum') {
    const options = (input as AnySchema & { options: readonly unknown[] }).options.map(
      literal,
    )

    return options.every((option) => option !== undefined) ? options.flat() : undefined
  }

  if (schema.type === 'union' || schema.type === 'variant') {
    const options = schema.options?.map((option) => alternatives(option, seen, column))
    return options?.every((option) => option !== undefined) ? options.flat() : undefined
  }

  if (['object', 'strict_object', 'object_with_rest'].includes(schema.type))
    return objectOutput(schema, seen)

  return collectionOutput(schema, seen)
}

/** Canonical non-null JSON output evidence; native schemas remain private to extraction. */
export function jsonOutputFingerprint(schema: AnySchema): string | undefined {
  const outputs = alternatives(schema, new Set(), true)?.filter(
    (output) => output !== NULL && output !== UNDEFINED,
  )

  return outputs?.length ? canonical(outputs) : undefined
}
