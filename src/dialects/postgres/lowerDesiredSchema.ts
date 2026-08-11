import type {
  AuthoredDesiredColumn,
  AuthoredDesiredSchema,
  AuthoredDesiredTable,
  CreateTableColumnAst,
  LoweredDatabaseDefault,
  LoweredDesiredSchema,
} from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { ColumnGeneration, DatabaseDefault } from '@/schemas'
import { isSqlNullable } from '@/schemas'
import { MigrationError } from '@/utils/error'

import { inferPostgresColumnType } from './infer'
import { normalizePostgresDataType } from './normalize'
import {
  assertSafePostgresDataType,
  formatPostgresLiteral,
  normalizePostgresDefaultExpression,
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
 * Tests canonical relation identity equality.
 *
 * @param left - Left relation identity.
 * @param right - Right relation identity.
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
 * Formats a relation or column identity for diagnostics.
 *
 * @param identity - Canonical relation identity.
 * @param column - Optional column name.
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
 * Reads the schema spelling from a PostgreSQL relation identity.
 *
 * @param identity - Canonical relation identity.
 */
function postgresSchema(identity: CanonicalRelationIdentity): string | undefined {
  return identity.namespace.find((segment) => segment.role === 'schema')?.identifier
    .spelling
}

/**
 * Returns table columns in deterministic name order.
 *
 * @param table - Authored desired table.
 */
function orderedColumns(table: AuthoredDesiredTable): AuthoredDesiredColumn[] {
  return [...table.columns].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
}

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
 * Validates and trims a PostgreSQL dialect expression.
 *
 * @param expression - Authored dialect expression.
 */
function assertSafeExpression(expression: string): string {
  const value = expression.trim()
  let quoted = false
  let parentheses = 0
  let unsafe = !value || /\$|;|--|\/\*|\*\//.test(value)
  for (let index = 0; index < value.length && !unsafe; index++) {
    const character = value[index]
    if (character === "'") {
      if (quoted && value[index + 1] === "'") {
        index++
      } else {
        quoted = !quoted
      }
    } else if (!quoted && character === '(') {
      parentheses++
    } else if (!quoted && character === ')') {
      if (parentheses === 0) unsafe = true
      else parentheses--
    }
  }
  if (quoted || parentheses !== 0) unsafe = true
  if (unsafe) {
    throw new MigrationError({
      message: `Unsafe PostgreSQL database expression ${JSON.stringify(expression)}`,
    })
  }
  return value
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
      sql = assertSafeExpression(value.expression)
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
 */
function physicalType(column: AuthoredDesiredColumn): string {
  const metadata = column.metadata
  const selected =
    metadata?.physicalType?.postgresql ?? inferPostgresColumnType(column.schema)
  return assertSafePostgresDataType(String(selected))
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
): void {
  const selected = column.metadata?.physicalType?.postgresql
  if (selected === undefined) return
  const localType = assertSafePostgresDataType(String(selected))
  if (normalizePostgresDataType(localType) !== normalizePostgresDataType(inheritedType)) {
    throw new MigrationError({
      message: `Reference column ${formatIdentity(table.identity, column.name)} selects PostgreSQL type ${JSON.stringify(localType)} but target type is ${JSON.stringify(inheritedType)}`,
    })
  }
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
      message: `PostgreSQL migration lowering does not support comments on ${formatIdentity(table.identity, column.name)}`,
    })
  }
  if (metadata?.onUpdate !== undefined) {
    throw new MigrationError({
      message: `PostgreSQL migration lowering does not support onUpdate on ${formatIdentity(table.identity, column.name)}`,
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
        message: `column ${formatIdentity(table.identity, column.name)} uses identity generation with type ${JSON.stringify(dataType)}; PostgreSQL identity requires smallint, integer, or bigint`,
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
): CreateTableColumnAst {
  const generated = validatePostgresColumn(table, column, dataType)
  const primaryKey = Array.isArray(table.metadata.primaryKey)
    ? table.metadata.primaryKey
    : [table.metadata.primaryKey]
  const reference = column.reference
  return Object.freeze({
    name: column.name,
    dataType,
    notNull: !isSqlNullable(column.schema),
    unique:
      (column.metadata?.unique ?? false) &&
      !(primaryKey.length === 1 && primaryKey[0] === column.name),
    autoIncrement: false,
    ...(column.metadata?.databaseDefault === undefined
      ? {}
      : { databaseDefault: lowerDefault(column.metadata.databaseDefault) }),
    ...(generated === undefined ? {} : { generated }),
    ...(reference === undefined
      ? {}
      : {
          references: {
            table: reference.targetRelation.relation.spelling,
            column: reference.targetColumn,
            ...(postgresSchema(reference.targetRelation) === undefined
              ? {}
              : { schema: postgresSchema(reference.targetRelation) }),
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

/**
 * Deterministically lowers the desired schema graph in two dependency-aware passes.
 *
 * @example
 *   const lowered = lowerPostgresDesiredSchema(graph)
 *
 * @param graph - Authored desired schema graph.
 */
export function lowerPostgresDesiredSchema(
  graph: AuthoredDesiredSchema,
): LoweredDesiredSchema {
  const resolvedTypes = new Map<AuthoredDesiredColumn, string>()
  for (const table of graph.tables) {
    if (table.columns.length === 0) {
      throw new MigrationError({
        message: `table ${formatIdentity(table.identity)} has no columns`,
      })
    }
    for (const column of orderedColumns(table)) {
      if (!column.reference) resolvedTypes.set(column, physicalType(column))
    }
  }

  let pending = graph.tables.flatMap((table) =>
    orderedColumns(table)
      .filter((column) => column.reference !== undefined)
      .map((column) => ({ table, column })),
  )
  while (pending.length > 0) {
    const unresolved: typeof pending = []
    let progress = false
    for (const item of pending) {
      const reference = item.column.reference!
      const targetTable = graph.tables.find((table) =>
        sameIdentity(table.identity, reference.targetRelation),
      )
      if (!targetTable) {
        throw new MigrationError({
          message: `Reference ${formatIdentity(item.table.identity, item.column.name)} targets unregistered relation ${formatIdentity(reference.targetRelation)}`,
        })
      }
      const targetColumn = targetTable.columns.find(
        (column) => column.name === reference.targetColumn,
      )
      if (!targetColumn) {
        throw new MigrationError({
          message: `Reference ${formatIdentity(item.table.identity, item.column.name)} targets missing column ${formatIdentity(reference.targetRelation, reference.targetColumn)}`,
        })
      }
      const targetType = resolvedTypes.get(targetColumn)
      if (targetType === undefined) {
        unresolved.push(item)
        continue
      }
      validateReferencePhysicalType(item.table, item.column, targetType)
      resolvedTypes.set(item.column, targetType)
      progress = true
    }
    if (!progress) {
      const first = unresolved[0]!
      throw new MigrationError({
        message: `Cannot resolve reference-only physical type cycle at ${formatIdentity(first.table.identity, first.column.name)}`,
      })
    }
    pending = unresolved
  }

  const loweredColumns = new Map<AuthoredDesiredColumn, CreateTableColumnAst>()
  for (const table of graph.tables) {
    for (const column of orderedColumns(table)) {
      loweredColumns.set(column, lowerColumn(table, column, resolvedTypes.get(column)!))
    }
  }

  return Object.freeze({
    tables: Object.freeze(
      graph.tables.map((table) => {
        const primaryKey = Array.isArray(table.metadata.primaryKey)
          ? [...table.metadata.primaryKey]
          : [table.metadata.primaryKey]
        return Object.freeze({
          handle: table.handle,
          identity: table.identity,
          ast: Object.freeze({
            kind: 'create_table' as const,
            table: table.metadata.name,
            ...(postgresSchema(table.identity) === undefined
              ? {}
              : { schema: postgresSchema(table.identity) }),
            // Resolution is sorted for determinism; emitted DDL preserves authored order.
            columns: Object.freeze(
              table.columns.map((column) => loweredColumns.get(column)!),
            ),
            primaryKey: Object.freeze(primaryKey),
          }),
        })
      }),
    ),
  })
}
