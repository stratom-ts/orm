import type {
  AuthoredDesiredColumn,
  AuthoredDesiredSchema,
  AuthoredDesiredTable,
  LoweredDesiredSchema,
} from '@/dialects/types'
import type { CanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { getColumnMetadata, getReferenceMetadata } from '@/schemas'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'
import { MigrationError } from '@/utils/error'

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
): AuthoredDesiredSchema {
  const registry = identities.createRegistry<AuthoredDesiredTable>()
  const tables: AuthoredDesiredTable[] = handles.map((handle) => {
    const metadata = handle.getTableMetadata()
    const identity = identities.resolve(metadata.relation)
    const columns: AuthoredDesiredColumn[] = []

    for (const [name, value] of Object.entries(handle.getSchema().entries)) {
      const schema = value as AnySchema

      if (!schema || schema.kind !== 'schema') continue

      const reference = getReferenceMetadata(schema)
      const columnMetadata = getColumnMetadata(schema)
      const identifier = identities.member('column', name)
      columns.push({
        name,
        identifier,
        schema,
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

    return { handle, identity, metadata, columns }
  })

  tables.sort((left, right) => identities.compare(left.identity, right.identity))

  for (const table of tables) {
    if (table.columns.length === 0) {
      throw new MigrationError({
        message: `table ${identities.format(table.identity)} has no columns`,
      })
    }

    const ordered = [...table.columns].sort(
      (left, right) =>
        (left.identifier.comparisonKey < right.identifier.comparisonKey
          ? -1
          : left.identifier.comparisonKey > right.identifier.comparisonKey
            ? 1
            : 0) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    )

    ordered.slice(1).forEach((current, offset) => {
      const index = offset + 1
      const previous = ordered[index - 1]!

      if (previous.identifier.comparisonKey !== current.identifier.comparisonKey) return

      throw new MigrationError({
        message: `Duplicate desired columns ${identities.format(table.identity, {
          role: 'column',
          spelling: previous.name,
        })} and ${identities.format(table.identity, {
          role: 'column',
          spelling: current.name,
        })}`,
      })
    })
  }

  for (const table of tables) {
    if (registry.has(table.identity)) {
      throw new MigrationError({
        message: `Duplicate registered table ${identities.format(table.identity)}`,
      })
    }

    registry.set(table.identity, table)
  }

  for (const table of tables) {
    const columns = [...table.columns].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )

    columns.forEach((column) => {
      const reference = column.reference

      if (!reference) return

      const referenceIdentity = reference.targetRelation
      const target = registry.get(referenceIdentity)
      const sourceName = identities.format(table.identity, {
        role: 'column',
        spelling: column.name,
      })

      if (!target) {
        throw new MigrationError({
          message: `Reference ${sourceName} targets unregistered relation ${identities.format(referenceIdentity)}`,
        })
      }

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
    })
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
 * Lowers the validated desired schema through the selected dialect.
 *
 * @example
 *   const lowered = lowerDesiredSchema([Users], identities, dialect)
 *
 * @param handles - Desired table handles to lower.
 * @param identities - Identity module used to resolve and validate relations.
 * @param dialect - Dialect that lowers the authored graph.
 */
export function lowerDesiredSchema(
  handles: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
  lowerer: AuthoredDesiredSchemaLowerer,
): LoweredDesiredSchema {
  try {
    const graph = registerDesiredSchema(handles, identities)
    return lowerer.lowerDesiredSchema(graph)
  } catch (cause) {
    if (cause instanceof MigrationError) throw cause

    throw new MigrationError({
      message: cause instanceof Error ? cause.message : 'Desired schema lowering failed',
      ...(cause === undefined ? {} : { cause }),
    })
  }
}

/** Dialect-bound whole-graph lowering used by generic desired-schema registration. */
type AuthoredDesiredSchemaLowerer = Readonly<{
  lowerDesiredSchema(graph: AuthoredDesiredSchema): LoweredDesiredSchema
}>
