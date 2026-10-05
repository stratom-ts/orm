import type {
  AuthoredDesiredColumn,
  AuthoredDesiredSchema,
  AuthoredDesiredTable,
  LoweredDatabaseDefault,
  LoweredDesiredColumn,
  LoweredDesiredSchema,
} from '@/dialects/types'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
} from '@/migrations/canonicalRelationIdentity'
import type {
  ColumnGeneration,
  ColumnMetadata,
  DatabaseDefault,
  ReferenceMetadata,
} from '@/schemas'
import { analyzeSchema } from '@/schemas'
import type { SchemaAnalysis } from '@/schemas/utils/analyzeSchema'
import type { AnySchema } from '@/types/schema'
import { MigrationError } from '@/utils/error'

import { inferSqliteColumnType } from './infer'
import { normalizeSqliteDataType, normalizeSqliteDefaultExpression } from './normalize'
import {
  assertSafeSqliteDataType,
  formatSqliteDefaultExpression,
  formatSqliteLiteral,
} from './validate'

/**
 * Compares ordered namespace roles and canonical identifier keys.
 *
 * @param left - Left operand or identity in the comparison.
 * @param right - Right operand or identity in the comparison.
 *
 * @returns True when both identities have equal canonical namespace and relation keys.
 */
function sameIdentity(
  left: CanonicalRelationIdentity,
  right: CanonicalRelationIdentity,
): boolean {
  return (
    left.relation.comparisonKey === right.relation.comparisonKey &&
    left.namespace.length === right.namespace.length &&
    left.namespace.every(
      (segment, index) =>
        segment.role === right.namespace[index]?.role &&
        segment.identifier.comparisonKey ===
          right.namespace[index]?.identifier.comparisonKey,
    )
  )
}

/**
 * Formats canonical namespace, relation, and optional member spellings for diagnostics.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param column - Authored column spelling to resolve, map, or compile.
 *
 * @returns A diagnostic identity spelling that keeps namespace and relation components
 *   distinct.
 */
function formatIdentity(identity: CanonicalRelationIdentity, column?: string): string {
  const parts = identity.namespace.map(
    (segment) => `${segment.role}:${JSON.stringify(segment.identifier.spelling)}`,
  )

  parts.push(`relation:${JSON.stringify(identity.relation.spelling)}`)

  if (column !== undefined) parts.push(`column:${JSON.stringify(column)}`)

  return `[${parts.join(', ')}]`
}

/**
 * Copies and sorts desired columns by canonical key, then authored spelling.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 *
 * @returns And sorts desired columns by canonical key, then authored spelling.
 */
function orderedColumns(table: AuthoredDesiredTable): AuthoredDesiredColumn[] {
  return [...table.columns].sort(
    (left, right) =>
      (left.identifier.comparisonKey < right.identifier.comparisonKey
        ? -1
        : left.identifier.comparisonKey > right.identifier.comparisonKey
          ? 1
          : 0) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  )
}

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
      message: `SQLite ${formatIdentity(identity)} is outside the supported database:main profile`,
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
function physicalType(column: AuthoredDesiredColumn, analysis: SchemaAnalysis): string {
  const selected =
    column.metadata?.physicalType?.sqlite ??
    inferSqliteColumnType(column.schema, analysis)

  return assertSafeSqliteDataType(String(selected))
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
): string | undefined {
  const selected = column.metadata?.physicalType?.sqlite

  if (selected === undefined) return undefined

  const localType = assertSafeSqliteDataType(String(selected))

  if (normalizeSqliteDataType(localType) !== normalizeSqliteDataType(inheritedType)) {
    throw new MigrationError({
      message: `Reference column ${formatIdentity(table.identity, column.name)} selects SQLite type ${JSON.stringify(localType)} but target type is ${JSON.stringify(inheritedType)}`,
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
      message: `SQLite does not support ${generation.kind} generation on ${formatIdentity(table.identity, column.name)}`,
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
      message: `SQLite AUTOINCREMENT identity on ${formatIdentity(table.identity, column.name)} requires identity byDefault on an exact INTEGER single-column primary key`,
    })
  }

  return true
}

/**
 * Builds immutable column storage metadata after dialect validation.
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
  analysis: SchemaAnalysis,
): LoweredDesiredColumn {
  if (column.metadata?.comment !== undefined) {
    throw new MigrationError({
      message: `SQLite migration lowering does not support comments on ${formatIdentity(table.identity, column.name)}`,
    })
  }

  if (column.metadata?.onUpdate !== undefined) {
    throw new MigrationError({
      message: `SQLite migration lowering does not support onUpdate on ${formatIdentity(table.identity, column.name)}`,
    })
  }

  const primaryKey = primaryKeyNames(table)
  const autoIncrement = lowerGeneration(table, column, dataType)
  const reference = column.reference

  return Object.freeze({
    identifier: column.identifier,
    dataType,
    notNull: !analysis.nullable,
    unique:
      (column.metadata?.unique ?? false) &&
      !(primaryKey.length === 1 && primaryKey[0] === column.name),
    autoIncrement,
    ...(column.metadata?.databaseDefault === undefined
      ? {}
      : { databaseDefault: lowerDefault(column.metadata.databaseDefault) }),
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
  })
}

/** Lowers SQLite's supported ordinary main-database table profile. */
export function lowerSqliteDesiredSchema(
  graph: AuthoredDesiredSchema,
): LoweredDesiredSchema {
  const resolvedTypes = new Map<AuthoredDesiredColumn, string>()
  const analyses = new Map<AuthoredDesiredColumn, SchemaAnalysis>()

  /** Caches schema facts and resolves physical types for columns without references. */
  function registerColumnAnalysis(column: AuthoredDesiredColumn): void {
    const analysis = analyzeSchema(column.schema)
    analyses.set(column, analysis)

    if (!column.reference) resolvedTypes.set(column, physicalType(column, analysis))
  }

  for (const table of graph.tables) {
    assertMainIdentity(table.identity)

    if (table.columns.length === 0) {
      throw new MigrationError({
        message: `table ${formatIdentity(table.identity)} has no columns`,
      })
    }

    for (const column of orderedColumns(table)) registerColumnAnalysis(column)
  }

  resolveReferenceTypes(graph, resolvedTypes)

  const loweredColumns = new Map<AuthoredDesiredColumn, LoweredDesiredColumn>()

  for (const table of graph.tables) {
    for (const column of orderedColumns(table)) {
      loweredColumns.set(
        column,
        lowerColumn(table, column, resolvedTypes.get(column)!, analyses.get(column)!),
      )
    }
  }

  return freezeLoweredSchema(graph, loweredColumns)
}

type PendingReference = { table: AuthoredDesiredTable; column: AuthoredDesiredColumn }

/**
 * Freezes resolved tables, columns, and primary-key identifiers into a desired schema.
 *
 * @param graph - Registered authored tables and their resolved reference graph.
 * @param loweredColumns - Desired columns after dialect-specific storage resolution.
 *
 * @returns An immutable desired schema with frozen table, column, and key metadata.
 */
function freezeLoweredSchema(
  graph: AuthoredDesiredSchema,
  loweredColumns: ReadonlyMap<AuthoredDesiredColumn, LoweredDesiredColumn>,
): LoweredDesiredSchema {
  return Object.freeze({
    tables: Object.freeze(
      graph.tables.map((table) => {
        const primaryKey = primaryKeyNames(table)

        return Object.freeze({
          handle: table.handle,
          identity: table.identity,
          columns: Object.freeze(
            table.columns.map((column) => loweredColumns.get(column)!),
          ),
          primaryKey: Object.freeze(
            primaryKey.map((name) => {
              const column = table.columns.find((candidate) => candidate.name === name)

              if (!column) {
                throw new MigrationError({
                  message: `Primary key ${formatIdentity(table.identity, name)} does not name a desired column`,
                })
              }

              return column.identifier
            }),
          ),
        })
      }),
    ),
  })
}

/**
 * Resolves reference types in dependency order and rejects cycles without progress.
 *
 * @param graph - Registered authored tables and their resolved reference graph.
 * @param resolvedTypes - Mutable cache of physical types already resolved for authored
 *   columns.
 */
function resolveReferenceTypes(
  graph: AuthoredDesiredSchema,
  resolvedTypes: Map<
    Readonly<{
      name: string
      identifier: CanonicalIdentifier
      schema: AnySchema
      metadata?: ColumnMetadata
      reference?: Readonly<{
        metadata: ReferenceMetadata
        targetRelation: CanonicalRelationIdentity
        targetColumn: CanonicalIdentifier
      }>
    }>,
    string
  >,
) {
  let pending = graph.tables.flatMap((table) =>
    orderedColumns(table)
      .filter((column) => column.reference !== undefined)
      .map((column) => ({ table, column })),
  )

  while (pending.length > 0) {
    const unresolved: typeof pending = []
    let progress = false

    for (const item of pending)
      progress = resolvePendingType(item, unresolved, graph, resolvedTypes) || progress

    if (!progress) {
      const first = unresolved[0]!
      throw new MigrationError({
        message: `Cannot resolve reference-only physical type cycle at ${formatIdentity(first.table.identity, first.column.name)}`,
      })
    }

    pending = unresolved
  }
}

/**
 * Resolves one reference type or defers it until the target's type is known.
 *
 * @param item - Current member or pending reference under evaluation.
 * @param unresolved - Pending references whose target types are not yet available.
 * @param graph - Registered authored tables and their resolved reference graph.
 * @param resolvedTypes - Mutable cache of physical types already resolved for authored
 *   columns.
 *
 * @returns Whether the target type was available and this reference was resolved.
 */
function resolvePendingType(
  item: PendingReference,
  unresolved: PendingReference[],
  graph: AuthoredDesiredSchema,
  resolvedTypes: Map<AuthoredDesiredColumn, string>,
): boolean {
  const reference = item.column.reference!
  assertMainIdentity(reference.targetRelation)
  const targetTable = graph.tables.find((table) =>
    sameIdentity(table.identity, reference.targetRelation),
  )

  if (!targetTable) {
    throw new MigrationError({
      message: `Reference ${formatIdentity(item.table.identity, item.column.name)} targets unregistered relation ${formatIdentity(reference.targetRelation)}`,
    })
  }

  const targetColumn = targetTable.columns.find(
    (column) => column.identifier.comparisonKey === reference.targetColumn.comparisonKey,
  )

  if (!targetColumn) {
    throw new MigrationError({
      message: `Reference ${formatIdentity(item.table.identity, item.column.name)} targets missing column ${formatIdentity(reference.targetRelation, reference.targetColumn.spelling)}`,
    })
  }

  const inheritedType = resolvedTypes.get(targetColumn)

  if (inheritedType === undefined) {
    unresolved.push(item)
    return false
  }

  resolvedTypes.set(
    item.column,
    validateReferencePhysicalType(item.table, item.column, inheritedType) ??
      inheritedType,
  )

  return true
}
