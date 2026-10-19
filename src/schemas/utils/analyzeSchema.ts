import type { NumberConstraints, StringConstraints } from '@/types/constraints'
import type { AnySchema } from '@/types/schema'

/** The Valibot wrappers whose runtime semantics affect a column. */
const WRAPPER_TYPES = new Set([
  'optional',
  'exact_optional',
  'undefinedable',
  'nullable',
  'nullish',
  'non_optional',
  'non_nullable',
  'non_nullish',
])

type TraversableSchema = AnySchema & {
  wrapped?: AnySchema
  pipe?: readonly unknown[]
  default?: unknown
}

/** Broad value families understood by dialect-neutral schema analysis. */
export type SchemaOutputKind =
  | 'string'
  | 'number'
  | 'bigint'
  | 'boolean'
  | 'date'
  | 'json'

/** Dialect-neutral facts resolved from a column schema. */
export interface SchemaAnalysis {
  /** The innermost schema used to select a dialect-neutral input type. */
  baseSchema: AnySchema
  /** The innermost pipe/schema, retaining its actions and metadata. */
  unwrappedSchema: AnySchema
  /** Whether the resulting column may contain SQL NULL. */
  nullable: boolean
  /** Whether parsing the schema accepts an explicit or omitted undefined. */
  allowsUndefined: boolean
  /** Whether the application may omit the column on insert. */
  omitOnInsert: boolean
  /** String length constraints found beneath wrappers and in nested pipes. */
  stringConstraints: StringConstraints
  /** String format validation found beneath wrappers and in nested pipes. */
  stringFormat?: 'uuid'
  /** Number constraints found beneath wrappers and in nested pipes. */
  numberConstraints: NumberConstraints
  /** A Valibot default found on a wrapper, if one is present. */
  schemaDefault: unknown
  /** Dialect-neutral output family, when the schema kind is known. */
  outputKind: SchemaOutputKind | undefined
}

/** Checks whether a runtime value exposes the Valibot schema contract. */
function isSchema(value: unknown): value is AnySchema {
  return typeof value === 'object' && value !== null && 'kind' in value
}

/** Reads an optional or nullable wrapper's inner schema. */
function wrappedSchema(schema: TraversableSchema): AnySchema | undefined {
  return WRAPPER_TYPES.has(schema.type) && isSchema(schema.wrapped)
    ? schema.wrapped
    : undefined
}

const OUTPUT_KINDS: Readonly<Partial<Record<string, SchemaOutputKind>>> = {
  string: 'string',
  number: 'number',
  bigint: 'bigint',
  boolean: 'boolean',
  date: 'date',
  object: 'json',
  loose_object: 'json',
  strict_object: 'json',
  object_with_rest: 'json',
  record: 'json',
  array: 'json',
  tuple: 'json',
  loose_tuple: 'json',
  strict_tuple: 'json',
  tuple_with_rest: 'json',
}

/**
 * Classifies a literal output as a supported SQL primitive.
 *
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns The primitive output kind, or undefined when the value has no supported kind.
 */
function primitiveOutputKind(value: unknown): SchemaOutputKind | undefined {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'bigint') return 'bigint'
  if (typeof value === 'boolean') return 'boolean'

  return undefined
}

/**
 * Finds the shared primitive kind of a union's alternatives.
 *
 * @param options - Configuration and dependencies for this operation.
 *
 * @returns The shared output kind, or undefined when branches disagree or are
 *   unsupported.
 */
function homogeneousOutputKind(
  options: unknown[] | undefined,
): SchemaOutputKind | undefined {
  if (!options || options.length === 0) return undefined

  const kind = primitiveOutputKind(options[0])

  if (!kind || !options.every((value) => primitiveOutputKind(value) === kind))
    return undefined

  return kind
}

/**
 * Resolves the primitive output kind through schema wrappers and unions.
 *
 * @param schema - Valibot schema used to read validation, storage, and metadata facts.
 *
 * @returns The schema's supported output kind, or undefined when it cannot be determined.
 */
function outputKind(schema: AnySchema): SchemaOutputKind | undefined {
  const direct = OUTPUT_KINDS[schema.type]

  if (direct) return direct

  if (schema.type === 'literal') {
    return primitiveOutputKind((schema as AnySchema & { literal?: unknown }).literal)
  }

  if (schema.type === 'enum' || schema.type === 'picklist') {
    return homogeneousOutputKind((schema as AnySchema & { options?: unknown[] }).options)
  }

  return undefined
}

type RecursiveAnalysis = Omit<
  SchemaAnalysis,
  'stringConstraints' | 'numberConstraints'
> & {
  stringConstraints: StringConstraints
  numberConstraints: NumberConstraints
}

/**
 * Updates nullability, omission, and default facts for one schema wrapper.
 *
 * @param result - Captured execution result or validated input whose outcome is being
 *   interpreted.
 * @param type - Physical type spelling used to build storage evidence.
 */
function applyWrapperSemantics(result: RecursiveAnalysis, type: string): void {
  switch (type) {
    case 'optional':
    case 'exact_optional':
      result.omitOnInsert = true
      result.allowsUndefined = true
      break
    case 'undefinedable':
      result.omitOnInsert = false
      result.allowsUndefined = true
      break
    case 'nullable':
      result.nullable = true
      break
    case 'nullish':
      result.nullable = true
      result.omitOnInsert = true
      result.allowsUndefined = true
      break
    case 'non_optional':
      result.omitOnInsert = false
      result.allowsUndefined = false
      break
    case 'non_nullable':
      result.nullable = false
      result.omitOnInsert = false
      break
    case 'non_nullish':
      result.nullable = false
      result.omitOnInsert = false
      result.allowsUndefined = false
      break
  }
}

/**
 * Adds numeric, string, and metadata facts from a schema's pipe actions.
 *
 * @param result - Captured execution result or validated input whose outcome is being
 *   interpreted.
 * @param actions - Physical migration actions in their execution order.
 */
function applyPipeActions(result: RecursiveAnalysis, actions: readonly unknown[]): void {
  for (const item of actions) {
    if (!item || typeof item !== 'object' || !('type' in item)) continue

    const action = item as { kind?: string; type: string; requirement?: number }

    if (action.kind === 'validation' && action.type === 'uuid') {
      result.stringFormat = 'uuid'
    }

    switch (action.type) {
      case 'min_length':
        result.stringConstraints.minLength = action.requirement
        break
      case 'max_length':
        result.stringConstraints.maxLength = action.requirement
        break
      case 'length':
        result.stringConstraints.minLength = action.requirement
        result.stringConstraints.maxLength = action.requirement
        break
      case 'min_value':
        result.numberConstraints.minValue = action.requirement
        break
      case 'max_value':
        result.numberConstraints.maxValue = action.requirement
        break
      case 'integer':
      case 'safe_integer':
        result.numberConstraints.isInteger = true
        break
      case 'nullable':
        result.nullable = true
        break
      case 'nullish':
        result.nullable = true
        result.allowsUndefined = true
        break
      case 'optional':
      case 'exact_optional':
        result.allowsUndefined = true
        break
    }
  }
}

/**
 * Collects storage and validation facts without losing wrapper semantics.
 *
 * @param schema - Valibot schema used to read validation, storage, and metadata facts.
 *
 * @returns Storage and insert-omission facts derived from this schema node.
 */
function analyzeNode(schema: AnySchema): RecursiveAnalysis {
  const traversable = schema as TraversableSchema
  const wrapped = wrappedSchema(traversable)
  const first = traversable.pipe?.[0]
  const piped = isSchema(first)

  if (wrapped && !piped) {
    const inner = analyzeNode(wrapped)
    const result: RecursiveAnalysis = { ...inner }

    applyWrapperSemantics(result, schema.type)

    if (traversable.default !== undefined) result.schemaDefault = traversable.default

    return result
  }

  const inner = piped ? analyzeNode(first) : undefined
  const result: RecursiveAnalysis = inner
    ? { ...inner, unwrappedSchema: wrapped ? inner.unwrappedSchema : schema }
    : {
        baseSchema: schema,
        unwrappedSchema: schema,
        nullable: false,
        allowsUndefined: false,
        omitOnInsert: false,
        stringConstraints: {},
        numberConstraints: {},
        schemaDefault: undefined,
        outputKind: outputKind(schema),
      }

  if (Array.isArray(traversable.pipe)) {
    applyPipeActions(result, traversable.pipe.slice(1))
  }

  return result
}

/**
 * Recursively resolves wrapper semantics and type-related facts for a schema.
 *
 * This is the shared runtime seam for SQL nullability, insert omission, base
 * schema selection, and constraints. Dialects still own mapping those facts to
 * physical SQL types.
 */
export function analyzeSchema(schema: AnySchema): SchemaAnalysis {
  const result = analyzeNode(schema)
  return Object.freeze({
    ...result,
    stringConstraints: Object.freeze(result.stringConstraints),
    numberConstraints: Object.freeze(result.numberConstraints),
  })
}
