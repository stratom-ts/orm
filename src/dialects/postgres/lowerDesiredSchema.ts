import {
  formatDesiredSchemaIdentity,
  lowerDesiredSchemaGraph,
} from '@/dialects/lowerDesiredSchema'
import type {
  AuthoredDesiredColumn,
  AuthoredDesiredSchema,
  AuthoredDesiredTable,
  DialectSchema,
  LoweredDatabaseDefault,
  LoweredDesiredColumn,
  LoweredDesiredSchema,
} from '@/dialects/types'
import type { ColumnGeneration, DatabaseDefault } from '@/schemas'
import type { SchemaAnalysis } from '@/schemas/utils/analyzeSchema'
import { MigrationError, isErrorTag } from '@/utils/error'

import { inferPostgresColumnType } from './infer'
import { assertPostgresScalarStorage } from './mapping'
import {
  normalizePostgresDataType,
  normalizePostgresDefaultExpression,
} from './normalize'
import {
  assertSafePostgresDataType,
  assertSafePostgresDefaultExpression,
  formatPostgresLiteral,
} from './validate'

const IDENTITY_BASE_TYPES = new Set([
  'smallint',
  'integer',
  'bigint',
  'int2',
  'int4',
  'int8',
])

/**
 * Lowers a portable database expression to PostgreSQL SQL.
 *
 * @param expression - Portable expression name.
 */
function portableExpression(expression: string): string {
  switch (expression) {
    case 'currentTimestamp':
      return 'current_timestamp'
    case 'currentDate':
      return 'current_date'
    case 'currentTime':
      return 'current_time'
    default:
      throw new MigrationError({
        message: `PostgreSQL does not support portable database expression ${JSON.stringify(expression)}`,
      })
  }
}

/**
 * Lowers a database default to normalized PostgreSQL SQL.
 *
 * @param value - Authored database default.
 */
function lowerDefault(value: DatabaseDefault): LoweredDatabaseDefault {
  let sql: string

  switch (value.kind) {
    case 'literal':
      sql = formatPostgresLiteral(value.value)
      break
    case 'portableExpression':
      sql = portableExpression(value.expression)
      break
    case 'dialectExpression':
      if (value.dialect !== 'postgresql') {
        throw new MigrationError({
          message: `PostgreSQL cannot lower database expression tagged for dialect ${JSON.stringify(value.dialect)}`,
        })
      }

      sql = assertSafePostgresDefaultExpression(value.expression)
      break
  }

  return { sql, normalized: normalizePostgresDefaultExpression(sql) }
}

/**
 * Lowers supported column generation metadata.
 *
 * @param generation - Authored generation metadata.
 */
function lowerGeneration(
  generation: ColumnGeneration | undefined,
): 'always' | 'byDefault' | undefined {
  if (!generation) return
  if (generation.kind === 'identity') return generation.mode

  if (generation.kind === 'computed') {
    throw new MigrationError({
      message:
        'PostgreSQL computed generation is not supported by this migration adapter',
    })
  }

  if (generation.dialect !== 'postgresql') {
    throw new MigrationError({
      message: `PostgreSQL cannot lower generation tagged for dialect ${JSON.stringify(generation.dialect)}`,
    })
  }

  throw new MigrationError({
    message: `Unsupported PostgreSQL dialect generation ${JSON.stringify(generation.generation)}`,
  })
}

/**
 * Selects and validates a column's PostgreSQL physical type.
 *
 * @param column - Authored desired column.
 * @param analysis - Analysis of the column schema.
 * @param hasGlobalParameterMapping - Whether the client maps every parameter.
 * @param hasGlobalResultMapping - Whether the client maps every result.
 */
function physicalType(
  column: AuthoredDesiredColumn,
  analysis: SchemaAnalysis,
  hasGlobalParameterMapping: boolean,
  hasGlobalResultMapping: boolean,
): string {
  const metadata = column.metadata
  const explicit = metadata?.physicalType?.postgresql
  const hasParameterMapping =
    hasGlobalParameterMapping || typeof metadata?.mapParam === 'function'

  const hasResultMapping =
    hasGlobalResultMapping || typeof metadata?.mapResult === 'function'

  const selected = assertSafePostgresDataType(
    String(explicit ?? inferPostgresColumnType(column.schema, analysis)),
  )

  if (explicit !== undefined && (!hasParameterMapping || !hasResultMapping))
    assertPostgresScalarStorage(selected, analysis)

  return selected
}

/**
 * Validates an explicit reference-column type against its inherited type.
 *
 * @param table - Table containing the reference column.
 * @param column - Reference column.
 * @param inheritedType - Physical type inherited from the target column.
 */
function validateReferencePhysicalType(
  table: AuthoredDesiredTable,
  column: AuthoredDesiredColumn,
  inheritedType: string,
): string {
  const selected = column.metadata?.physicalType?.postgresql

  if (selected === undefined) return inheritedType

  const localType = assertSafePostgresDataType(String(selected))

  if (normalizePostgresDataType(localType) !== normalizePostgresDataType(inheritedType)) {
    throw new MigrationError({
      message: `Reference column ${formatDesiredSchemaIdentity(table.identity, column.name)} selects PostgreSQL type ${JSON.stringify(localType)} but target type is ${JSON.stringify(inheritedType)}`,
    })
  }

  return inheritedType
}

/**
 * Validates PostgreSQL column metadata and returns identity generation mode.
 *
 * @param table - Table containing the column.
 * @param column - Authored desired column.
 * @param dataType - Resolved PostgreSQL physical type.
 */
function validatePostgresColumn(
  table: AuthoredDesiredTable,
  column: AuthoredDesiredColumn,
  dataType: string,
): 'always' | 'byDefault' | undefined {
  const metadata = column.metadata

  if (metadata?.comment !== undefined) {
    throw new MigrationError({
      message: `PostgreSQL migration lowering does not support comments on ${formatDesiredSchemaIdentity(table.identity, column.name)}`,
    })
  }

  if (metadata?.onUpdate !== undefined) {
    throw new MigrationError({
      message: `PostgreSQL migration lowering does not support onUpdate on ${formatDesiredSchemaIdentity(table.identity, column.name)}`,
    })
  }

  const generated = lowerGeneration(metadata?.generation)

  if (generated !== undefined) {
    const base = normalizePostgresDataType(dataType)
      .toLowerCase()
      .replace(/\(.*\)$/, '')
      .trim()

    if (!IDENTITY_BASE_TYPES.has(base)) {
      throw new MigrationError({
        message: `column ${formatDesiredSchemaIdentity(table.identity, column.name)} uses identity generation with type ${JSON.stringify(dataType)}; PostgreSQL identity requires smallint, integer, or bigint`,
      })
    }
  }

  return generated
}

/**
 * Lowers one resolved column to create-table AST.
 *
 * @param table - Table containing the column.
 * @param column - Authored desired column.
 * @param dataType - Resolved PostgreSQL physical type.
 */
function lowerColumn(
  table: AuthoredDesiredTable,
  column: AuthoredDesiredColumn,
  dataType: string,
  analysis: SchemaAnalysis,
): LoweredDesiredColumn {
  const generated = validatePostgresColumn(table, column, dataType)
  const primaryKey = Array.isArray(table.metadata.primaryKey)
    ? table.metadata.primaryKey
    : [table.metadata.primaryKey]

  const reference = column.reference

  // PostgreSQL catalogs omit DEFAULT NULL because it is the implicit nullable-column default.
  const databaseDefault = column.metadata?.databaseDefault
  return {
    identifier: column.identifier,
    dataType,
    notNull: !analysis.nullable,
    unique:
      (column.metadata?.unique ?? false) &&
      !(primaryKey.length === 1 && primaryKey[0] === column.name),
    autoIncrement: false,
    ...(databaseDefault === undefined ||
    (databaseDefault.kind === 'literal' && databaseDefault.value === null)
      ? {}
      : { databaseDefault: lowerDefault(databaseDefault) }),
    ...(generated === undefined ? {} : { generated }),
    ...(reference === undefined
      ? {}
      : {
          reference: {
            relation: reference.targetRelation,
            column: reference.targetColumn,
            ...(reference.metadata.onDelete === undefined
              ? {}
              : { onDelete: reference.metadata.onDelete }),
            ...(reference.metadata.onUpdate === undefined
              ? {}
              : { onUpdate: reference.metadata.onUpdate }),
          },
        }),
  }
}

/**
 * Deterministically lowers the desired schema graph in two dependency-aware passes.
 *
 * @example
 *   const lowered = lowerPostgresDesiredSchema(graph)
 *
 * @param graph - Authored desired schema graph.
 * @param context - Client-wide mapping hooks that bypass built-in storage checks.
 */
export function lowerPostgresDesiredSchema(
  graph: AuthoredDesiredSchema,
  context?: Parameters<DialectSchema['lowerDesiredSchema']>[1],
): LoweredDesiredSchema {
  try {
    return lowerDesiredSchemaGraph(graph, context, {
      lowerPhysicalType: (column, analysis, options) =>
        physicalType(
          column,
          analysis,
          options?.hasGlobalParameterMapping ?? false,
          options?.hasGlobalResultMapping ?? false,
        ),
      lowerReferenceType: (table, column, inheritedType) =>
        validateReferencePhysicalType(table, column, inheritedType),
      lowerColumn: (table, column, dataType, analysis) =>
        lowerColumn(table, column, dataType, analysis),
    })
  } catch (cause) {
    if (!isErrorTag(cause, 'SchemaError')) throw cause

    throw new MigrationError({
      message: `PostgreSQL desired schema lowering failed: ${cause.message}`,
      cause,
    })
  }
}
