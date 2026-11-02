import type { StorageFacts, StorageOutputKind } from '@/storage/facts'
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
  fallback?: unknown
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

/** Adds enclosing numeric constraints while retaining branch-specific facts. */
function withNumberConstraints(
  analysis: StorageFacts,
  outer: NumberConstraints,
): StorageFacts {
  const numberConstraints = { ...analysis.numberConstraints }

  if (outer.minValue !== undefined)
    numberConstraints.minValue = Math.max(
      numberConstraints.minValue ?? -Infinity,
      outer.minValue,
    )

  if (outer.maxValue !== undefined)
    numberConstraints.maxValue = Math.min(
      numberConstraints.maxValue ?? Infinity,
      outer.maxValue,
    )

  if (outer.isInteger) numberConstraints.isInteger = true
  if (outer.isSafeInteger) numberConstraints.isSafeInteger = true

  return {
    ...analysis,
    numberConstraints,
  }
}

/** Adds enclosing bigint bounds while retaining tighter branch bounds. */
function withBigintConstraints(
  analysis: StorageFacts,
  outer: StorageFacts['bigintConstraints'],
): StorageFacts {
  const bigintConstraints = { ...analysis.bigintConstraints }

  if (
    outer.minValue !== undefined &&
    (bigintConstraints.minValue === undefined ||
      outer.minValue > bigintConstraints.minValue)
  )
    bigintConstraints.minValue = outer.minValue

  if (
    outer.maxValue !== undefined &&
    (bigintConstraints.maxValue === undefined ||
      outer.maxValue < bigintConstraints.maxValue)
  )
    bigintConstraints.maxValue = outer.maxValue

  return { ...analysis, bigintConstraints }
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

const OUTPUT_KINDS: Readonly<Partial<Record<string, StorageOutputKind>>> = {
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
function primitiveOutputKind(value: unknown): StorageOutputKind | undefined {
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
): StorageOutputKind | undefined {
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
function outputKind(schema: AnySchema): StorageOutputKind | undefined {
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

function isOutputUndefinedPossible(schema: AnySchema, nullOnly: boolean): boolean {
  if (nullOnly) return false

  if (schema.type === 'literal')
    return (schema as AnySchema & { literal?: unknown }).literal === undefined

  if (schema.type === 'enum' || schema.type === 'picklist')
    return (
      (schema as AnySchema & { options?: readonly unknown[] }).options?.includes(
        undefined,
      ) ?? false
    )

  return outputKind(schema) === undefined
}

type RecursiveAnalysis = Omit<
  StorageFacts,
  'stringConstraints' | 'numberConstraints' | 'bigintConstraints' | 'composite'
> & {
  composite?: {
    kind: 'alternatives' | 'intersection'
    branches: readonly RecursiveAnalysis[]
  }
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
function applyWrapperSemantics(
  result: RecursiveAnalysis,
  type: string,
  hasDefault: boolean,
): void {
  switch (type) {
    case 'optional':
    case 'exact_optional':
      result.omitOnInsert = true
      result.allowsUndefined = true
      result.outputMayBeUndefined = !hasDefault || result.outputMayBeUndefined
      break
    case 'undefinedable':
      result.omitOnInsert = false
      result.allowsUndefined = true
      result.outputMayBeUndefined = !hasDefault || result.outputMayBeUndefined
      break
    case 'nullable':
      result.nullable = true
      break
    case 'nullish':
      result.nullable = true
      result.omitOnInsert = true
      result.allowsUndefined = true
      result.outputMayBeUndefined = !hasDefault || result.outputMayBeUndefined
      break
    case 'non_optional':
      result.omitOnInsert = false
      result.allowsUndefined = false
      result.outputMayBeUndefined = false
      break
    case 'non_nullable':
      result.nullable = false
      result.omitOnInsert = false
      break
    case 'non_nullish':
      result.nullable = false
      result.omitOnInsert = false
      result.allowsUndefined = false
      result.outputMayBeUndefined = false
      break
  }
}

type PipeAction = { kind?: string; type: string; requirement?: number | bigint }

function resetOutputFacts(result: RecursiveAnalysis): void {
  result.finiteEvidence = undefined
  result.singletonValue = undefined
  result.finiteSourceValues = undefined
  result.jsonShape = undefined
  result.finiteValues = undefined
  result.composite = undefined
  result.jsonOutputCompatible = undefined
  result.outputMayBeUndefined = true
  result.nullOnly = false
  result.stringConstraints = {}
  result.numberConstraints = {}
  result.bigintConstraints = {}
  result.stringFormats = []
}

function clearFiniteEvidence(result: RecursiveAnalysis): void {
  result.finiteEvidence = undefined
  result.singletonValue = undefined
  result.finiteSourceValues = undefined
  result.finiteValues = undefined
  result.composite = undefined
  result.jsonShape = undefined
}

function applyNumberClamp(
  result: RecursiveAnalysis,
  action: PipeAction,
  requirement: number,
): void {
  const constraints = { ...result.numberConstraints }

  if (action.type === 'to_min_value') {
    constraints.minValue = Math.max(constraints.minValue ?? -Infinity, requirement)

    if (constraints.maxValue !== undefined)
      constraints.maxValue = Math.max(constraints.maxValue, requirement)
  } else {
    if (constraints.minValue !== undefined)
      constraints.minValue = Math.min(constraints.minValue, requirement)

    constraints.maxValue = Math.min(constraints.maxValue ?? Infinity, requirement)
  }

  if (!Number.isInteger(requirement)) {
    delete constraints.isInteger
    delete constraints.isSafeInteger
  } else if (!Number.isSafeInteger(requirement)) delete constraints.isSafeInteger

  clearFiniteEvidence(result)
  result.numberConstraints = constraints
  result.jsonOutputCompatible = true
}

function applyBigintClamp(
  result: RecursiveAnalysis,
  action: PipeAction,
  requirement: bigint,
): void {
  const constraints = { ...result.bigintConstraints }

  if (action.type === 'to_min_value') {
    if (constraints.minValue === undefined || requirement > constraints.minValue)
      constraints.minValue = requirement

    if (constraints.maxValue !== undefined && requirement > constraints.maxValue)
      constraints.maxValue = requirement
  } else {
    if (constraints.minValue !== undefined && requirement < constraints.minValue)
      constraints.minValue = requirement

    if (constraints.maxValue === undefined || requirement < constraints.maxValue)
      constraints.maxValue = requirement
  }

  clearFiniteEvidence(result)
  result.bigintConstraints = constraints
  result.jsonOutputCompatible = false
}

function changesValue(schema: AnySchema): boolean {
  const traversable = schema as TraversableSchema
  const pipe = traversable.pipe ?? []
  const composite = schema as AnySchema & { options?: readonly AnySchema[] }
  const shaped = schema as AnySchema & {
    entries?: Record<string, AnySchema>
    item?: AnySchema
    items?: readonly AnySchema[]
    key?: AnySchema
    rest?: AnySchema
    value?: AnySchema
  }

  const members = [
    ...Object.values(shaped.entries ?? {}),
    ...(shaped.items ?? []),
    shaped.item,
    shaped.rest,
    shaped.key,
    shaped.value,
  ]

  return (
    // These schemas construct a new shape and discard undeclared members.
    schema.type === 'object' ||
    schema.type === 'tuple' ||
    traversable.default !== undefined ||
    'fallback' in traversable ||
    members.some((member) => member && changesValue(member)) ||
    pipe.some(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'kind' in item &&
        (item.kind === 'transformation' ||
          (item.kind === 'schema' && changesValue(item as AnySchema))),
    ) ||
    (isSchema(traversable.wrapped) && changesValue(traversable.wrapped)) ||
    ((schema.type === 'union' ||
      schema.type === 'variant' ||
      schema.type === 'intersect') &&
      (composite.options?.some(changesValue) ?? false))
  )
}

function mergeSameKindFacts(result: RecursiveAnalysis, facts: RecursiveAnalysis): void {
  switch (result.outputKind) {
    case 'string': {
      const minLength = Math.max(
        result.stringConstraints.minLength ?? 0,
        facts.stringConstraints.minLength ?? 0,
      )

      const maxLength = Math.min(
        result.stringConstraints.maxLength ?? Infinity,
        facts.stringConstraints.maxLength ?? Infinity,
      )

      facts.stringConstraints = {
        ...facts.stringConstraints,
        ...(minLength > 0 ? { minLength } : {}),
        ...(maxLength < Infinity ? { maxLength } : {}),
      }
      facts.stringFormats = [
        ...new Set([...result.stringFormats, ...facts.stringFormats]),
      ]
      break
    }
    case 'number':
      facts.numberConstraints = withNumberConstraints(
        facts,
        result.numberConstraints,
      ).numberConstraints
      break
    case 'bigint':
      facts.bigintConstraints = withBigintConstraints(
        facts,
        result.bigintConstraints,
      ).bigintConstraints
      break
    case 'boolean':
    case 'date':
    case 'json':
    case undefined:
      break
  }
}

function hasValidFiniteOutput(analysis: RecursiveAnalysis): boolean {
  return (
    analysis.finiteValues === undefined ||
    analysis.outputKind === undefined ||
    (narrowFiniteValues(analysis.finiteValues, analysis)?.length ?? 0) > 0
  )
}

function narrowFiniteValues(
  values: readonly unknown[] | undefined,
  analysis: RecursiveAnalysis,
): readonly unknown[] | undefined {
  if (!values) return undefined

  const { minValue, maxValue, isInteger, isSafeInteger } = analysis.numberConstraints
  const bigint = analysis.bigintConstraints

  return values.filter((value) => {
    if (analysis.outputKind === 'number' && typeof value === 'number')
      return (
        (minValue === undefined || value >= minValue) &&
        (maxValue === undefined || value <= maxValue) &&
        (!isInteger || Number.isInteger(value)) &&
        (!isSafeInteger || Number.isSafeInteger(value))
      )

    if (analysis.outputKind === 'bigint' && typeof value === 'bigint')
      return (
        (bigint.minValue === undefined || value >= bigint.minValue) &&
        (bigint.maxValue === undefined || value <= bigint.maxValue)
      )

    return true
  })
}

function retainSameKindEvidence(
  previous: RecursiveAnalysis,
  facts: RecursiveAnalysis,
): RecursiveAnalysis | undefined {
  if (
    previous.nullOnly ||
    (previous.outputKind && previous.outputKind !== facts.outputKind)
  )
    return undefined

  const retained = { ...facts }
  mergeSameKindFacts(previous, retained)
  retained.finiteValues = narrowFiniteValues(
    previous.finiteValues && facts.finiteValues
      ? previous.finiteValues.filter((value) => facts.finiteValues!.includes(value))
      : (previous.finiteValues ?? facts.finiteValues),
    retained,
  )
  retained.outputMayBeUndefined = facts.outputMayBeUndefined

  if (previous.composite) {
    const branchFacts =
      facts.outputKind === 'bigint' ? { ...facts, bigintConstraints: {} } : facts

    const branches = previous.composite.branches
      .map((branch) => retainSameKindEvidence(branch, branchFacts))
      .filter((branch): branch is RecursiveAnalysis => branch !== undefined)

    retained.composite = {
      ...previous.composite,
      branches,
    }
    retained.finiteEvidence = previous.finiteEvidence
    retained.singletonValue = previous.singletonValue
    retained.finiteSourceValues = previous.finiteSourceValues
    retained.jsonShape = previous.jsonShape
  } else if (
    previous.finiteEvidence !== undefined &&
    facts.finiteEvidence === undefined
  ) {
    retained.finiteEvidence = previous.finiteEvidence
    retained.singletonValue = previous.singletonValue
    retained.finiteSourceValues = previous.finiteSourceValues
    retained.jsonShape = previous.jsonShape
    retained.composite = undefined
  }

  if (previous.jsonOutputCompatible === false) retained.jsonOutputCompatible = false

  return hasValidFiniteOutput(retained) ? retained : undefined
}

function applySchemaItem(result: RecursiveAnalysis, schema: AnySchema): void {
  const facts = analyzeNode(schema)
  let effectiveFacts: RecursiveAnalysis | undefined = facts

  if (
    !changesValue(schema) &&
    result.outputKind !== undefined &&
    result.outputKind === facts.outputKind
  )
    effectiveFacts = retainSameKindEvidence(result, facts)

  if (!effectiveFacts) {
    result.composite = { kind: 'alternatives', branches: [] }
    result.finiteEvidence = undefined
    result.singletonValue = undefined
    result.finiteSourceValues = undefined
    result.jsonShape = undefined
    result.jsonOutputCompatible = false
    result.outputMayBeUndefined = true
    result.numberConstraints = {}
    result.bigintConstraints = {}
    return
  }

  Object.assign(result, {
    outputKind: effectiveFacts.outputKind,
    finiteEvidence: effectiveFacts.finiteEvidence,
    singletonValue: effectiveFacts.singletonValue,
    finiteSourceValues: effectiveFacts.finiteSourceValues,
    jsonShape: effectiveFacts.jsonShape,
    outputState: effectiveFacts.outputState,
    jsonOutputCompatible: effectiveFacts.jsonOutputCompatible,
    outputMayBeUndefined: effectiveFacts.outputMayBeUndefined,
    finiteValues: effectiveFacts.finiteValues,
    composite: effectiveFacts.composite,
    nullOnly: effectiveFacts.nullOnly,
    stringConstraints: { ...effectiveFacts.stringConstraints },
    numberConstraints: { ...effectiveFacts.numberConstraints },
    bigintConstraints: { ...effectiveFacts.bigintConstraints },
    stringFormats: [...effectiveFacts.stringFormats],
    nullable: effectiveFacts.nullable,
    allowsUndefined: effectiveFacts.allowsUndefined,
  })

  pruneFiniteCompositeBranches(result)
}

function applyTransformation(result: RecursiveAnalysis, action: PipeAction): void {
  if (
    (action.type === 'to_min_value' || action.type === 'to_max_value') &&
    result.outputKind === 'number' &&
    typeof action.requirement === 'number'
  ) {
    if (Number.isNaN(action.requirement)) return

    applyNumberClamp(result, action, action.requirement)
    return
  }

  if (
    (action.type === 'to_min_value' || action.type === 'to_max_value') &&
    result.outputKind === 'bigint' &&
    typeof action.requirement === 'bigint'
  ) {
    applyBigintClamp(result, action, action.requirement)
    return
  }

  const conversions: Partial<Record<string, StorageOutputKind>> = {
    to_number: 'number',
    to_boolean: 'boolean',
    parse_boolean: 'boolean',
    to_date: 'date',
    to_string: 'string',
    trim: 'string',
    trim_start: 'string',
    trim_end: 'string',
    to_lower_case: 'string',
    to_upper_case: 'string',
    normalize: 'string',
    to_bigint: 'bigint',
  }

  const maxLength =
    (action.type === 'trim' ||
      action.type === 'trim_start' ||
      action.type === 'trim_end') &&
    result.outputKind === 'string'
      ? result.stringConstraints.maxLength
      : undefined

  result.outputKind = conversions[action.type]
  result.outputState = result.outputKind === undefined ? 'unresolved' : 'known'

  if (result.outputState !== 'unresolved') result.nullable = false

  resetOutputFacts(result)

  if (maxLength !== undefined) result.stringConstraints.maxLength = maxLength

  result.jsonOutputCompatible =
    result.outputKind === 'string' ||
    result.outputKind === 'number' ||
    result.outputKind === 'boolean'
  result.outputMayBeUndefined = result.outputState === 'unresolved'
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

function constrainCompositeBranches(result: RecursiveAnalysis): void {
  if (!result.composite || result.outputKind !== 'number') return

  const constraints = { ...result, composite: undefined, finiteEvidence: undefined }

  const branches = result.composite.branches
    .map((branch) => retainSameKindEvidence(branch, constraints))
    .filter((branch): branch is RecursiveAnalysis => branch !== undefined)

  result.composite = { ...result.composite, branches }
}

function pruneFiniteCompositeBranches(result: RecursiveAnalysis): void {
  if (!result.composite || result.outputKind !== 'bigint') return

  const prune = (branch: RecursiveAnalysis): RecursiveAnalysis | undefined => {
    if (branch.nullOnly || branch.outputKind !== result.outputKind) return undefined

    const finiteValues = narrowFiniteValues(branch.finiteValues, result)

    if (branch.finiteValues && !finiteValues?.length) return undefined

    if (!branch.composite) return { ...branch, finiteValues }

    const branches = branch.composite.branches
      .map(prune)
      .filter((member): member is RecursiveAnalysis => member !== undefined)

    if (!branches.length) return undefined

    return {
      ...branch,
      finiteValues,
      composite: { ...branch.composite, branches },
    }
  }

  const branches = result.composite.branches
    .map(prune)
    .filter((branch): branch is RecursiveAnalysis => branch !== undefined)

  result.composite = { ...result.composite, branches }
}

function applyValidationAction(result: RecursiveAnalysis, action: PipeAction): void {
  const narrowOutputValues = () => {
    result.finiteValues = narrowFiniteValues(result.finiteValues, result)
  }

  const format = STRING_FORMATS.find((format) => format === action.type)

  if (action.kind === 'validation' && result.outputKind === 'string' && format) {
    if (!result.stringFormats.includes(format))
      result.stringFormats = [...result.stringFormats, format]
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
    narrowOutputValues()
    constrainCompositeBranches(result)
    pruneFiniteCompositeBranches(result)
    return
  }

  if (action.type === 'integer' && result.outputKind === 'number')
    result.numberConstraints.isInteger = true

  if (action.type === 'safe_integer' && result.outputKind === 'number') {
    result.numberConstraints.isInteger = true
    result.numberConstraints.isSafeInteger = true
  }

  narrowOutputValues()
  constrainCompositeBranches(result)

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

function arrayShape(schema: AnySchema): boolean {
  return ['array', 'tuple', 'loose_tuple', 'strict_tuple', 'tuple_with_rest'].includes(
    schema.type,
  )
}

function leafEvidence(
  schema: AnySchema,
): Pick<
  StorageFacts,
  'finiteEvidence' | 'singletonValue' | 'finiteSourceValues' | 'jsonShape'
> {
  if (schema.type === 'literal')
    return {
      finiteEvidence: 'singleton',
      singletonValue: (schema as AnySchema & { literal?: unknown }).literal,
    }

  if (schema.type === 'enum' || schema.type === 'picklist')
    return {
      finiteEvidence: 'choice',
      finiteSourceValues: [
        ...((schema as AnySchema & { options?: readonly unknown[] }).options ?? []),
      ],
    }

  return {
    jsonShape:
      outputKind(schema) === 'json'
        ? arrayShape(schema)
          ? 'array'
          : 'object'
        : undefined,
  }
}

/** Builds the effective facts for a leaf or composite schema. */
function analyzeLeaf(schema: AnySchema): RecursiveAnalysis {
  const nullOnly =
    schema.type === 'null' ||
    (schema.type === 'literal' &&
      (schema as AnySchema & { literal?: unknown }).literal === null)

  const result: RecursiveAnalysis = {
    inputSingleton: schema.type === 'literal',
    nullable: nullOnly,
    allowsUndefined: false,
    outputMayBeUndefined: isOutputUndefinedPossible(schema, nullOnly),
    omitOnInsert: false,
    stringConstraints: {},
    stringFormats: [],
    numberConstraints: {},
    bigintConstraints: {},
    outputState:
      outputKind(schema) || nullOnly
        ? 'known'
        : schema.type === 'unknown' || schema.type === 'any'
          ? 'unconstrained'
          : 'unsupported',
    schemaDefault: { kind: 'absent' },
    outputKind: outputKind(schema),
    ...leafEvidence(schema),
    defaultJsonShape:
      outputKind(schema) === 'json'
        ? arrayShape(schema)
          ? 'array'
          : 'object'
        : undefined,
    finiteValues:
      schema.type === 'literal'
        ? [(schema as AnySchema & { literal?: unknown }).literal]
        : schema.type === 'enum' || schema.type === 'picklist'
          ? [...((schema as AnySchema & { options?: readonly unknown[] }).options ?? [])]
          : undefined,
    nullOnly,
  }

  if (schema.type === 'union' || schema.type === 'variant' || schema.type === 'intersect')
    applyCompositeFacts(schema, result)
  else result.jsonOutputCompatible = jsonOutputCompatibleForLeaf(schema, result)

  return result
}

function jsonOutputCompatibleForLeaf(
  schema: AnySchema,
  result: RecursiveAnalysis,
): boolean {
  return (
    result.nullOnly ||
    result.outputKind === 'string' ||
    (result.outputKind === 'number' && schema.type === 'number') ||
    result.outputKind === 'boolean' ||
    ((schema.type === 'enum' || schema.type === 'picklist') &&
      isJsonChoiceSchema(schema)) ||
    (schema.type === 'literal' &&
      isJsonPrimitiveValue((schema as AnySchema & { literal?: unknown }).literal)) ||
    (result.outputKind === 'json' && isJsonShapeSchema(schema, new Set([schema])))
  )
}

function applyCommonNumberConstraints(
  result: RecursiveAnalysis,
  type: 'union' | 'variant' | 'intersect',
  branches: readonly RecursiveAnalysis[],
): void {
  const constraints = branches.map((branch) => branch.numberConstraints)
  const allBounded = (key: 'minValue' | 'maxValue') =>
    constraints.every((item) => item[key] !== undefined)

  result.numberConstraints = {
    ...(constraints.every((item) => item.isInteger) ? { isInteger: true } : {}),
    ...(constraints.every((item) => item.isSafeInteger) ? { isSafeInteger: true } : {}),
    ...(allBounded('minValue')
      ? {
          minValue:
            type === 'intersect'
              ? Math.max(...constraints.map((item) => item.minValue!))
              : Math.min(...constraints.map((item) => item.minValue!)),
        }
      : {}),
    ...(allBounded('maxValue')
      ? {
          maxValue:
            type === 'intersect'
              ? Math.min(...constraints.map((item) => item.maxValue!))
              : Math.max(...constraints.map((item) => item.maxValue!)),
        }
      : {}),
  }
}

function applyCompositeFacts(schema: AnySchema, result: RecursiveAnalysis): void {
  const type = schema.type as 'union' | 'variant' | 'intersect'
  const options = (schema as AnySchema & { options?: readonly AnySchema[] }).options
  const branches = options?.map(analyzeNode) ?? []
  const nonNull = branches.filter((branch) => !branch.nullOnly)
  const commonKind = nonNull[0]?.outputKind
  result.composite = {
    kind: type === 'intersect' ? 'intersection' : 'alternatives',
    branches,
  }
  result.nullOnly = branches.length > 0 && branches.every((branch) => branch.nullOnly)
  const combine = type === 'intersect' ? 'every' : 'some'
  result.nullable = branches[combine]((branch) => branch.nullable)
  result.allowsUndefined = branches[combine]((branch) => branch.allowsUndefined)
  result.outputMayBeUndefined = branches[combine]((branch) => branch.outputMayBeUndefined)
  result.outputState = branches.some((branch) => branch.outputState === 'unresolved')
    ? 'unresolved'
    : 'unsupported'
  result.outputKind =
    commonKind && nonNull.every((branch) => branch.outputKind === commonKind)
      ? commonKind
      : undefined

  if (result.outputState !== 'unresolved' && (result.outputKind || result.nullOnly))
    result.outputState = 'known'

  if (result.outputKind === 'json') {
    const shapes = nonNull.map((branch) => branch.jsonShape)
    result.jsonShape = shapes.every((shape) => shape === shapes[0]) ? shapes[0] : 'mixed'
  }

  result.jsonOutputCompatible =
    branches.length > 0 &&
    branches.every(
      (branch) =>
        branch.nullOnly ||
        (!branch.outputMayBeUndefined && branch.jsonOutputCompatible === true),
    )

  if (result.outputKind === 'number' && nonNull.length)
    applyCommonNumberConstraints(result, type, nonNull)

  if (type !== 'intersect' && branches.every((branch) => branch.finiteValues))
    result.finiteValues = branches.flatMap((branch) => branch.finiteValues ?? [])

  applyCommonStringFormats(result, nonNull)
}

/** Proves that a JSON-shaped schema contains only values preserved by JSON. */
function isJsonSchemaOutputCompatible(
  schema: AnySchema,
  position: 'object' | 'array',
  seen: Set<AnySchema>,
): boolean {
  if (seen.has(schema)) return false

  seen.add(schema)

  const traversable = schema as TraversableSchema
  const analysis = analyzeNode(schema)

  if (analysis.jsonOutputCompatible !== true) return false
  if (!analysis.outputMayBeUndefined) return true

  const wrapped = wrappedSchema(traversable)

  if (!wrapped) return false

  const wrappedAnalysis = analyzeNode(wrapped)

  return (
    position === 'object' &&
    analysis.omitOnInsert &&
    wrappedAnalysis.jsonOutputCompatible === true
  )
}

function isJsonChoiceSchema(schema: AnySchema): boolean {
  const options = (schema as AnySchema & { options?: unknown[] }).options
  return !!options?.length && options.every(isJsonPrimitiveValue)
}

/** Record keys must become ordinary JSON object property names. */
function isJsonRecordShapeSchema(
  keySchema: AnySchema | undefined,
  valueSchema: AnySchema | undefined,
  seen: Set<AnySchema>,
): boolean {
  if (!keySchema || !valueSchema) return false

  const key = analyzeNode(keySchema)
  return (
    ['string', 'number', 'bigint', 'boolean'].includes(key.outputKind ?? '') &&
    !key.outputMayBeUndefined &&
    isJsonSchemaOutputCompatible(valueSchema, 'object', new Set(seen))
  )
}

function isJsonShapeSchema(schema: AnySchema, seen: Set<AnySchema>): boolean {
  const shaped = schema as AnySchema & {
    entries?: Record<string, AnySchema>
    item?: AnySchema
    items?: readonly AnySchema[]
    key?: AnySchema
    rest?: AnySchema
    value?: AnySchema
  }

  if (schema.type === 'object' || schema.type === 'strict_object')
    return Object.values(shaped.entries ?? {}).every((entry) =>
      isJsonSchemaOutputCompatible(entry, 'object', new Set(seen)),
    )

  if (schema.type === 'object_with_rest')
    return (
      Object.values(shaped.entries ?? {}).every((entry) =>
        isJsonSchemaOutputCompatible(entry, 'object', new Set(seen)),
      ) &&
      !!shaped.rest &&
      isJsonSchemaOutputCompatible(shaped.rest, 'object', new Set(seen))
    )

  if (schema.type === 'record')
    return isJsonRecordShapeSchema(shaped.key, shaped.value, seen)

  if (schema.type === 'array')
    return (
      !!shaped.item && isJsonSchemaOutputCompatible(shaped.item, 'array', new Set(seen))
    )

  if (schema.type === 'tuple' || schema.type === 'strict_tuple')
    return (shaped.items ?? []).every((item) =>
      isJsonSchemaOutputCompatible(item, 'array', new Set(seen)),
    )

  if (schema.type === 'tuple_with_rest')
    return (
      (shaped.items ?? []).every((item) =>
        isJsonSchemaOutputCompatible(item, 'array', new Set(seen)),
      ) &&
      !!shaped.rest &&
      isJsonSchemaOutputCompatible(shaped.rest, 'array', new Set(seen))
    )

  return false
}

function isJsonPrimitiveValue(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

function applyCommonStringFormats(
  result: RecursiveAnalysis,
  nonNull: readonly RecursiveAnalysis[],
): void {
  if (result.outputKind !== 'string') return

  const formats = nonNull[0].stringFormats
  const common = nonNull.every(
    (branch) =>
      branch.stringFormats.length === formats.length &&
      branch.stringFormats.every((format) => formats.includes(format)),
  )

  if (!common) return

  result.stringFormats = [...formats]
}

/** Collects storage and validation facts without losing wrapper semantics. */
function analyzeNode(schema: AnySchema): RecursiveAnalysis {
  const traversable = schema as TraversableSchema
  const wrapped = wrappedSchema(traversable)
  const first = traversable.pipe?.[0]
  const piped = isSchema(first)

  if (wrapped && !piped) {
    const result = { ...analyzeNode(wrapped) }
    applyWrapperSemantics(result, schema.type, traversable.default !== undefined)

    if (traversable.default !== undefined)
      result.schemaDefault =
        typeof traversable.default === 'function'
          ? { kind: 'factory' }
          : { kind: 'value', value: traversable.default }

    return result
  }

  const inner = piped ? analyzeNode(first) : undefined
  const result = inner ? { ...inner } : analyzeLeaf(schema)

  if (Array.isArray(traversable.pipe)) applyPipeActions(result, traversable.pipe.slice(1))

  return result
}

/**
 * Extracts logical storage evidence without executing user code. Native schema
 * references remain local to traversal; dialects choose physical SQL types.
 */
export function extractStorageFacts(schema: AnySchema): StorageFacts {
  const result = analyzeNode(schema)
  return Object.freeze({
    ...result,
    defaultJsonShape:
      result.outputKind === 'json' ? (result.defaultJsonShape ?? 'object') : undefined,
    finiteValues: result.finiteValues && Object.freeze(result.finiteValues),
    stringConstraints: Object.freeze(result.stringConstraints),
    stringFormats: Object.freeze(result.stringFormats),
    numberConstraints: Object.freeze(result.numberConstraints),
    bigintConstraints: Object.freeze(result.bigintConstraints),
  })
}
