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
import { getColumnMetadata } from '@/schemas'
import { createReferenceResolver } from '@/schemas/actions/lazyReference'
import { physicalColumnName } from '@/schemas/physicalColumn'
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
  const columnKey = table.columns.find((candidate) => candidate.name === column)
    ?.identifier.comparisonKey

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
  const resolveReference = createReferenceResolver((source, selected, reference) =>
    validateLazyReference(handles, identities, source, selected, reference),
  )

  const orderedHandles = [...handles].sort((left, right) =>
    identities.compare(
      identities.resolve(left.getTableMetadata().relation),
      identities.resolve(right.getTableMetadata().relation),
    ),
  )

  const tables: AuthoredDesiredTable[] = orderedHandles.map((handle) =>
    registerDesiredTable(
      handle,
      handles,
      resolveReference,
      forRelation(identities.resolve(handle.getTableMetadata().relation)),
    ),
  )

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

/** Rejects deferred targets that disagree with registered columns or local storage. */
function validateLazyReference(
  handles: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
  source: AnySchema,
  selected: AnySchema,
  reference: ReferenceMetadata,
): void {
  const relation = identities.resolve(reference.target.relation)
  const matches = handles.filter((handle) =>
    identities.equals(identities.resolve(handle.getTableMetadata().relation), relation),
  )

  if (matches.length !== 1)
    throw new MigrationError({
      message:
        matches.length === 0
          ? `Lazy reference targets unregistered relation ${identities.format(relation)}`
          : `Lazy reference targets ambiguous relation ${identities.format(relation)}`,
    })

  const registered = matches[0]!.getSchema().entries[reference.target.column]

  if (registered !== selected)
    throw new MigrationError({
      message: 'Lazy reference target column differs from the registered declaration',
    })

  const sourceFacts = extractStorageFacts(source)
  const targetFacts = extractStorageFacts(selected)

  if (
    sourceFacts.outputKind === undefined ||
    sourceFacts.outputKind !== targetFacts.outputKind
  )
    throw new MigrationError({
      message: 'Lazy reference has incompatible local and target column types',
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
  handles: readonly TableHandle[],
  resolveReference: ReturnType<typeof createReferenceResolver>,
  identities: CanonicalRelationIdentityModule,
): AuthoredDesiredTable {
  const metadata = handle.getTableMetadata()
  const identity = identities.resolve(metadata.relation)
  const columns: AuthoredDesiredColumn[] = []

  const entries = Object.entries(handle.getSchema().entries)
  const references = new Map(
    [...entries]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([name, value]) => [name, resolveReference(value as AnySchema)]),
  )

  for (const [name, value] of entries) {
    const schema = value as AnySchema
    const reference = references.get(name)
    const columnMetadata = getColumnMetadata(schema)
    const identifier = identities.member('column', physicalColumnName(handle, name))
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
              targetColumn: resolveReferenceIdentifier(reference, handles, identities),
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

/** Resolves reference properties exactly, then takes the target storage identifier. */
function resolveReferenceIdentifier(
  reference: ReferenceMetadata,
  handles: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
): CanonicalIdentifier {
  const relation = identities.resolve(reference.target.relation)
  const target = handles.find((handle) =>
    identities.equals(identities.resolve(handle.getTableMetadata().relation), relation),
  )

  if (!target)
    throw new MigrationError({
      message: `Reference targets unregistered relation ${identities.format(relation)}`,
    })

  if (!Object.hasOwn(target.getSchema().entries, reference.target.column))
    throw new MigrationError({
      message: `Reference targets missing application column ${JSON.stringify(reference.target.column)}`,
    })

  return identities.member('column', physicalColumnName(target, reference.target.column))
}
