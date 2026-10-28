import type {
  CatalogFact,
  CatalogForeignKey,
  CatalogIndex,
  CatalogKeyConstraint,
  CatalogRelation,
  CatalogSet,
  CatalogSnapshot,
  OpaqueCatalogObject,
} from '@/dialects/catalog'
import type { LoweredDesiredTable } from '@/dialects/types'
import type {
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationRegistry,
} from '@/migrations/canonicalRelationIdentity'
import type { ResolvedMigrationOwnership } from '@/migrations/migrationOwnership'
import { MigrationError, isErrorTag } from '@/utils/error'

export type PlanningCatalogColumn = {
  name: string
  dataType?: string
  isNullable?: boolean
  defaultExpression?: string | null
  identityGeneration?: 'always' | 'byDefault' | null
}

export type PlanningCatalogKeyConstraint = {
  name?: string
  columns: string[]
  semanticCompleteness: 'supportedSimple' | 'unsupported'
  isValid: boolean
}

export type PlanningCatalogForeignKey = PlanningCatalogKeyConstraint & {
  referencedRelation: CanonicalRelationIdentity
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
  identity: CanonicalRelationIdentity
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
  nameReservations: {
    namespace: readonly CanonicalNamespaceSegment[]
    name: string
  }[]
  constraintNameReservations: {
    relation: CanonicalRelationIdentity
    name: string
  }[]
}

/**
 * Tests canonical namespaces for positional role and comparison-key equality.
 *
 * @param left - First canonical namespace.
 * @param right - Second canonical namespace.
 */
function sameNamespace(
  left: CanonicalRelationIdentity['namespace'],
  right: CanonicalRelationIdentity['namespace'],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right.at(index)!
      return (
        segment.role === other.role &&
        segment.identifier.comparisonKey === other.identifier.comparisonKey
      )
    })
  )
}

/**
 * Describes why a catalog fact is not present.
 *
 * @param fact - Non-present catalog fact to describe.
 */
function evidenceDescription(fact: Exclude<CatalogFact<unknown>, { state: 'present' }>) {
  if (fact.state === 'absent') return 'absent'
  if (fact.state === 'unavailable') return `unavailable (${fact.cause})`
  if (fact.state === 'unsupported') return `unsupported by ${fact.by}`

  return fact.state
}

/**
 * Extracts a present catalog fact or reports incomplete evidence.
 *
 * @param fact - Catalog fact to require.
 * @param target - Diagnostic description of the required target.
 */
function requireFact<T>(fact: CatalogFact<T>, target: string): T {
  if (fact.state === 'present') return fact.value

  throw new MigrationError({
    message: `Incomplete catalog evidence for ${target}: ${evidenceDescription(fact)}`,
  })
}

/**
 * Extracts a completely covered catalog set or reports incomplete coverage.
 *
 * @param set - Catalog set whose coverage must be complete.
 * @param target - Diagnostic description of the required target.
 */
function requireComplete<T>(set: CatalogSet<T>, target: string): readonly T[] {
  if (set.coverage.state === 'complete') return set.items

  const evidence =
    set.coverage.state === 'partial' ? set.coverage.remainder : set.coverage

  throw new MigrationError({
    message: `Incomplete catalog coverage for ${target}: ${evidenceDescription(evidence)}`,
  })
}

/**
 * Extracts a catalog object's required physical name.
 *
 * @param fact - Catalog name fact to require.
 * @param target - Diagnostic description of the named object.
 */
function nameOf(fact: CatalogFact<string>, target: string): string {
  return requireFact(fact, `${target} name`)
}

/**
 * Projects catalog validity and semantic support into planning fields.
 *
 * @param object - Catalog object whose semantics are projected.
 */
function simpleSemantics(
  object: CatalogIndex | CatalogKeyConstraint | CatalogForeignKey,
): Pick<PlanningCatalogIndex, 'semanticCompleteness' | 'isValid'> {
  const isValid = object.validity.state === 'present' && object.validity.value === 'valid'
  return object.semantics.state === 'present'
    ? { semanticCompleteness: 'supportedSimple', isValid }
    : { semanticCompleteness: 'unsupported', isValid }
}

/**
 * Projects a catalog key constraint into its planning representation.
 *
 * @param constraint - Catalog key constraint to project.
 * @param target - Diagnostic description of the constraint.
 */
function keyConstraint(
  constraint: CatalogKeyConstraint,
  target: string,
): PlanningCatalogKeyConstraint {
  return {
    ...(constraint.name.state === 'absent'
      ? {}
      : { name: nameOf(constraint.name, target) }),
    columns: [...constraint.columns],
    ...simpleSemantics(constraint),
  }
}

/**
 * Finds a desired column by name when a desired table exists.
 *
 * @param desired - Lowered desired table, or undefined for an unmanaged relation.
 * @param name - Column name to find.
 */
function desiredColumn(
  desired: LoweredDesiredTable | undefined,
  name: string,
  identities: CanonicalRelationIdentityModule,
  relation: CanonicalRelationIdentity,
) {
  let key: string

  try {
    key = identities.member('column', name).comparisonKey
  } catch (cause) {
    if (!isErrorTag(cause, 'SchemaError')) throw cause

    throw new MigrationError({
      message: `Cannot address column ${JSON.stringify(name)} of ${identities.format(relation)}: ${cause.message}`,
      cause,
    })
  }

  return desired?.columns.find((column) => column.identifier.comparisonKey === key)
}

/**
 * Checks managed relation evidence before adding its planning representation.
 *
 * @param relation - Authored or canonical relation addressed by this operation.
 * @param tables - Observed table definitions used to build fixture catalog evidence.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param desiredTables - Desired tables indexed by canonical relation identity.
 */
function appendPlanningRelation(
  relation: CatalogRelation,
  tables: PlanningCatalogTable[],
  identities: CanonicalRelationIdentityModule,
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>,
): void {
  const target = identities.format(relation.identity)

  if (relation.management === 'unmanaged') {
    if (desiredTables.has(relation.identity)) {
      throw new MigrationError({
        message: `Desired table ${target} collides with an unmanaged catalog relation`,
      })
    }

    return
  }

  if (relation.kind !== 'table' && relation.kind !== 'partitionedTable') {
    throw new MigrationError({
      message: `Managed catalog target ${target} is a ${relation.kind}, not a table`,
    })
  }

  const { columns, table, indexes, uniqueConstraints, foreignKeys, opaqueObjects } =
    requirePlanningTableEvidence(relation, target)

  const desired = desiredTables.get(relation.identity)

  const projectedColumns: PlanningCatalogColumn[] = columns.map((column) =>
    projectPlanningColumn(column, desired, identities, relation),
  )

  const primaryKey =
    table.primaryKey.state === 'absent'
      ? null
      : keyConstraint(requireFact(table.primaryKey, `${target} primary key`), target)

  appendProjectedTable({
    tables,
    relation,
    projectedColumns,
    indexes,
    target,
    primaryKey,
    uniqueConstraints,
    foreignKeys,
    opaqueObjects,
  })
}

/**
 * Requires complete column, index, and constraint evidence for a managed table.
 *
 * @param relation - Authored or canonical relation addressed by this operation.
 * @param target - Identity or evidence required by the current reference or diagnostic.
 *
 * @returns The table facts whose required member collections have complete coverage.
 */
function requirePlanningTableEvidence(relation: CatalogRelation, target: string) {
  const table = requireFact(relation.table, `${target} table definition`)
  const columns = requireComplete(table.columns, `${target} columns`)
  const uniqueConstraints = requireComplete(
    table.uniqueConstraints,
    `${target} unique constraints`,
  )

  const foreignKeys = requireComplete(table.foreignKeys, `${target} foreign keys`)
  const indexes = requireComplete(table.indexes, `${target} indexes`)
  requireComplete(table.options, `${target} table options`)
  const opaqueObjects = requireComplete(table.opaqueObjects, `${target} opaque objects`)
  return { columns, table, indexes, uniqueConstraints, foreignKeys, opaqueObjects }
}

/**
 * Adds a validated table to the catalog used by Migration Plan construction.
 *
 * @param input - Planning table projection inputs and shared accumulators.
 */
function appendProjectedTable(input: PlanningTableProjection) {
  const {
    tables,
    relation,
    projectedColumns,
    indexes,
    target,
    primaryKey,
    uniqueConstraints,
    foreignKeys,
    opaqueObjects,
  } = input

  tables.push({
    identity: relation.identity,
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
      referencedRelation: foreignKey.referencedRelation,
      referencedColumns: [...foreignKey.referencedColumns],
      onDelete: foreignKey.onDelete,
      onUpdate: foreignKey.onUpdate,
    })),
    opaqueObjects: opaqueObjects.map((object) => object.reason),
  })
}

/**
 * Validates evidence once and projects adapter-neutral catalog facts into the current
 * Migration Plan implementation. Adapter-specific snapshot shapes do not cross this seam.
 *
 * @example
 *   const planningCatalog = catalogForPlanning(
 *     snapshot,
 *     identities,
 *     desiredTables,
 *     desiredRelations,
 *     ownership,
 *   )
 *
 * @param snapshot - Adapter-neutral catalog snapshot to validate and project.
 * @param identities - Identity module used for matching and diagnostics.
 * @param desiredTables - Canonical registry of lowered desired tables.
 * @param desiredRelations - Canonical desired relations the snapshot must cover.
 * @param ownership - Resolved migration ownership used to validate coverage.
 */
export function catalogForPlanning(
  snapshot: CatalogSnapshot,
  identities: CanonicalRelationIdentityModule,
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>,
  desiredRelations: readonly CanonicalRelationIdentity[],
  ownership: ResolvedMigrationOwnership,
): PlanningCatalog {
  /**
   * Checks whether the catalog request covers a migration target.
   *
   * @param identity - Canonical relation identity to check.
   */
  assertRequestCoverage(snapshot, identities, desiredRelations, ownership)

  const namespaces = requireComplete(snapshot.namespaces, 'requested namespaces')
  const tables: PlanningCatalogTable[] = projectPlanningRelations(
    namespaces,
    snapshot,
    identities,
    desiredTables,
  )

  const reservations = requireComplete(snapshot.nameReservations, 'physical names')
  const constraintReservations = requireComplete(
    snapshot.constraintNameReservations,
    'constraint names',
  )

  return {
    tables,
    namespaces: namespaces.map((namespace) => namespace.identity),
    nameReservations: reservations.map((reservation) => ({
      namespace: reservation.namespace,
      name: reservation.name,
    })),
    constraintNameReservations: constraintReservations.map((reservation) => ({
      relation: reservation.relation,
      name: reservation.name,
    })),
  }
}

/**
 * Projects requested, managed relations into the planning catalog.
 *
 * @param namespaces - Observed namespace evidence, including relation coverage.
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param desiredTables - Desired tables indexed by canonical relation identity.
 *
 * @returns Requested, managed relations into the planning catalog.
 */
function projectPlanningRelations(
  namespaces: readonly Readonly<{
    identity: readonly CanonicalNamespaceSegment[]
    owner: CatalogFact<string>
    relations: CatalogSet<CatalogRelation>
  }>[],
  snapshot: CatalogSnapshot,
  identities: CanonicalRelationIdentityModule,
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>,
) {
  const tables: PlanningCatalogTable[] = []

  for (const namespace of namespaces) {
    const namespaceTarget = `relations in namespace ${JSON.stringify(
      namespace.identity.map(({ role, identifier }) => ({
        role,
        spelling: identifier.spelling,
      })),
    )}`

    const explicitlyComplete = snapshot.request.completeNamespaces.some((requested) =>
      sameNamespace(requested, namespace.identity),
    )

    const relations =
      !explicitlyComplete &&
      namespace.relations.coverage.state === 'partial' &&
      namespace.relations.coverage.remainder.state === 'unmanaged'
        ? namespace.relations.items
        : requireComplete(namespace.relations, namespaceTarget)

    for (const relation of relations)
      appendPlanningRelation(relation, tables, identities, desiredTables)
  }

  return tables
}

/**
 * Rejects a snapshot that does not cover the requested migration ownership scope.
 *
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param desiredRelations - Registered relation identities required by the catalog
 *   request.
 * @param ownership - Resolved migration authority for relations, absences, and complete
 *   namespaces.
 */
function assertRequestCoverage(
  snapshot: CatalogSnapshot,
  identities: CanonicalRelationIdentityModule,
  desiredRelations: readonly CanonicalRelationIdentity[],
  ownership: ResolvedMigrationOwnership,
) {
  /**
   * Tests whether the catalog request explicitly covers a canonical relation.
   *
   * @param identity - Canonical relation or physical-session identity used by this
   *   operation.
   *
   * @returns True when the catalog request explicitly covers a canonical relation.
   */
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
}

/**
 * Converts complete column facts into fields used for schema comparison.
 *
 * @param column - Authored or observed column metadata used for storage comparison.
 * @param desired - Lowered desired table or schema metadata used for comparison.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param relation - Authored or canonical relation addressed by this operation.
 *
 * @returns Complete column facts into fields used for schema comparison.
 */
function projectPlanningColumn(
  column: import('@/dialects/catalog').CatalogColumn,
  desired: LoweredDesiredTable | undefined,
  identities: CanonicalRelationIdentityModule,
  relation: CatalogRelation,
): PlanningCatalogColumn {
  const target = identities.format(relation.identity)
  const expected = desiredColumn(desired, column.name, identities, relation.identity)

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

  if (
    generation &&
    !['identity', 'rowidAlias', 'autoIncrement'].includes(generation.kind)
  ) {
    throw new MigrationError({
      message: `Unsupported catalog generation for ${target} column ${JSON.stringify(column.name)}`,
    })
  }

  return {
    name: column.name,
    dataType: dataType.comparisonKey,
    isNullable: nullable,
    defaultExpression,
    identityGeneration: generationMode(generation),
  }
}

/**
 * Projects explicit generation while leaving implicit rowid allocation outside identity
 * drift.
 */
function generationMode(
  generation: import('@/dialects/catalog').CatalogValueGeneration | null,
): 'always' | 'byDefault' | null {
  if (generation?.kind === 'identity') return generation.mode

  if (
    generation?.kind === 'autoIncrement' ||
    (generation?.kind === 'rowidAlias' && generation.autoIncrement)
  )
    return 'byDefault'

  return null
}

type PlanningTableProjection = {
  tables: PlanningCatalogTable[]
  relation: CatalogRelation
  projectedColumns: PlanningCatalogColumn[]
  indexes: readonly CatalogIndex[]
  target: string
  primaryKey: PlanningCatalogKeyConstraint | null
  uniqueConstraints: readonly CatalogKeyConstraint[]
  foreignKeys: readonly CatalogForeignKey[]
  opaqueObjects: readonly OpaqueCatalogObject[]
}
