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
  StorageDesiredSchema,
} from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { ColumnGeneration, DatabaseDefault } from '@/schemas'
import type { StorageFacts } from '@/storage/facts'
import { MigrationError } from '@/utils/error'

import { assertSqliteDefaultCompatibility } from './defaultCompatibility'
import { inferSqliteColumnFacts } from './infer'
import { normalizeSqliteDataType, normalizeSqliteDefaultExpression } from './normalize'
import {
  assertSafeSqliteDataType,
  formatSqliteDefaultExpression,
  formatSqliteLiteral,
} from './validate'

/**
 * Rejects SQLite desired relations outside the supported main database.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 */
function assertMainIdentity(identity: CanonicalRelationIdentity): void {
  if (
    identity.namespace.length !== 1 ||
    identity.namespace[0]?.role !== 'database' ||
    identity.namespace[0].identifier.comparisonKey !== 'main'
  ) {
    throw new MigrationError({
      message: `SQLite ${formatDesiredSchemaIdentity(identity)} is outside the supported database:main profile`,
    })
  }
}

/**
 * Lowers supported portable date and time defaults into dialect SQL.
 *
 * @param expression - Scalar SQL expression or default expression being processed.
 *
 * @returns A validated default expression within the portable supported grammar.
 */
function portableExpression(expression: string): string {
  switch (expression) {
    case 'currentTimestamp':
      return 'CURRENT_TIMESTAMP'
    case 'currentDate':
      return 'CURRENT_DATE'
    case 'currentTime':
      return 'CURRENT_TIME'
    default:
      throw new MigrationError({
        message: `SQLite does not support portable database expression ${JSON.stringify(expression)}`,
      })
  }
}

/**
 * Validates and lowers a tagged database default into comparable SQL.
 *
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns The dialect's lowered database default, or undefined when no default is
 *   declared.
 */
function lowerDefault(value: DatabaseDefault): LoweredDatabaseDefault {
  let sql: string

  switch (value.kind) {
    case 'literal':
      sql = formatSqliteLiteral(value.value)
      break
    case 'portableExpression':
      sql = portableExpression(value.expression)
      break
    case 'dialectExpression':
      if (value.dialect !== 'sqlite') {
        throw new MigrationError({
          message: `SQLite cannot lower database expression tagged for dialect ${JSON.stringify(value.dialect)}`,
        })
      }

      sql = formatSqliteDefaultExpression(value.expression)
      break
  }

  return { sql, normalized: normalizeSqliteDefaultExpression(sql) }
}

/** Selects the explicit physical type or infers one from the column schema. */
function physicalType(
  column: AuthoredDesiredColumn,
  facts: StorageFacts,
  hasGlobalParameterMapping: boolean,
  hasGlobalResultMapping: boolean,
): string {
  const explicit = column.metadata?.physicalType?.sqlite
  const hasParameterMapping =
    hasGlobalParameterMapping || typeof column.metadata?.mapParam === 'function'

  const hasResultMapping =
    hasGlobalResultMapping || typeof column.metadata?.mapResult === 'function'

  if (
    explicit !== undefined &&
    facts.inputSingleton &&
    (facts.outputKind === 'number' || facts.outputKind === 'bigint') &&
    (!hasParameterMapping || !hasResultMapping)
  ) {
    inferSqliteColumnFacts(facts)
  }

  const selected = explicit ?? inferSqliteColumnFacts(facts)

  return assertSafeSqliteDataType(selected)
}

/**
 * Rejects a local reference type that conflicts with its inherited target type.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 * @param column - Authored or observed column metadata used for storage comparison.
 * @param inheritedType - Physical SQL type resolved from the reference target.
 *
 * @returns The compatible reference storage type; conflicting local overrides throw.
 */
function validateReferencePhysicalType(
  table: AuthoredDesiredTable,
  column: AuthoredDesiredColumn,
  inheritedType: string,
): string {
  const selected = column.metadata?.physicalType?.sqlite

  if (selected === undefined) return inheritedType

  const localType = assertSafeSqliteDataType(selected)

  if (normalizeSqliteDataType(localType) !== normalizeSqliteDataType(inheritedType)) {
    throw new MigrationError({
      message: `Reference column ${formatDesiredSchemaIdentity(table.identity, column.name)} selects SQLite type ${JSON.stringify(localType)} but target type is ${JSON.stringify(inheritedType)}`,
    })
  }

  return localType
}

/** Normalizes single-column and composite primary-key declarations into a column list. */
function primaryKeyNames(table: AuthoredDesiredTable): readonly string[] {
  return Array.isArray(table.metadata.primaryKey)
    ? table.metadata.primaryKey
    : [table.metadata.primaryKey]
}

/** Tests the exact INTEGER spelling required for SQLite rowid generation. */
function isExactInteger(dataType: string): boolean {
  return dataType.trim().replace(/\s+/g, ' ').toUpperCase() === 'INTEGER'
}

/**
 * Validates generation metadata against the column's supported physical storage.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 * @param column - Authored or observed column metadata used for storage comparison.
 * @param dataType - Physical SQL type used for validation, comparison, or value mapping.
 *
 * @returns Portable desired generation metadata supported by the selected dialect.
 */
function lowerGeneration(
  table: AuthoredDesiredTable,
  column: AuthoredDesiredColumn,
  dataType: string,
): boolean {
  const generation: ColumnGeneration | undefined = column.metadata?.generation

  if (!generation) return false

  if (generation.kind !== 'identity') {
    if (generation.kind === 'dialectGeneration' && generation.dialect !== 'sqlite') {
      throw new MigrationError({
        message: `SQLite cannot lower generation tagged for dialect ${JSON.stringify(generation.dialect)}`,
      })
    }

    throw new MigrationError({
      message: `SQLite does not support ${generation.kind} generation on ${formatDesiredSchemaIdentity(table.identity, column.name)}`,
    })
  }

  const primaryKey = primaryKeyNames(table)
  const legal =
    generation.mode === 'byDefault' &&
    primaryKey.length === 1 &&
    primaryKey[0] === column.name &&
    isExactInteger(dataType)

  if (!legal) {
    throw new MigrationError({
      message: `SQLite AUTOINCREMENT identity on ${formatDesiredSchemaIdentity(table.identity, column.name)} requires identity byDefault on an exact INTEGER single-column primary key`,
    })
  }

  return true
}

/**
 * Builds dialect-validated column storage metadata for the shared lowerer to freeze.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 * @param column - Authored or observed column metadata used for storage comparison.
 * @param dataType - Physical SQL type used for validation, comparison, or value mapping.
 * @param analysis - Resolved schema facts for physical type selection and validation.
 *
 * @returns The desired column's validated physical storage, generation, and default
 *   metadata.
 */
function lowerColumn(
  table: AuthoredDesiredTable,
  column: AuthoredDesiredColumn,
  dataType: string,
  facts: StorageFacts,
  hasResultMapping: boolean,
): LoweredDesiredColumn {
  if (column.metadata?.comment !== undefined) {
    throw new MigrationError({
      message: `SQLite migration lowering does not support comments on ${formatDesiredSchemaIdentity(table.identity, column.name)}`,
    })
  }

  if (column.metadata?.onUpdate !== undefined) {
    throw new MigrationError({
      message: `SQLite migration lowering does not support onUpdate on ${formatDesiredSchemaIdentity(table.identity, column.name)}`,
    })
  }

  const primaryKey = primaryKeyNames(table)
  const autoIncrement = lowerGeneration(table, column, dataType)
  const reference = column.reference
  const databaseDefault = lowerColumnDefault(table, column, dataType, hasResultMapping)

  return {
    identifier: column.identifier,
    dataType,
    notNull: !facts.nullable,
    unique:
      (column.metadata?.unique ?? false) &&
      !(primaryKey.length === 1 && primaryKey[0] === column.name),
    autoIncrement,
    ...(databaseDefault === undefined ? {} : { databaseDefault }),
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

/** Validates a column's logical default contract before formatting its declared SQL. */
function lowerColumnDefault(
  table: AuthoredDesiredTable,
  column: AuthoredDesiredColumn,
  dataType: string,
  hasGlobalResultMapping: boolean,
): LoweredDatabaseDefault | undefined {
  const value = column.metadata?.databaseDefault

  if (value === undefined) return undefined

  assertSqliteDefaultCompatibility(
    value,
    dataType,
    column.facts,
    hasGlobalResultMapping || typeof column.metadata?.mapResult === 'function',
    formatDesiredSchemaIdentity(table.identity, column.name),
  )

  return lowerDefault(value)
}

/** Lowers SQLite's supported ordinary main-database table profile. */
export function lowerSqliteDesiredSchema(
  graph: AuthoredDesiredSchema,
  context?: Parameters<DialectSchema['lowerDesiredSchema']>[1],
): StorageDesiredSchema {
  return lowerDesiredSchemaGraph(graph, context, {
    validateIdentity: assertMainIdentity,
    lowerPhysicalType: (column, options) =>
      physicalType(
        column,
        column.facts,
        options?.hasGlobalParameterMapping ?? false,
        options?.hasGlobalResultMapping ?? false,
      ),
    lowerReferenceType: (table, column, inheritedType) =>
      validateReferencePhysicalType(table, column, inheritedType),
    lowerColumn: (table, column, dataType, options) =>
      lowerColumn(
        table,
        column,
        dataType,
        column.facts,
        options?.hasGlobalResultMapping ?? false,
      ),
  })
}
