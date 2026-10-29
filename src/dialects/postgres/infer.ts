import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { StorageFacts, StorageStringFormat } from '@/storage/facts'
import type { NumberConstraints, StringConstraints } from '@/types/constraints'
import type { AnySchema } from '@/types/schema'
import { isNumber } from '@/utils'
import { SchemaError } from '@/utils/error'

import type { SqlDataType } from '../types'

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
function inferPostgresFormatType(analysis: StorageFacts): SqlDataType | undefined {
  const targets = [
    ...new Set(analysis.stringFormats.map((format) => STRING_FORMAT_STORAGE[format])),
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
 * @returns `varchar(n)` for maxLength ≤ 255, `text` otherwise
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
function inferPostgresChoiceType(analysis: StorageFacts): SqlDataType {
  const options = analysis.finiteValues
  const kind = analysis.outputKind

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

/**
 * Infers a PostgreSQL column type from a Valibot schema.
 *
 * @example
 *   inferPostgresColumnType(string()) // 'text'
 *   inferPostgresColumnType(pipe(string(), maxLength(50))) // 'varchar(50)'
 *   inferPostgresColumnType(optional(pipe(string(), maxLength(50)))) // 'varchar(50)'
 *   inferPostgresColumnType(number()) // 'double precision'
 *   inferPostgresColumnType(integer()) // 'integer'
 *
 * @param schema - Column schema (may be wrapped or piped)
 *
 * @returns PostgreSQL column data type
 *
 * @throws SchemaError when the schema type cannot be inferred
 */
export function inferPostgresColumnType(schema: AnySchema): SqlDataType {
  // Remove this extraction adapter when shared callers pass facts in #388.
  return inferPostgresColumnTypeFromFacts(extractStorageFacts(schema))
}

/** Selects PostgreSQL storage from provider-neutral evidence. */
export function inferPostgresColumnTypeFromFacts(facts: StorageFacts): SqlDataType {
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

function inferEffectivePostgresType(analysis: StorageFacts): SqlDataType | undefined {
  if (analysis.composite) return inferPostgresCompositeType(analysis)

  if (analysis.finiteEvidence === 'singleton')
    return inferPostgresLiteralType(analysis.singletonValue)

  if (analysis.finiteEvidence === 'choice') return inferPostgresChoiceType(analysis)

  switch (analysis.outputKind) {
    case 'string':
      return (
        inferPostgresFormatType(analysis) ??
        inferPostgresStringType(analysis.stringConstraints)
      )
    case 'number': {
      return inferPostgresNumberOutputType(analysis.numberConstraints)
    }
    case 'bigint': {
      const { minValue, maxValue } = analysis.bigintConstraints
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
function inferPostgresCompositeType(analysis: StorageFacts): SqlDataType {
  const composite = analysis.composite!
  const branches = composite.branches.filter((branch) => !branch.nullOnly)
  const kind = analysis.outputKind

  if (kind === 'json' && analysis.jsonOutputCompatible !== true)
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
      ? branches.map((branch) => withNumberFacts(branch, analysis.numberConstraints))
      : kind === 'bigint'
        ? branches.map((branch) => withBigintFacts(branch, analysis.bigintConstraints))
        : branches

  const types = constrainedBranches.map((branch) => inferEffectivePostgresType(branch))

  if (types.some((type) => !type)) return unsupportedCompositeType(composite.kind)

  const storage = types as SqlDataType[]
  const inferred =
    kind === 'string'
      ? inferPostgresCompositeStringType(analysis, branches, storage)
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
  analysis: StorageFacts,
  branches: readonly StorageFacts[],
  types: readonly SqlDataType[],
): SqlDataType | undefined {
  const outerFormat = inferPostgresFormatType(analysis)
  const allText = types.every(isPostgresTextStorage)

  if (outerFormat && allText) return outerFormat

  if (types.every((type) => type === types[0])) {
    const type = types[0]!
    const formats = [...branches[0]!.stringFormats].sort().join(',')

    if (
      (type === 'time' || type === 'timestamp') &&
      branches.some((branch) => [...branch.stringFormats].sort().join(',') !== formats)
    )
      return undefined

    if (outerFormat && outerFormat !== type) return undefined

    if (allText && analysis.stringConstraints.maxLength !== undefined)
      return inferPostgresStringType(analysis.stringConstraints)

    return type
  }

  if (!allText) return undefined

  if (analysis.stringConstraints.maxLength !== undefined)
    return inferPostgresStringType(analysis.stringConstraints)

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
  const integers = ['smallint', 'integer', 'bigint']

  if (types.every((type) => integers.includes(type)))
    return integers[Math.max(...types.map((type) => integers.indexOf(type)))]!

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
