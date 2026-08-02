import type {
  AuthoredDesiredColumn,
  AuthoredDesiredSchema,
  AuthoredDesiredTable,
  Dialect,
  LoweredDesiredSchema,
} from '@/dialects/types'
import type { CanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import {
  getColumnMetadata,
  getReferenceMetadata,
  normalizeColumnMetadata,
  normalizeIndex,
} from '@/schemas'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'
import { MigrationError } from '@/utils/error'

function relationInput(schema: string | undefined, relation: string) {
  return {
    ...(schema === undefined
      ? {}
      : { namespace: [{ role: 'schema' as const, spelling: schema }] }),
    relation,
  }
}

function isCandidateKey(table: AuthoredDesiredTable, column: string): boolean {
  const primaryKey = Array.isArray(table.metadata.primaryKey)
    ? table.metadata.primaryKey
    : [table.metadata.primaryKey]
  if (primaryKey.length === 1 && primaryKey[0] === column) return true
  const authoredColumn = table.columns.find((candidate) => candidate.name === column)
  if (authoredColumn?.metadata?.unique) return true
  return (table.metadata.indexes ?? []).some((raw) => {
    const index = normalizeIndex(raw)
    return (
      index.unique === true && index.columns.length === 1 && index.columns[0] === column
    )
  })
}

/**
 * Resolves every authored relation/reference against canonical identity before an
 * adapter sees the graph. Cycles are retained; dangling and non-key targets fail here.
 */
export function registerDesiredSchema(
  handles: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
): AuthoredDesiredSchema {
  const registry = identities.createRegistry<AuthoredDesiredTable>()
  const tables: AuthoredDesiredTable[] = handles.map((handle) => {
    const metadata = handle.getTableMetadata()
    const identity = identities.resolve(relationInput(metadata.schema, metadata.name))
    const columns: AuthoredDesiredColumn[] = []
    for (const [name, value] of Object.entries(handle.getSchema().entries)) {
      const schema = value as AnySchema
      if (!schema || schema.kind !== 'schema') continue
      const reference = getReferenceMetadata(schema)
      const columnMetadata = getColumnMetadata(schema)
      const normalizedMetadata = columnMetadata
        ? normalizeColumnMetadata(columnMetadata)
        : undefined
      columns.push({
        name,
        schema,
        ...(normalizedMetadata === undefined ? {} : { metadata: normalizedMetadata }),
        ...(reference === undefined
          ? {}
          : {
              reference: {
                metadata: reference,
                targetRelation: identities.resolve(reference.target.relation),
                targetColumn: reference.target.column,
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
    for (const column of [...table.columns].sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    )) {
      const reference = column.reference
      if (!reference) continue
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
        !target.columns.some((candidate) => candidate.name === reference.targetColumn)
      ) {
        throw new MigrationError({
          message: `Reference ${sourceName} targets missing column ${identities.format(
            referenceIdentity,
            {
              role: 'column',
              spelling: reference.targetColumn,
            },
          )}`,
        })
      }
      if (!isCandidateKey(target, reference.targetColumn)) {
        throw new MigrationError({
          message: `Reference ${sourceName} must target a single-column primary or unique key; ${identities.format(
            referenceIdentity,
            {
              role: 'column',
              spelling: reference.targetColumn,
            },
          )} is not a candidate key`,
        })
      }
    }
  }

  return Object.freeze({
    tables: Object.freeze(
      tables.map((table) =>
        Object.freeze({ ...table, columns: Object.freeze([...table.columns]) }),
      ),
    ),
  })
}

/** Selected-dialect whole-graph lowering seam used by planning and execution. */
export function lowerDesiredSchema(
  handles: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
  dialect: Dialect,
): LoweredDesiredSchema {
  try {
    const graph = registerDesiredSchema(handles, identities)
    return dialect.lowerDesiredSchema(graph)
  } catch (cause) {
    if (cause instanceof MigrationError) throw cause
    throw new MigrationError({
      message: cause instanceof Error ? cause.message : 'Desired schema lowering failed',
      ...(cause === undefined ? {} : { cause }),
    })
  }
}
