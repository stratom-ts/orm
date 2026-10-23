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

const STRING_FORMATS = [
  'uuid',
  'ip',
  'ipv4',
  'ipv6',
  'mac',
  'mac48',
  'mac64',
  'decimal',
  'iso_date',
  'iso_time',
  'iso_time_second',
  'iso_date_time',
  'iso_date_time_second',
  'iso_timestamp',
] as const

type StringFormat = (typeof STRING_FORMATS)[number]

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
  /** Distinct format validators retained for the current string output. */
  stringFormats: readonly StringFormat[]
  /** Number constraints found beneath wrappers and in nested pipes. */
  numberConstraints: NumberConstraints
  /** A Valibot default found on a wrapper, if one is present. */
  schemaDefault: unknown
  /** Dialect-neutral output family, when the schema kind is known. */
  outputKind: SchemaOutputKind | undefined
  /** Schema that proves the effective output, when one remains available. */
  outputSchema?: AnySchema
  /** Bigint bounds kept separate from number bounds. */
  bigintConstraints: { minValue?: bigint; maxValue?: bigint }
  /** Whether the ordered pipeline still has an unresolved output. */
  unresolvedTransformation: boolean
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
  'stringConstraints' | 'numberConstraints' | 'bigintConstraints'
> & {
  stringConstraints: StringConstraints
  numberConstraints: NumberConstraints
  bigintConstraints: { minValue?: bigint; maxValue?: bigint }
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

type PipeAction = { kind?: string; type: string; requirement?: number | bigint }

function resetOutputFacts(result: RecursiveAnalysis): void {
  result.outputSchema = undefined
  result.stringConstraints = {}
  result.numberConstraints = {}
  result.bigintConstraints = {}
  result.stringFormat = undefined
  result.stringFormats = []
}

function applySchemaItem(result: RecursiveAnalysis, schema: AnySchema): void {
  const facts = analyzeNode(schema)
  Object.assign(result, {
    outputKind: facts.outputKind,
    outputSchema: facts.outputSchema,
    stringConstraints: { ...facts.stringConstraints },
    numberConstraints: { ...facts.numberConstraints },
    bigintConstraints: { ...facts.bigintConstraints },
    stringFormat: facts.stringFormat,
    stringFormats: [...facts.stringFormats],
    nullable: facts.nullable,
    allowsUndefined: facts.allowsUndefined,
    unresolvedTransformation: facts.unresolvedTransformation,
  })
}

function applyTransformation(result: RecursiveAnalysis, action: PipeAction): void {
  const conversions: Partial<Record<string, SchemaOutputKind>> = {
    to_number: 'number',
    to_boolean: 'boolean',
    parse_boolean: 'boolean',
    to_date: 'date',
    to_string: 'string',
  }

  result.outputKind = conversions[action.type]
  result.unresolvedTransformation = result.outputKind === undefined
  resetOutputFacts(result)
}

function applyLengthAction(result: RecursiveAnalysis, action: PipeAction): void {
  if (result.outputKind !== 'string' || typeof action.requirement !== 'number') return

  const length = action.requirement

  if (action.type !== 'max_length')
    result.stringConstraints.minLength = Math.max(
      result.stringConstraints.minLength ?? 0,
      length,
    )

  if (action.type !== 'min_length')
    result.stringConstraints.maxLength = Math.min(
      result.stringConstraints.maxLength ?? Infinity,
      length,
    )
}

function applyValueAction(result: RecursiveAnalysis, action: PipeAction): void {
  const requirement = action.requirement

  if (result.outputKind === 'number' && typeof requirement === 'number') {
    if (action.type === 'min_value')
      result.numberConstraints.minValue = Math.max(
        result.numberConstraints.minValue ?? -Infinity,
        requirement,
      )
    else
      result.numberConstraints.maxValue = Math.min(
        result.numberConstraints.maxValue ?? Infinity,
        requirement,
      )
  }

  if (result.outputKind === 'bigint' && typeof requirement === 'bigint') {
    const key = action.type === 'min_value' ? 'minValue' : 'maxValue'
    const previous = result.bigintConstraints[key]

    if (
      previous === undefined ||
      (action.type === 'min_value' ? requirement > previous : requirement < previous)
    )
      result.bigintConstraints[key] = requirement
  }
}

function applyValidationAction(result: RecursiveAnalysis, action: PipeAction): void {
  const format = STRING_FORMATS.find((format) => format === action.type)

  if (action.kind === 'validation' && result.outputKind === 'string' && format) {
    if (!result.stringFormats.includes(format))
      result.stringFormats = [...result.stringFormats, format]

    if (format === 'uuid') result.stringFormat = 'uuid'
  }

  if (
    action.type === 'min_length' ||
    action.type === 'max_length' ||
    action.type === 'length'
  ) {
    applyLengthAction(result, action)
    return
  }

  if (action.type === 'min_value' || action.type === 'max_value') {
    applyValueAction(result, action)
    return
  }

  if (action.type === 'integer' && result.outputKind === 'number')
    result.numberConstraints.isInteger = true

  if (action.type === 'safe_integer' && result.outputKind === 'number') {
    result.numberConstraints.isInteger = true
    result.numberConstraints.isSafeInteger = true
  }

  if (action.type === 'nullable' || action.type === 'nullish') result.nullable = true

  if (
    action.type === 'nullish' ||
    action.type === 'optional' ||
    action.type === 'exact_optional'
  )
    result.allowsUndefined = true
}

/** Adds facts from a pipe's schemas, transformations, and validations in order. */
function applyPipeActions(result: RecursiveAnalysis, actions: readonly unknown[]): void {
  for (const item of actions) {
    if (!item || typeof item !== 'object' || !('type' in item)) continue

    const action = item as PipeAction

    if (action.kind === 'schema') applySchemaItem(result, item as AnySchema)
    else if (action.kind === 'transformation') applyTransformation(result, action)
    else applyValidationAction(result, action)
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
        stringFormats: [],
        numberConstraints: {},
        bigintConstraints: {},
        unresolvedTransformation: false,
        schemaDefault: undefined,
        outputKind: outputKind(schema),
        outputSchema: schema,
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
    stringFormats: Object.freeze(result.stringFormats),
    numberConstraints: Object.freeze(result.numberConstraints),
    bigintConstraints: Object.freeze(result.bigintConstraints),
  })
}
