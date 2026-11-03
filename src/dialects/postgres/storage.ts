import type { StorageFacts, StorageStringFormat } from '@/storage/facts'
import type { NumberConstraints, StringConstraints } from '@/types/constraints'
import { isNumber } from '@/utils'
import { SchemaError } from '@/utils/error'

import type {
  AuthoredDesiredColumn,
  DialectSchema,
  DialectValueMappingContext,
  SqlDataType,
} from '../types'

import { extractPostgresBaseType } from './normalize'
import { assertSafePostgresDataType } from './validate'

const INTEGER_STORAGE: readonly string[] = ['smallint', 'integer', 'bigint']

const INT16_MIN = -32768
const INT16_MAX = 32767
const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

const STRING_FORMAT_STORAGE = {
  uuid: 'uuid',
  ip: 'inet',
  ipv4: 'inet',
  ipv6: 'inet',
  mac48: 'macaddr',
  mac: 'macaddr8',
  mac64: 'macaddr8',
  decimal: 'numeric',
  iso_date: 'date',
  iso_time: 'time',
  iso_time_second: 'time',
  iso_date_time: 'timestamp',
  iso_date_time_second: 'timestamp',
  iso_timestamp: 'timestamptz',
} as const satisfies Record<StorageStringFormat, SqlDataType>

/** Selects native storage only when all retained formats agree on one target. */
function inferPostgresFormatType(facts: StorageFacts): SqlDataType | undefined {
  const targets = [
    ...new Set(facts.stringFormats.map((format) => STRING_FORMAT_STORAGE[format])),
  ].sort()

  if (targets.length > 1)
    throw new SchemaError({
      message: `conflicting PostgreSQL string formats select ${targets.join(', ')}. Use one format or column({ physicalType: { postgresql: ... } })`,
    })

  return targets[0]
}

/**
 * Maps string length constraints to a PostgreSQL string type.
 *
 * @param constraints - Min/max length from the schema pipe.
 *
 * @returns `varchar(n)` for maxLength <= 255, `text` otherwise
 */
function inferPostgresStringType(constraints: StringConstraints): SqlDataType {
  if (constraints.maxLength === undefined) return 'text'
  if (constraints.maxLength <= 255) return `varchar(${constraints.maxLength})`

  return 'text'
}

/**
 * Maps number constraints to a PostgreSQL numeric type.
 *
 * @param constraints - Min/max value and integer flags.
 *
 * @returns `smallint`, `integer`, `bigint`, or `double precision`
 */
function inferPostgresNumberType(constraints: NumberConstraints): SqlDataType {
  if (!constraints.isInteger) return 'double precision'

  const { minValue: min, maxValue: max } = constraints

  if ((isNumber(min) && min < INT32_MIN) || (isNumber(max) && max > INT32_MAX)) {
    return 'bigint'
  }

  if (isNumber(min) && min >= INT16_MIN && isNumber(max) && max <= INT16_MAX) {
    return 'smallint'
  }

  return 'integer'
}

/**
 * Maps a Valibot literal value to a PostgreSQL column type.
 *
 * @param literal - Literal value from the schema.
 *
 * @returns Inferred column type for the literal
 */
function inferPostgresLiteralType(literal: unknown) {
  if (typeof literal === 'string') return 'text'

  if (typeof literal === 'number') {
    if (
      !Number.isFinite(literal) ||
      (Number.isInteger(literal) && !Number.isSafeInteger(literal))
    )
      throw new SchemaError({
        message: 'cannot infer PostgreSQL storage for an unsafe number literal',
      })

    if (!Number.isInteger(literal)) return 'double precision'

    return literal < INT32_MIN || literal > INT32_MAX ? 'bigint' : 'integer'
  }

  if (typeof literal === 'boolean') return 'boolean'

  if (typeof literal === 'bigint')
    return literal < INT64_MIN || literal > INT64_MAX ? 'numeric' : 'bigint'

  return 'text'
}

/** Rejects choices whose output cannot select safe PostgreSQL storage. */
function unsupportedChoiceType(type: string): never {
  throw new SchemaError({
    message: `cannot infer a PostgreSQL column type for a mixed or unsupported ${type} output; specify column({ physicalType: { postgresql: ... } })`,
  })
}

/** Infers storage from the effective enum or picklist output options. */
function inferPostgresChoiceType(facts: StorageFacts): SqlDataType {
  const options = facts.finiteValues
  const kind = facts.outputKind

  if (!options?.length || !kind) return unsupportedChoiceType('choice')

  if (kind === 'string') return 'text'
  if (kind === 'boolean') return 'boolean'

  if (kind === 'number') {
    const numbers = options as number[]

    if (!numbers.length) return unsupportedChoiceType('choice')

    if (
      numbers.some(
        (value) =>
          !Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)),
      )
    )
      return unsupportedChoiceType('choice')

    let min = Infinity
    let max = -Infinity
    let fractional = false

    for (const value of numbers) {
      fractional ||= !Number.isInteger(value)
      min = Math.min(min, value)
      max = Math.max(max, value)
    }

    return inferPostgresNumberType({
      isInteger: !fractional,
      minValue: min,
      maxValue: max,
    })
  }

  if (kind === 'bigint') {
    const values = options as bigint[]

    if (!values.length) return unsupportedChoiceType('choice')

    return values.some((option) => option < INT64_MIN || option > INT64_MAX)
      ? 'numeric'
      : 'bigint'
  }

  return unsupportedChoiceType('choice')
}

/** Selects PostgreSQL storage from provider-neutral evidence. */
function inferPostgresColumnTypeFromFacts(facts: StorageFacts): SqlDataType {
  const inferred = inferEffectivePostgresType(facts)

  if (inferred) return inferred

  const detail =
    facts.outputState === 'unresolved'
      ? 'an unresolved transformation'
      : 'the schema output'

  throw new SchemaError({
    message: `cannot infer a SQL column type for ${detail}; specify it explicitly with column({ physicalType: { postgresql: ... } })`,
  })
}

function inferEffectivePostgresType(facts: StorageFacts): SqlDataType | undefined {
  if (facts.composite) return inferPostgresCompositeType(facts)

  if (facts.finiteEvidence === 'singleton')
    return inferPostgresLiteralType(facts.singletonValue)

  if (facts.finiteEvidence === 'choice') return inferPostgresChoiceType(facts)

  switch (facts.outputKind) {
    case 'string':
      return (
        inferPostgresFormatType(facts) ?? inferPostgresStringType(facts.stringConstraints)
      )
    case 'number': {
      return inferPostgresNumberOutputType(facts.numberConstraints)
    }
    case 'bigint': {
      const { minValue, maxValue } = facts.bigintConstraints
      return minValue !== undefined &&
        maxValue !== undefined &&
        minValue >= INT64_MIN &&
        maxValue <= INT64_MAX
        ? 'bigint'
        : 'numeric'
    }
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'timestamptz'
    case 'json':
      return 'jsonb'
    case undefined:
      return undefined
  }
}

/** Widens compatible branch storage without changing the output family. */
function inferPostgresCompositeType(facts: StorageFacts): SqlDataType {
  const composite = facts.composite!
  const branches = composite.branches.filter((branch) => !branch.nullOnly)
  const kind = facts.outputKind

  if (kind === 'json' && facts.jsonOutputCompatible !== true)
    throw new SchemaError({
      message:
        'PostgreSQL JSON composite output is not preserved by JSON serialization; provide column({ physicalType: { postgresql: ... } }) and paired parameter and result mappings',
    })

  if (
    !branches.length ||
    !kind ||
    (composite.kind === 'intersection' && branches.length !== composite.branches.length)
  )
    return unsupportedCompositeType(composite.kind)

  const constrainedBranches =
    kind === 'number'
      ? branches.map((branch) => withNumberFacts(branch, facts.numberConstraints))
      : kind === 'bigint'
        ? branches.map((branch) => withBigintFacts(branch, facts.bigintConstraints))
        : branches

  const types = constrainedBranches.map((branch) => inferEffectivePostgresType(branch))

  if (types.some((type) => !type)) return unsupportedCompositeType(composite.kind)

  const storage = types as SqlDataType[]
  const inferred =
    kind === 'string'
      ? inferPostgresCompositeStringType(facts, branches, storage)
      : kind === 'number'
        ? inferPostgresCompositeNumberType(constrainedBranches, storage)
        : kind === 'bigint' &&
            storage.every((type) => type === 'bigint' || type === 'numeric')
          ? storage.includes('numeric')
            ? 'numeric'
            : 'bigint'
          : storage.every((type) => type === storage[0])
            ? storage[0]
            : undefined

  return inferred ?? unsupportedCompositeType(composite.kind)
}

function isPostgresTextStorage(type: SqlDataType): boolean {
  return type === 'text' || /^varchar\(\d+\)$/.test(type)
}

/** Keeps one result format for every string branch before widening its width. */
function inferPostgresCompositeStringType(
  facts: StorageFacts,
  branches: readonly StorageFacts[],
  types: readonly SqlDataType[],
): SqlDataType | undefined {
  const outerFormat = inferPostgresFormatType(facts)
  const allText = types.every(isPostgresTextStorage)

  if (outerFormat && allText) return outerFormat

  if (types.every((type) => type === types[0])) {
    const type = types[0]
    const formats = [...branches[0].stringFormats].sort().join(',')

    if (
      (type === 'time' || type === 'timestamp') &&
      branches.some((branch) => [...branch.stringFormats].sort().join(',') !== formats)
    )
      return undefined

    if (outerFormat && outerFormat !== type) return undefined

    if (allText && facts.stringConstraints.maxLength !== undefined)
      return inferPostgresStringType(facts.stringConstraints)

    return type
  }

  if (!allText) return undefined

  if (facts.stringConstraints.maxLength !== undefined)
    return inferPostgresStringType(facts.stringConstraints)

  if (types.includes('text')) return 'text'

  return `varchar(${Math.max(...types.map((type) => Number(type.match(/\d+/)![0])))})`
}

function isSafePostgresNumberBranch(branch: StorageFacts): boolean {
  const { minValue, maxValue, isSafeInteger } = branch.numberConstraints

  if (isSafeInteger) return true

  if (
    minValue !== undefined &&
    maxValue !== undefined &&
    minValue >= Number.MIN_SAFE_INTEGER &&
    maxValue <= Number.MAX_SAFE_INTEGER
  )
    return true

  if (branch.composite) {
    const members = branch.composite.branches.filter((member) => !member.nullOnly)
    return members.length > 0 && members.every(isSafePostgresNumberBranch)
  }

  if (branch.finiteEvidence === 'singleton')
    return (
      typeof branch.singletonValue === 'number' &&
      Number.isSafeInteger(branch.singletonValue)
    )

  return (
    branch.finiteEvidence === 'choice' &&
    !!branch.finiteSourceValues?.length &&
    branch.finiteSourceValues.every(
      (value) => typeof value === 'number' && Number.isSafeInteger(value),
    )
  )
}

/** Promotes integer widths, and uses doubles only for safe integer branches. */
function inferPostgresCompositeNumberType(
  branches: readonly StorageFacts[],
  types: readonly SqlDataType[],
): SqlDataType | undefined {
  const integers = INTEGER_STORAGE

  if (types.every((type) => integers.includes(type)))
    return integers[Math.max(...types.map((type) => integers.indexOf(type)))]

  if (
    types.every((type) => integers.includes(type) || type === 'double precision') &&
    branches.every(
      (branch, index) => types[index] !== 'bigint' || isSafePostgresNumberBranch(branch),
    )
  )
    return 'double precision'

  return undefined
}

function unsupportedCompositeType(type: string): never {
  throw new SchemaError({
    message: `cannot infer a SQL column type for incompatible PostgreSQL ${type} branches; provide explicit physical type and parameter and result mappings`,
  })
}

function inferPostgresNumberOutputType(constraints: NumberConstraints): SqlDataType {
  if (
    constraints.isSafeInteger &&
    (constraints.minValue === undefined || constraints.maxValue === undefined)
  )
    return 'bigint'

  return inferPostgresNumberType(constraints)
}

function withNumberFacts(facts: StorageFacts, outer: NumberConstraints): StorageFacts {
  const numberConstraints = { ...facts.numberConstraints }

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

  return { ...facts, numberConstraints }
}

function withBigintFacts(
  facts: StorageFacts,
  outer: StorageFacts['bigintConstraints'],
): StorageFacts {
  const bigintConstraints = { ...facts.bigintConstraints }

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

  return { ...facts, bigintConstraints }
}

const BIGINT_OUTPUT_STORAGE = new Set([
  'numeric',
  'decimal',
  'bigint',
  'integer',
  'smallint',
])

const NUMBER_OUTPUT_STORAGE = new Set([
  'smallint',
  'integer',
  'bigint',
  'real',
  'double precision',
])

const DATE_OUTPUT_STORAGE = new Set(['date', 'timestamp', 'timestamptz'])
const TEMPORAL_STORAGE = new Set(['date', 'time', 'timestamp', 'timestamptz'])

const JSON_OUTPUT_STORAGE = new Set(['json', 'jsonb'])

/** Storage that the pg driver's default text parsers return as non-strings. */
const NON_STRING_STORAGE = new Set([
  ...NUMBER_OUTPUT_STORAGE,
  ...JSON_OUTPUT_STORAGE,
  'oid',
  'boolean',
  'bytea',
  'interval',
  'point',
  'circle',
])

/** Serial pseudo-types store their underlying integer type. */
const SERIAL_STORAGE: Readonly<Record<string, string>> = {
  smallserial: 'smallint',
  serial: 'integer',
  bigserial: 'bigint',
}

/** Resolves serial storage for value mapping without changing authored SQL types. */
function mappingStorage(dataType: string): string {
  const base = extractPostgresBaseType(dataType)
  return SERIAL_STORAGE[base] ?? base
}

/** Checks whether PostgreSQL storage returns values of one analyzed scalar output kind. */
function canStoreOutputKind(base: string, kind: StorageFacts['outputKind']): boolean {
  switch (kind) {
    case 'string':
      return !NON_STRING_STORAGE.has(base) && !base.endsWith('[]')
    case 'number':
      return NUMBER_OUTPUT_STORAGE.has(base)
    case 'bigint':
      return BIGINT_OUTPUT_STORAGE.has(base)
    case 'boolean':
      return base === 'boolean'
    case 'date':
      return DATE_OUTPUT_STORAGE.has(base)
    case 'json':
      return JSON_OUTPUT_STORAGE.has(base)
    case undefined:
      return false
  }
}

/**
 * Rejects scalar storage whose driver values cannot carry the analyzed output kind.
 *
 * Composite outputs are checked separately by their branch-aware validation. `unknown()`
 * and `any()` outputs are accepted because their inferred type admits any driver value.
 *
 * @param dataType - Selected PostgreSQL column type.
 * @param facts - Analysis of the column's logical schema.
 *
 * @throws SchemaError when built-in mapping cannot return the output kind
 */
function assertPostgresScalarStorage(dataType: string, facts: StorageFacts): void {
  if (facts.composite) return

  const kind = facts.outputKind

  if (facts.outputState === 'unconstrained') return

  const base = mappingStorage(dataType)

  assertTemporalFormatStorage(base, facts)

  if (canStoreOutputKind(base, kind)) return

  throw new SchemaError({
    message: `PostgreSQL ${kind ?? 'unknown'} schema with ${JSON.stringify(dataType)} requires explicit parameter and result mappings. Provide paired column mapParam/mapResult or client mapParamValue/mapResultValue hooks.`,
  })
}

/** Rejects proven ISO formats stored in a different native temporal type. */
function assertTemporalFormatStorage(base: string, facts: StorageFacts): void {
  if (facts.outputKind !== 'string') return
  if (!TEMPORAL_STORAGE.has(base)) return

  const formats = facts.stringFormats.filter((format) =>
    TEMPORAL_STORAGE.has(STRING_FORMAT_STORAGE[format]),
  )

  if (formats.length && !matchesTemporalFormatStorage(base, formats)) {
    throw new SchemaError({
      message: `PostgreSQL ISO output formats ${formats.join(', ')} cannot use ${JSON.stringify(base)} storage without changing their value shape or offset. Provide paired column mapParam/mapResult or client mapParamValue/mapResultValue hooks.`,
    })
  }
}

/** Checks whether one proven ISO format matches its native PostgreSQL storage. */
function matchesTemporalFormatStorage(
  base: string,
  formats: StorageFacts['stringFormats'],
): boolean {
  return formats.length === 1 && STRING_FORMAT_STORAGE[formats[0]] === base
}

/** Selects authored reference formats only when native storage can preserve them. */
function referenceTemporalAnalysis(
  base: string,
  authored: StorageFacts | undefined,
): StorageFacts | undefined {
  if (!authored) return undefined

  const formats = authored.stringFormats.filter((format) =>
    TEMPORAL_STORAGE.has(STRING_FORMAT_STORAGE[format]),
  )

  if (!formats.length) return undefined
  if (base === 'text' || base === 'varchar') return authored

  if (!matchesTemporalFormatStorage(base, formats)) {
    throw new SchemaError({
      message: `PostgreSQL reference output formats ${formats.join(', ')} cannot use ${JSON.stringify(base)} storage unambiguously. Provide paired column mapParam/mapResult or client mapParamValue/mapResultValue hooks.`,
    })
  }

  return authored
}

/**
 * Selects and validates a column's PostgreSQL physical type.
 *
 * @param column - Authored desired column.
 * @param context - Effective client mapping availability; hooks are never executed.
 */
function selectPostgresColumnStorage(
  column: AuthoredDesiredColumn,
  context?: Parameters<DialectSchema['lowerDesiredSchema']>[1],
): string {
  const facts = column.facts
  const metadata = column.metadata
  const explicit = metadata?.physicalType?.postgresql
  const hasParameterMapping =
    context?.hasGlobalParameterMapping || typeof metadata?.mapParam === 'function'

  const hasResultMapping =
    context?.hasGlobalResultMapping || typeof metadata?.mapResult === 'function'

  const selected = assertSafePostgresDataType(
    explicit ?? inferPostgresColumnTypeFromFacts(facts),
  )

  if (explicit !== undefined && (!hasParameterMapping || !hasResultMapping))
    assertPostgresScalarStorage(selected, facts)

  return selected
}

/** Validates selected storage against resolved and locally authored logical output. */
function validatePostgresValueMappingFromFacts(
  dataType: string,
  target: StorageFacts,
  authored?: StorageFacts,
): void {
  validatePostgresCompositeMapping(dataType, target)

  if (authored) {
    validatePostgresCompositeMapping(dataType, authored)

    if (authored.outputKind !== target.outputKind) {
      throw new SchemaError({
        message:
          'PostgreSQL reference transformations must preserve the resolved target output kind. Provide paired column mapParam/mapResult or client mapParamValue/mapResultValue hooks.',
      })
    }

    referenceTemporalAnalysis(extractPostgresBaseType(dataType), authored)
  }

  assertPostgresScalarStorage(dataType, target)
}

function validatePostgresCompositeMapping(dataType: string, facts: StorageFacts): void {
  if (!facts.composite) return

  const base = mappingStorage(dataType)

  if (facts.outputKind === 'string' && (base === 'text' || base === 'varchar')) return

  const inferred = extractPostgresBaseType(inferPostgresColumnTypeFromFacts(facts))
  const kind = facts.outputKind
  const compatible =
    kind === 'number'
      ? isPostgresCompositeNumberStorage(inferred, base)
      : kind === 'bigint'
        ? base === 'numeric' ||
          base === 'decimal' ||
          (inferred === 'bigint' && base === 'bigint')
        : kind === 'json'
          ? base === 'json' || base === 'jsonb'
          : base === inferred

  if (!compatible)
    throw new SchemaError({
      message: `PostgreSQL ${kind ?? 'unknown'} composite with ${JSON.stringify(dataType)} requires explicit parameter and result mappings`,
    })
}

function isPostgresCompositeNumberStorage(inferred: string, selected: string): boolean {
  const widths = INTEGER_STORAGE
  const minimum = widths.indexOf(inferred)

  if (minimum < 0) return selected === inferred
  if (selected === 'double precision') return inferred !== 'bigint'

  return widths.indexOf(selected) >= minimum
}

/** Proves native numeric storage without invoking custom mappings. */
function resolvePostgresNumericAssignment(
  dataType: string,
  context: DialectValueMappingContext,
): 'integer' | 'float' | undefined {
  const facts = context.authoredFacts ?? context.facts
  const storage = mappingStorage(dataType)

  if (
    facts.outputKind !== 'number' ||
    facts.outputState !== 'known' ||
    !NUMBER_OUTPUT_STORAGE.has(storage)
  )
    return undefined

  return facts.numberConstraints.isInteger || INTEGER_STORAGE.includes(storage)
    ? 'integer'
    : 'float'
}

/** Selects built-in conversion without replacing resolved facts with a physical override. */
function resolvePostgresValueStorage(
  dataType: string,
  target?: StorageFacts,
  authored?: StorageFacts,
): {
  type:
    | 'bigint'
    | 'safeNumber'
    | 'date'
    | 'time'
    | 'timestamp'
    | 'timestamptz'
    | 'json'
    | 'uuid'
    | 'identity'
  facts: StorageFacts | undefined
  format: StorageStringFormat | undefined
} {
  const base = mappingStorage(dataType)
  const facts = referenceTemporalAnalysis(base, authored) ?? target
  const kind = facts?.outputKind
  const format = (Object.keys(STRING_FORMAT_STORAGE) as StorageStringFormat[]).find(
    (format) =>
      TEMPORAL_STORAGE.has(base) &&
      STRING_FORMAT_STORAGE[format] === base &&
      facts?.stringFormats.includes(format),
  )

  const type =
    kind === 'bigint' && BIGINT_OUTPUT_STORAGE.has(base)
      ? 'bigint'
      : kind === 'number' && base === 'bigint'
        ? 'safeNumber'
        : base === 'date' ||
            base === 'time' ||
            base === 'timestamp' ||
            base === 'timestamptz'
          ? base
          : JSON_OUTPUT_STORAGE.has(base)
            ? 'json'
            : base === 'uuid'
              ? 'uuid'
              : 'identity'

  return { type, facts, format }
}

export {
  inferPostgresColumnTypeFromFacts,
  selectPostgresColumnStorage,
  validatePostgresValueMappingFromFacts,
  resolvePostgresValueStorage,
  resolvePostgresNumericAssignment,
}
