import type { StorageFacts } from '@/storage/facts'
import { SchemaError } from '@/utils/error'

import type {
  AuthoredDesiredColumn,
  DialectSchema,
  DialectValueMappingContext,
  SqlDataType,
} from '../types'

import { normalizeSqliteDataType } from './normalize'
import { isSqliteSupportedBigInt, isSqliteSupportedNumber } from './numeric'
import { assertSafeSqliteDataType } from './validate'

function unsupportedChoiceType(): never {
  throw new SchemaError({
    message:
      'cannot infer a SQLite column type for a mixed or unsupported choice output; specify column({ physicalType: { sqlite: ... } }) and explicit parameter and result mappings',
  })
}

/** Infers storage from finite-choice evidence, without inspecting a schema. */
function inferSqliteChoiceType(facts: StorageFacts): SqlDataType {
  const values = facts.finiteValues
  const kind = facts.outputKind

  if (!values?.length || !kind) return unsupportedChoiceType()
  if (kind === 'string') return 'TEXT'

  if (kind === 'number') {
    if (
      values.some((value) => typeof value !== 'number' || !isSqliteSupportedNumber(value))
    )
      return unsupportedChoiceType()

    return values.every((value) => Number.isInteger(value)) ? 'INTEGER' : 'REAL'
  }

  if (kind === 'bigint') {
    if (
      values.some((value) => typeof value !== 'bigint' || !isSqliteSupportedBigInt(value))
    )
      return unsupportedChoiceType()

    return 'BIGINT'
  }

  if (kind === 'boolean') return 'BOOLEAN'

  return unsupportedChoiceType()
}

function inferSqliteLiteralType(literal: unknown): SqlDataType {
  if (typeof literal === 'string') return 'TEXT'

  if (typeof literal === 'number') {
    if (!isSqliteSupportedNumber(literal))
      throw new SchemaError({
        message:
          'cannot infer a SQLite column type for a non-finite or unsafe integer literal',
      })

    return Number.isInteger(literal) ? 'INTEGER' : 'REAL'
  }

  if (typeof literal === 'bigint') {
    if (!isSqliteSupportedBigInt(literal))
      throw new SchemaError({
        message:
          'cannot infer a SQLite column type for a bigint literal outside the signed 64-bit integer range',
      })

    return 'BIGINT'
  }

  if (typeof literal === 'boolean') return 'BOOLEAN'
  if (literal === null) return 'NULL'

  throw new SchemaError({ message: 'cannot infer a SQLite column type for this literal' })
}

/** Infers a SQLite declared type from semantic storage evidence. */
function inferSqliteColumnTypeFromFacts(facts: StorageFacts): SqlDataType {
  const inferred = inferEffectiveSqliteType(facts)

  if (inferred) return inferred

  const detail =
    facts.outputState === 'unresolved'
      ? 'an unresolved transformation'
      : 'the registered schema'

  throw new SchemaError({
    message: `cannot infer a SQLite column type for ${detail}; specify it explicitly with column({ physicalType: { sqlite: ... } })`,
  })
}

function inferEffectiveSqliteType(facts: StorageFacts): SqlDataType | undefined {
  if (facts.composite) return inferSqliteCompositeType(facts)

  if (facts.finiteEvidence === 'singleton')
    return inferSqliteLiteralType(facts.singletonValue)

  if (facts.finiteEvidence === 'choice') return inferSqliteChoiceType(facts)

  return selectOutputType(facts, 'storage')
}

/**
 * Physical inference proves number bounds; logical mapping retains its numeric
 * conversion.
 */
function selectOutputType(
  facts: StorageFacts,
  purpose: 'storage' | 'mapping',
): SqlDataType | undefined {
  switch (facts.outputKind) {
    case 'string':
      return 'TEXT'
    case 'number':
      if (purpose === 'storage') return inferSqliteNumberOutputType(facts)
      if (facts.finiteEvidence === 'choice') return inferSqliteChoiceType(facts)

      return facts.numberConstraints.isInteger ? 'INTEGER' : 'REAL'
    case 'bigint':
      return 'BIGINT'
    case 'boolean':
      return 'BOOLEAN'
    case 'date':
      return 'DATETIME'
    case 'json':
      return 'JSON'
    case undefined:
      return undefined
  }
}

function inferSqliteNumberOutputType(facts: StorageFacts): SqlDataType {
  const { minValue, maxValue, isInteger, isSafeInteger } = facts.numberConstraints

  if (isSafeInteger || isInteger) return 'INTEGER'

  if (
    (minValue !== undefined && !Number.isFinite(minValue)) ||
    (maxValue !== undefined && !Number.isFinite(maxValue))
  )
    throw new SchemaError({
      message: 'cannot infer a SQLite column type for non-finite number bounds',
    })

  return 'REAL'
}

function inferSqliteCompositeType(facts: StorageFacts): SqlDataType {
  const composite = facts.composite!
  const branches = composite.branches.filter((branch) => !branch.nullOnly)
  const kind = facts.outputKind

  if (kind === 'json' && facts.jsonOutputCompatible !== true)
    throw new SchemaError({
      message:
        'SQLite JSON composite output is not preserved by JSON serialization; provide column({ physicalType: { sqlite: ... } }) and paired parameter and result mappings',
    })

  if (
    !branches.length ||
    !kind ||
    (composite.kind === 'intersection' && branches.length !== composite.branches.length)
  )
    return unsupportedCompositeType(composite.kind)

  const numericBranches =
    kind === 'number'
      ? branches.map((branch) => ({
          ...branch,
          numberConstraints: {
            ...branch.numberConstraints,
            ...(facts.numberConstraints.minValue === undefined
              ? {}
              : {
                  minValue: Math.max(
                    branch.numberConstraints.minValue ?? -Infinity,
                    facts.numberConstraints.minValue,
                  ),
                }),
            ...(facts.numberConstraints.maxValue === undefined
              ? {}
              : {
                  maxValue: Math.min(
                    branch.numberConstraints.maxValue ?? Infinity,
                    facts.numberConstraints.maxValue,
                  ),
                }),
            ...(facts.numberConstraints.isInteger ? { isInteger: true } : {}),
            ...(facts.numberConstraints.isSafeInteger ? { isSafeInteger: true } : {}),
          },
        }))
      : branches

  const types = numericBranches.map((branch) => inferEffectiveSqliteType(branch))

  if (types.some((type) => !type)) return unsupportedCompositeType(composite.kind)
  if (types.every((type) => type === types[0])) return types[0]!

  if (kind === 'number' && types.every((type) => type === 'INTEGER' || type === 'REAL'))
    return 'REAL'

  return unsupportedCompositeType(composite.kind)
}

function unsupportedCompositeType(type: string): never {
  throw new SchemaError({
    message: `cannot infer SQLite storage for incompatible ${type} branches; provide explicit physical type and parameter and result mappings`,
  })
}

/** Validates built-in mapping from resolved and locally authored storage facts. */
function validateSqliteValueMappingFromFacts(
  dataType: string,
  facts: StorageFacts,
  authored?: StorageFacts,
): void {
  const affinity = normalizeSqliteDataType(dataType)
  const kind = facts.outputKind
  const incompatibleAuthoredOutput = authored && authored.outputKind !== kind

  if (facts.composite) inferSqliteColumnTypeFromFacts(facts)
  if (authored?.composite) inferSqliteColumnTypeFromFacts(authored)

  const supported =
    kind === 'date' ||
    kind === 'json' ||
    (kind === 'string' && (affinity === 'text' || affinity === 'blob')) ||
    ((kind === 'number' || kind === 'boolean') && affinity !== 'text') ||
    (kind === 'bigint' &&
      (affinity === 'integer' || affinity === 'numeric' || affinity === 'blob'))

  if (!supported || facts.outputState === 'unresolved' || incompatibleAuthoredOutput) {
    throw new SchemaError({
      message: `SQLite ${kind ?? facts.outputState} schema with ${JSON.stringify(dataType)} (${affinity} affinity) requires explicit parameter and result mappings`,
    })
  }
}

/** Chooses logical conversion independently of SQLite affinity. */
function resolveSqliteValueStorage(
  dataType: string,
  facts: StorageFacts,
  authored?: StorageFacts,
): string {
  validateSqliteValueMappingFromFacts(dataType, facts, authored)

  if (facts.composite) return inferSqliteColumnTypeFromFacts(facts)

  return selectOutputType(facts, 'mapping') ?? 'NULL'
}

/** Selects the explicit physical type or infers one from the column schema. */
function selectSqliteColumnStorage(
  column: AuthoredDesiredColumn,
  context?: Parameters<DialectSchema['lowerDesiredSchema']>[1],
): string {
  const facts = column.facts
  const explicit = column.metadata?.physicalType?.sqlite
  const hasParameterMapping =
    context?.hasGlobalParameterMapping || typeof column.metadata?.mapParam === 'function'

  const hasResultMapping =
    context?.hasGlobalResultMapping || typeof column.metadata?.mapResult === 'function'

  if (
    explicit !== undefined &&
    facts.inputSingleton &&
    (facts.outputKind === 'number' || facts.outputKind === 'bigint') &&
    (!hasParameterMapping || !hasResultMapping)
  ) {
    inferSqliteColumnTypeFromFacts(facts)
  }

  const selected = explicit ?? inferSqliteColumnTypeFromFacts(facts)

  return assertSafeSqliteDataType(selected)
}

/** Proves native numeric storage without invoking custom mappings. */
function resolveSqliteNumericAssignment(
  dataType: string,
  context: DialectValueMappingContext,
): 'integer' | 'float' | undefined {
  const facts = context.authoredFacts ?? context.facts
  const storage = normalizeSqliteDataType(dataType)

  if (
    facts.outputKind !== 'number' ||
    facts.outputState !== 'known' ||
    !['integer', 'real', 'numeric'].includes(storage)
  )
    return undefined

  // INTEGER affinity can still store fractional values without an integer schema.
  return facts.numberConstraints.isInteger ? 'integer' : 'float'
}

export {
  inferSqliteColumnTypeFromFacts,
  selectSqliteColumnStorage,
  validateSqliteValueMappingFromFacts,
  resolveSqliteValueStorage,
  resolveSqliteNumericAssignment,
}
