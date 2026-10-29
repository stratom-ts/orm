import type {
  AuthoredDesiredColumn,
  AuthoredDesiredSchema,
  AuthoredDesiredTable,
  LoweredDesiredColumn,
  StorageDesiredSchema,
} from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import { MigrationError } from '@/utils/error'

/** Dialect decisions consumed by the shared desired-schema graph lowerer. */
type DesiredSchemaLoweringHooks<Context> = Readonly<{
  validateIdentity?(identity: CanonicalRelationIdentity): void
  lowerPhysicalType(column: AuthoredDesiredColumn, context: Context): string
  lowerReferenceType(
    table: AuthoredDesiredTable,
    column: AuthoredDesiredColumn,
    inheritedType: string,
  ): string
  lowerColumn(
    table: AuthoredDesiredTable,
    column: AuthoredDesiredColumn,
    dataType: string,
    context: Context,
  ): LoweredDesiredColumn
}>

/** Compares canonical relation identities without serializing their structured parts. */
function desiredSchemaIdentitiesEqual(
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

/** Formats a structured relation and optional column spelling for diagnostics. */
export function formatDesiredSchemaIdentity(
  identity: CanonicalRelationIdentity,
  column?: string,
): string {
  const parts = identity.namespace.map(
    (segment) => `${segment.role}:${JSON.stringify(segment.identifier.spelling)}`,
  )

  parts.push(`relation:${JSON.stringify(identity.relation.spelling)}`)

  if (column !== undefined) parts.push(`column:${JSON.stringify(column)}`)

  return `[${parts.join(', ')}]`
}

/** Returns columns in canonical identifier order with authored spelling as tie-breaker. */
function orderedColumns(table: AuthoredDesiredTable): AuthoredDesiredColumn[] {
  return [...table.columns].sort(
    (left, right) =>
      (left.identifier.comparisonKey < right.identifier.comparisonKey
        ? -1
        : left.identifier.comparisonKey > right.identifier.comparisonKey
          ? 1
          : 0) ||
      (left.identifier.spelling < right.identifier.spelling
        ? -1
        : left.identifier.spelling > right.identifier.spelling
          ? 1
          : 0),
  )
}

/** Lowers one complete desired-schema graph through narrow dialect-owned decisions. */
export function lowerDesiredSchemaGraph<Context>(
  graph: AuthoredDesiredSchema,
  context: Context,
  hooks: DesiredSchemaLoweringHooks<Context>,
): StorageDesiredSchema {
  const resolvedTypes = new Map<AuthoredDesiredColumn, string>()

  for (const table of graph.tables) {
    registerTable(table, resolvedTypes, context, hooks)
  }

  resolveReferenceTypes(graph, resolvedTypes, hooks)

  const loweredColumns = new Map<AuthoredDesiredColumn, LoweredDesiredColumn>()
  for (const table of graph.tables) {
    for (const column of orderedColumns(table)) {
      loweredColumns.set(
        column,
        Object.freeze(
          hooks.lowerColumn(table, column, resolvedTypes.get(column)!, context),
        ),
      )
    }
  }

  return freezeLoweredSchema(graph, loweredColumns)
}

/** Validates one table and registers independent physical types. */
function registerTable<Context>(
  table: AuthoredDesiredTable,
  resolvedTypes: Map<AuthoredDesiredColumn, string>,
  context: Context,
  hooks: DesiredSchemaLoweringHooks<Context>,
): void {
  hooks.validateIdentity?.(table.identity)

  if (table.columns.length === 0) {
    throw new MigrationError({
      message: `table ${formatDesiredSchemaIdentity(table.identity)} has no columns`,
    })
  }

  for (const column of orderedColumns(table)) {
    if (column.reference === undefined) {
      resolvedTypes.set(column, hooks.lowerPhysicalType(column, context))
    }
  }
}

type PendingReference = Readonly<{
  table: AuthoredDesiredTable
  column: AuthoredDesiredColumn
}>

/** Resolves reference types in dependency order and rejects cycles without progress. */
function resolveReferenceTypes<Context>(
  graph: AuthoredDesiredSchema,
  resolvedTypes: Map<AuthoredDesiredColumn, string>,
  hooks: DesiredSchemaLoweringHooks<Context>,
): void {
  let pending = graph.tables.flatMap((table) =>
    orderedColumns(table)
      .filter((column) => column.reference !== undefined)
      .map((column) => ({ table, column })),
  )

  while (pending.length > 0) {
    const unresolved: PendingReference[] = []
    let progress = false

    for (const item of pending) {
      progress =
        resolvePendingReference(item, unresolved, graph, resolvedTypes, hooks) || progress
    }

    if (!progress) {
      const first = unresolved[0]!
      throw new MigrationError({
        message: `Cannot resolve reference-only physical type cycle at ${formatDesiredSchemaIdentity(first.table.identity, first.column.name)}`,
      })
    }

    pending = unresolved
  }
}

/** Resolves one reference type or defers it until its target type is available. */
function resolvePendingReference<Context>(
  item: PendingReference,
  unresolved: PendingReference[],
  graph: AuthoredDesiredSchema,
  resolvedTypes: Map<AuthoredDesiredColumn, string>,
  hooks: DesiredSchemaLoweringHooks<Context>,
): boolean {
  const reference = item.column.reference!
  hooks.validateIdentity?.(reference.targetRelation)
  const targetTable = graph.tables.find((table) =>
    desiredSchemaIdentitiesEqual(table.identity, reference.targetRelation),
  )

  if (targetTable === undefined) {
    throw new MigrationError({
      message: `Reference ${formatDesiredSchemaIdentity(item.table.identity, item.column.name)} targets unregistered relation ${formatDesiredSchemaIdentity(reference.targetRelation)}`,
    })
  }

  const targetColumn = targetTable.columns.find(
    (column) => column.identifier.comparisonKey === reference.targetColumn.comparisonKey,
  )

  if (targetColumn === undefined) {
    throw new MigrationError({
      message: `Reference ${formatDesiredSchemaIdentity(item.table.identity, item.column.name)} targets missing column ${formatDesiredSchemaIdentity(reference.targetRelation, reference.targetColumn.spelling)}`,
    })
  }

  const inheritedType = resolvedTypes.get(targetColumn)

  if (inheritedType === undefined) {
    unresolved.push(item)
    return false
  }

  resolvedTypes.set(
    item.column,
    hooks.lowerReferenceType(item.table, item.column, inheritedType),
  )

  return true
}

/** Builds and freezes the common lowered-schema result shape. */
function freezeLoweredSchema(
  graph: AuthoredDesiredSchema,
  loweredColumns: ReadonlyMap<AuthoredDesiredColumn, LoweredDesiredColumn>,
): StorageDesiredSchema {
  return Object.freeze({
    tables: Object.freeze(
      graph.tables.map((table) => {
        const primaryKey = Array.isArray(table.metadata.primaryKey)
          ? table.metadata.primaryKey
          : [table.metadata.primaryKey]

        return Object.freeze({
          identity: table.identity,
          columns: Object.freeze(
            table.columns.map((column) => loweredColumns.get(column)!),
          ),
          primaryKey: Object.freeze(
            primaryKey.map((name) => {
              const column = table.columns.find((candidate) => candidate.name === name)

              if (column === undefined) {
                throw new MigrationError({
                  message: `Primary key ${formatDesiredSchemaIdentity(table.identity, name)} does not name a desired column`,
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
