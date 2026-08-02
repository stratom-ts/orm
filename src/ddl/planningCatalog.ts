import type {
  CatalogFact,
  CatalogForeignKey,
  CatalogIndex,
  CatalogKeyConstraint,
  CatalogSet,
  CatalogSnapshot,
} from '@/dialects/catalog'
import type { CreateTableAst } from '@/dialects/types'
import type {
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationRegistry,
} from '@/migrations/canonicalRelationIdentity'
import type { ResolvedMigrationOwnership } from '@/migrations/migrationOwnership'
import { MigrationError } from '@/utils/error'

export type PlanningCatalogColumn = {
  name: string
  dataType?: string
  isNullable?: boolean
  defaultExpression?: string | null
  identityGeneration?: 'always' | 'byDefault' | null
}

export type PlanningCatalogKeyConstraint = {
  name: string
  columns: string[]
  semanticCompleteness: 'supportedSimple' | 'unsupported'
  isValid: boolean
}

export type PlanningCatalogForeignKey = PlanningCatalogKeyConstraint & {
  referencedSchema: string
  referencedTable: string
  referencedColumns: string[]
  onDelete: CatalogForeignKey['onDelete']
  onUpdate: CatalogForeignKey['onUpdate']
}

export type PlanningCatalogIndex = {
  name: string
  columns: string[]
  unique: boolean
  semanticCompleteness: 'supportedSimple' | 'unsupported'
  isValid: boolean
}

export type PlanningCatalogTable = {
  name: string
  schema: string
  columns: PlanningCatalogColumn[]
  indexes: PlanningCatalogIndex[]
  primaryKey: PlanningCatalogKeyConstraint | null
  uniqueConstraints: PlanningCatalogKeyConstraint[]
  foreignKeys: PlanningCatalogForeignKey[]
  opaqueObjects: readonly string[]
}

export type PlanningCatalog = {
  tables: PlanningCatalogTable[]
  namespaces: readonly CanonicalRelationIdentity['namespace'][]
  nameReservations: Array<{ schema: string; name: string }>
  constraintNameReservations: Array<{ schema: string; table: string; name: string }>
}

function sameNamespace(
  left: CanonicalRelationIdentity['namespace'],
  right: CanonicalRelationIdentity['namespace'],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index]
      return (
        segment.role === other?.role &&
        segment.identifier.comparisonKey === other.identifier.comparisonKey
      )
    })
  )
}

function evidenceDescription(fact: Exclude<CatalogFact<unknown>, { state: 'present' }>) {
  if (fact.state === 'absent') return 'absent'
  if (fact.state === 'unavailable') return `unavailable (${fact.cause})`
  if (fact.state === 'unsupported') return `unsupported by ${fact.by}`
  return fact.state
}

function requireFact<T>(fact: CatalogFact<T>, target: string): T {
  if (fact.state === 'present') return fact.value
  throw new MigrationError({
    message: `Incomplete catalog evidence for ${target}: ${evidenceDescription(fact)}`,
  })
}

function requireComplete<T>(set: CatalogSet<T>, target: string): readonly T[] {
  if (set.coverage.state === 'complete') return set.items
  const evidence =
    set.coverage.state === 'partial' ? set.coverage.remainder : set.coverage
  throw new MigrationError({
    message: `Incomplete catalog coverage for ${target}: ${evidenceDescription(evidence)}`,
  })
}

function schemaFromIdentity(identity: CanonicalRelationIdentity): string {
  const segment = identity.namespace.find(({ role }) => role === 'schema')
  if (!segment) {
    throw new MigrationError({
      message: 'The current Migration Plan projection requires a schema namespace',
    })
  }
  return segment.identifier.spelling
}

function nameOf(fact: CatalogFact<string>, target: string): string {
  return requireFact(fact, `${target} name`)
}

function simpleSemantics(
  object: CatalogIndex | CatalogKeyConstraint | CatalogForeignKey,
): Pick<PlanningCatalogIndex, 'semanticCompleteness' | 'isValid'> {
  const isValid = object.validity.state === 'present' && object.validity.value === 'valid'
  return object.semantics.state === 'present'
    ? { semanticCompleteness: 'supportedSimple', isValid }
    : { semanticCompleteness: 'unsupported', isValid }
}

function keyConstraint(
  constraint: CatalogKeyConstraint,
  target: string,
): PlanningCatalogKeyConstraint {
  return {
    name: nameOf(constraint.name, target),
    columns: [...constraint.columns],
    ...simpleSemantics(constraint),
  }
}

function desiredColumn(desired: CreateTableAst | undefined, name: string) {
  return desired?.columns.find((column) => column.name === name)
}

/**
 * Validates evidence once and projects adapter-neutral catalog facts into the current
 * Migration Plan implementation. No legacy snapshot shape crosses this seam.
 */
export function catalogForPlanning(
  snapshot: CatalogSnapshot,
  identities: CanonicalRelationIdentityModule,
  desiredTables: CanonicalRelationRegistry<CreateTableAst>,
  desiredRelations: readonly CanonicalRelationIdentity[],
  ownership: ResolvedMigrationOwnership,
): PlanningCatalog {
  const requestCovers = (identity: CanonicalRelationIdentity) =>
    snapshot.request.relations.some(({ identity: requested }) =>
      identities.equals(requested, identity),
    ) ||
    snapshot.request.absentRelations.some((requested) =>
      identities.equals(requested, identity),
    ) ||
    snapshot.request.completeNamespaces.some((namespace) =>
      sameNamespace(namespace, identity.namespace),
    )

  for (const identity of [...desiredRelations, ...ownership.absentRelations]) {
    if (!requestCovers(identity)) {
      throw new MigrationError({
        message: `Catalog snapshot does not cover requested migration target ${identities.format(identity)}`,
      })
    }
  }
  for (const namespace of ownership.completeNamespaces) {
    if (
      !snapshot.request.completeNamespaces.some((requested) =>
        sameNamespace(requested, namespace),
      )
    ) {
      throw new MigrationError({
        message: 'Catalog snapshot does not cover a complete migration namespace',
      })
    }
  }

  const namespaces = requireComplete(snapshot.namespaces, 'requested namespaces')
  const tables: PlanningCatalogTable[] = []

  for (const namespace of namespaces) {
    const relations = requireComplete(
      namespace.relations,
      `relations in namespace ${JSON.stringify(
        namespace.identity.map(({ role, identifier }) => ({
          role,
          spelling: identifier.spelling,
        })),
      )}`,
    )
    for (const relation of relations) {
      const target = identities.format(relation.identity)
      if (relation.management === 'unmanaged') {
        if (desiredTables.has(relation.identity)) {
          throw new MigrationError({
            message: `Desired table ${target} collides with an unmanaged catalog relation`,
          })
        }
        continue
      }
      if (relation.kind !== 'table' && relation.kind !== 'partitionedTable') {
        throw new MigrationError({
          message: `Managed catalog target ${target} is a ${relation.kind}, not a table`,
        })
      }
      const table = requireFact(relation.table, `${target} table definition`)
      const columns = requireComplete(table.columns, `${target} columns`)
      const uniqueConstraints = requireComplete(
        table.uniqueConstraints,
        `${target} unique constraints`,
      )
      const foreignKeys = requireComplete(table.foreignKeys, `${target} foreign keys`)
      const indexes = requireComplete(table.indexes, `${target} indexes`)
      requireComplete(table.options, `${target} table options`)
      const opaqueObjects = requireComplete(
        table.opaqueObjects,
        `${target} opaque objects`,
      )
      const desired = desiredTables.get(relation.identity)

      const projectedColumns: PlanningCatalogColumn[] = columns.map((column) => {
        const expected = desiredColumn(desired, column.name)
        if (!expected) return { name: column.name }
        const dataType = requireFact(
          column.dataType,
          `${identities.format(relation.identity, { role: 'column', spelling: column.name })} type`,
        )
        const nullable = requireFact(
          column.nullable,
          `${identities.format(relation.identity, { role: 'column', spelling: column.name })} nullability`,
        )
        const defaultExpression =
          column.default.state === 'absent'
            ? null
            : requireFact(
                requireFact(column.default, `${target} column ${column.name} default`)
                  .comparisonKey,
                `${target} column ${column.name} default comparison key`,
              )
        const generation =
          column.generation.state === 'absent'
            ? null
            : requireFact(column.generation, `${target} column ${column.name} generation`)
        if (generation && generation.kind !== 'identity') {
          throw new MigrationError({
            message: `Unsupported catalog generation for ${target} column ${JSON.stringify(column.name)}`,
          })
        }
        return {
          name: column.name,
          dataType: dataType.comparisonKey,
          isNullable: nullable,
          defaultExpression,
          identityGeneration: generation?.mode ?? null,
        }
      })

      const primaryKey =
        table.primaryKey.state === 'absent'
          ? null
          : keyConstraint(requireFact(table.primaryKey, `${target} primary key`), target)

      tables.push({
        name: relation.identity.relation.spelling,
        schema: schemaFromIdentity(relation.identity),
        columns: projectedColumns,
        indexes: indexes.map((index) => ({
          name: nameOf(index.name, `${target} index`),
          columns: [...index.columns],
          unique: index.unique,
          ...simpleSemantics(index),
        })),
        primaryKey,
        uniqueConstraints: uniqueConstraints.map((constraint) =>
          keyConstraint(constraint, `${target} unique constraint`),
        ),
        foreignKeys: foreignKeys.map((foreignKey) => ({
          ...keyConstraint(foreignKey, `${target} foreign key`),
          referencedSchema: schemaFromIdentity(foreignKey.referencedRelation),
          referencedTable: foreignKey.referencedRelation.relation.spelling,
          referencedColumns: [...foreignKey.referencedColumns],
          onDelete: foreignKey.onDelete,
          onUpdate: foreignKey.onUpdate,
        })),
        opaqueObjects: opaqueObjects.map((object) => object.reason),
      })
    }
  }

  const reservations = requireComplete(snapshot.nameReservations, 'physical names')
  const constraintReservations = requireComplete(
    snapshot.constraintNameReservations,
    'constraint names',
  )

  return {
    tables,
    namespaces: namespaces.map((namespace) => namespace.identity),
    nameReservations: reservations.map((reservation) => ({
      schema: schemaFromIdentity({
        namespace: reservation.namespace,
        relation: { spelling: reservation.name, comparisonKey: reservation.name },
      }),
      name: reservation.name,
    })),
    constraintNameReservations: constraintReservations.map((reservation) => ({
      schema: schemaFromIdentity(reservation.relation),
      table: reservation.relation.relation.spelling,
      name: reservation.name,
    })),
  }
}
