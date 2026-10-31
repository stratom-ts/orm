import type {
  AuthoredDesiredColumn,
  AuthoredDesiredSchema,
  AuthoredDesiredTable,
  LoweredDesiredSchema,
  StorageDesiredSchema,
} from '@/dialects/types'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationRegistry,
} from '@/migrations/canonicalRelationIdentity'
import type { ReferenceMetadata } from '@/schemas'
import { getColumnMetadata, getReferenceMetadata } from '@/schemas'
import { extractStorageFacts } from '@/schemas/valibot/storageFacts'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'
import { MigrationError, isErrorTag } from '@/utils/error'

/**
 * Checks whether a column is a single-column primary or unique key.
 *
 * @param table - Authored table containing the candidate column.
 * @param column - Column name to check.
 */
function isCandidateKey(table: AuthoredDesiredTable, column: string): boolean {
  const columnKey = table.columns.find(
    (candidate) => candidate.identifier.spelling === column,
  )?.identifier.comparisonKey

  if (columnKey === undefined) return false

  const primaryKey = Array.isArray(table.metadata.primaryKey)
    ? table.metadata.primaryKey
    : [table.metadata.primaryKey]

  if (
    primaryKey.length === 1 &&
    table.columns.find((candidate) => candidate.name === primaryKey[0])?.identifier
      .comparisonKey === columnKey
  )
    return true

  const authoredColumn = table.columns.find(
    (candidate) => candidate.identifier.comparisonKey === columnKey,
  )

  if (authoredColumn?.metadata?.unique) return true

  return (table.metadata.indexes ?? []).some((index) => {
    return (
      index.unique === true &&
      index.columns.length === 1 &&
      table.columns.find((candidate) => candidate.name === index.columns[0])?.identifier
        .comparisonKey === columnKey
    )
  })
}

/**
 * Rejects authored columns that share a canonical comparison key.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 * @param identities - Canonical identity operations for the resolved namespace context.
 */
function assertUniqueColumnNames(
  table: AuthoredDesiredTable,
  identities: CanonicalRelationIdentityModule,
): void {
  const ordered = [...table.columns].sort(
    (left, right) =>
      (left.identifier.comparisonKey < right.identifier.comparisonKey
        ? -1
        : left.identifier.comparisonKey > right.identifier.comparisonKey
          ? 1
          : 0) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
  )

  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!
    const current = ordered[index]!

    if (previous.identifier.comparisonKey !== current.identifier.comparisonKey) continue

    throw new MigrationError({
      message: `Duplicate desired columns ${identities.format(table.identity, {
        role: 'column',
        spelling: previous.name,
      })} and ${identities.format(table.identity, {
        role: 'column',
        spelling: current.name,
      })}`,
    })
  }
}

/**
 * Resolves every authored relation/reference against canonical identity before an
 * adapter sees the graph. Cycles are retained; dangling and non-key targets fail here.
 *
 * @example
 *   const desired = registerDesiredSchema([Users], identities)
 *
 * @param handles - Desired table handles to register.
 * @param identities - Identity module used to resolve and validate relations.
 */
export function registerDesiredSchema(
  handles: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
  forRelation: (
    identity: CanonicalRelationIdentity,
  ) => CanonicalRelationIdentityModule = () => identities,
): AuthoredDesiredSchema {
  const registry = identities.createRegistry<AuthoredDesiredTable>()
  const tables: AuthoredDesiredTable[] = handles.map((handle) =>
    registerDesiredTable(
      handle,
      forRelation(identities.resolve(handle.getTableMetadata().relation)),
    ),
  )

  tables.sort((left, right) => identities.compare(left.identity, right.identity))

  validateRegisteredTables(tables, identities, registry)

  const referencedColumns = tables.flatMap((table) =>
    [...table.columns]
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      )
      .map((column) => ({ table, column })),
  )

  for (const { table, column } of referencedColumns) {
    if (column.reference)
      assertDesiredReference(
        table,
        column,
        registry.get(column.reference.targetRelation),
        identities,
      )
  }

  return Object.freeze({
    tables: Object.freeze(
      tables.map((table) =>
        Object.freeze({ ...table, columns: Object.freeze([...table.columns]) }),
      ),
    ),
  })
}

/**
 * Checks candidate keys and reference targets across the registered schema graph.
 *
 * @param tables - Observed table definitions used to build fixture catalog evidence.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param registry - Identity registry used to resolve registered table handles.
 */
function validateRegisteredTables(
  tables: AuthoredDesiredTable[],
  identities: CanonicalRelationIdentityModule,
  registry: CanonicalRelationRegistry<AuthoredDesiredTable>,
) {
  for (const table of tables) {
    if (table.columns.length === 0) {
      throw new MigrationError({
        message: `table ${identities.format(table.identity)} has no columns`,
      })
    }

    assertUniqueColumnNames(table, identities)
  }

  for (const table of tables) {
    if (registry.has(table.identity)) {
      throw new MigrationError({
        message: `Duplicate registered table ${identities.format(table.identity)}`,
      })
    }

    registry.set(table.identity, table)
  }
}

/**
 * Lowers the validated desired schema through the selected dialect.
 *
 * @example
 *   const lowered = lowerDesiredSchema([Users], identities, dialect)
 *
 * @param handles - Desired table handles to lower.
 * @param identities - Identity module used to resolve and validate relations.
 * @param lowerer - Selected dialect's desired-schema lowering operations.
 *
 * @returns Desired tables with dialect-specific physical storage and resolved references.
 */
export function lowerDesiredSchema(
  handles: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
  lowerer: AuthoredDesiredSchemaLowerer,
  forRelation?: (identity: CanonicalRelationIdentity) => CanonicalRelationIdentityModule,
): LoweredDesiredSchema {
  try {
    const graph = registerDesiredSchema(handles, identities, forRelation)
    const lowered = lowerer.lowerDesiredSchema(graph)
    const registry = identities.createRegistry<TableHandle>()
    for (const handle of handles)
      registry.set(identities.resolve(handle.getTableMetadata().relation), handle)
    return Object.freeze({
      tables: Object.freeze(
        lowered.tables.map((table) =>
          Object.freeze({ ...table, handle: registry.get(table.identity)! }),
        ),
      ),
    })
  } catch (cause) {
    if (isErrorTag(cause, 'MigrationError')) throw cause
    if (!isErrorTag(cause, 'SchemaError')) throw cause

    throw new MigrationError({
      message: `Desired schema lowering failed: ${cause.message}`,
      cause,
    })
  }
}

/** Dialect-bound whole-graph lowering used by generic desired-schema registration. */
type AuthoredDesiredSchemaLowerer = Readonly<{
  /**
   * Resolves authored column storage into the selected dialect's desired-schema
   * representation.
   *
   * @param graph - Registered authored tables and their resolved reference graph.
   *
   * @returns Desired tables with dialect-specific physical storage and resolved
   *   references.
   */
  lowerDesiredSchema(graph: AuthoredDesiredSchema): StorageDesiredSchema
}>

/**
 * Resolves a handle's columns and references into canonical authored metadata.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns One canonical registration containing metadata and logical storage facts.
 */
function registerDesiredTable(
  handle: TableHandle,
  identities: CanonicalRelationIdentityModule,
): AuthoredDesiredTable {
  const metadata = handle.getTableMetadata()
  const identity = identities.resolve(metadata.relation)
  const columns: AuthoredDesiredColumn[] = []

  for (const [name, value] of Object.entries(handle.getSchema().entries)) {
    const schema = value as AnySchema

    const reference = getReferenceMetadata(schema)
    const columnMetadata = getColumnMetadata(schema)
    const identifier = identities.member('column', name)
    columns.push({
      name,
      identifier,
      facts: extractStorageFacts(schema),
      ...(columnMetadata === undefined ? {} : { metadata: columnMetadata }),
      ...(reference === undefined
        ? {}
        : {
            reference: {
              metadata: reference,
              targetRelation: identities.resolve(reference.target.relation),
              targetColumn: identities.member('column', reference.target.column),
            },
          }),
    })
  }

  return { identity, metadata, columns }
}

/**
 * Validates a foreign key's target column and supported referential actions.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 * @param column - Authored or observed column metadata used for storage comparison.
 * @param target - Identity or evidence required by the current reference or diagnostic.
 * @param identities - Canonical identity operations for the resolved namespace context.
 */
function assertDesiredReference(
  table: AuthoredDesiredTable,
  column: AuthoredDesiredColumn,
  target: AuthoredDesiredTable | undefined,
  identities: CanonicalRelationIdentityModule,
): void {
  const reference = column.reference

  if (!reference) return

  const referenceIdentity = reference.targetRelation
  const sourceName = identities.format(table.identity, {
    role: 'column',
    spelling: column.name,
  })

  if (!target) {
    throw new MigrationError({
      message: `Reference ${sourceName} targets unregistered relation ${identities.format(referenceIdentity)}`,
    })
  }

  assertReferencedColumn(target, reference, sourceName, identities, referenceIdentity)
}

/**
 * Rejects missing target columns and references to unsupported candidate keys.
 *
 * @param target - Identity or evidence required by the current reference or diagnostic.
 * @param reference - Foreign-key target and referential actions.
 * @param sourceName - Source field or module name used in the diagnostic.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param referenceIdentity - Resolved canonical identity of the foreign-key target.
 */
function assertReferencedColumn(
  target: AuthoredDesiredTable,
  reference: Readonly<{
    metadata: ReferenceMetadata
    targetRelation: CanonicalRelationIdentity
    targetColumn: CanonicalIdentifier
  }>,
  sourceName: string,
  identities: CanonicalRelationIdentityModule,
  referenceIdentity: CanonicalRelationIdentity,
) {
  if (
    !target.columns.some(
      (candidate) =>
        candidate.identifier.comparisonKey === reference.targetColumn.comparisonKey,
    )
  ) {
    throw new MigrationError({
      message: `Reference ${sourceName} targets missing column ${identities.format(
        referenceIdentity,
        {
          role: 'column',
          spelling: reference.targetColumn.spelling,
        },
      )}`,
    })
  }

  const targetSpelling = target.columns.find(
    (candidate) =>
      candidate.identifier.comparisonKey === reference.targetColumn.comparisonKey,
  )!.name

  if (!isCandidateKey(target, targetSpelling)) {
    throw new MigrationError({
      message: `Reference ${sourceName} must target a single-column primary or unique key; ${identities.format(
        referenceIdentity,
        {
          role: 'column',
          spelling: reference.targetColumn.spelling,
        },
      )} is not a candidate key`,
    })
  }
}
