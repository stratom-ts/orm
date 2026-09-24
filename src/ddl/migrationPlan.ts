import type {
  AuthoredDesiredSchema,
  CatalogSnapshot,
  DialectIdentity,
  DialectNaming,
  LoweredDatabaseDefault,
  LoweredDesiredColumn,
  LoweredDesiredSchema,
  LoweredDesiredTable,
} from '@/dialects/types'
import type {
  CanonicalIdentifier,
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationRegistry,
  NamespaceContext,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import { resolveMigrationOwnership } from '@/migrations/migrationOwnership'
import { getReferenceMetadata } from '@/schemas/actions/reference'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'

import { lowerDesiredSchema } from './desiredSchema'
import type {
  PlanningCatalogColumn as CatalogColumn,
  PlanningCatalogForeignKey as CatalogForeignKey,
  PlanningCatalogIndex as CatalogIndex,
  PlanningCatalogKeyConstraint as CatalogKeyConstraint,
  PlanningCatalogTable as CatalogTable,
  PlanningCatalog,
} from './planningCatalog'
import { catalogForPlanning } from './planningCatalog'

/** Relation namespace addressed by a portable namespace step. */
export type MigrationNamespaceTarget = Readonly<{
  kind: 'namespace'
  namespace: readonly CanonicalNamespaceSegment[]
}>

/** Whole relation addressed by a Migration Plan step. */
export type MigrationRelationTarget = Readonly<{
  kind: 'relation'
  relation: CanonicalRelationIdentity
}>

/** One column of a relation addressed by a Migration Plan step. */
export type MigrationColumnTarget = Readonly<{
  kind: 'column'
  relation: CanonicalRelationIdentity
  column: CanonicalIdentifier
}>

/** One index of a relation addressed by a Migration Plan step. */
export type MigrationIndexTarget = Readonly<{
  kind: 'index'
  relation: CanonicalRelationIdentity
  index: CanonicalIdentifier
}>

/** Structured target every Migration Plan step addresses. */
export type MigrationTarget =
  | MigrationNamespaceTarget
  | MigrationRelationTarget
  | MigrationColumnTarget
  | MigrationIndexTarget

/** Structured referenced column carried by a foreign-key payload. */
export type MigrationColumnReference = Readonly<{
  relation: CanonicalRelationIdentity
  column: CanonicalIdentifier
  onDelete?: string
  onUpdate?: string
}>

/** Portable semantic desired-state Migration Plan step. */
export type MigrationStep =
  | Readonly<{
      kind: 'ensure_namespace'
      target: MigrationNamespaceTarget
    }>
  | Readonly<{
      kind: 'create_table'
      target: MigrationRelationTarget
    }>
  | Readonly<{
      kind: 'add_column'
      target: MigrationColumnTarget
      dataType: string
      notNull: boolean
      unique?: boolean
      defaultValue?: string | number | boolean | null
      databaseDefault?: LoweredDatabaseDefault
      generated?: 'always' | 'byDefault'
      autoIncrement?: boolean
    }>
  | Readonly<{
      kind: 'alter_column_type'
      target: MigrationColumnTarget
      dataType: string
    }>
  | Readonly<{
      kind: 'add_foreign_key'
      target: MigrationColumnTarget
      references: MigrationColumnReference
    }>
  | Readonly<{
      kind: 'add_unique_constraint'
      target: MigrationColumnTarget
    }>
  | Readonly<{
      kind: 'set_not_null'
      target: MigrationColumnTarget
    }>
  | Readonly<{
      kind: 'drop_not_null'
      target: MigrationColumnTarget
    }>
  | Readonly<{
      kind: 'create_index'
      target: MigrationIndexTarget
      columns: readonly CanonicalIdentifier[]
      unique: boolean
    }>
  | Readonly<{
      kind: 'drop_column'
      target: MigrationColumnTarget
    }>
  | Readonly<{
      kind: 'drop_table'
      target: MigrationRelationTarget
    }>
  | Readonly<{
      kind: 'drop_index'
      target: MigrationIndexTarget
    }>

export type MigrationPlan = Readonly<{
  steps: readonly MigrationStep[]
}>

/**
 * Resolved semantics every step of one Migration Plan was built under. Lowering must
 * reject a plan whose profile does not match its own dialect and registration inputs.
 */
export type MigrationSemanticProfile = Readonly<{
  /** Stable identity semantic key supplied by the selected Dialect member. */
  identityAdapter: string
  namespaceContext: NamespaceContext
  registrationDefault?: readonly NamespaceIdentifierInput[]
}>

/**
 * Dialect-neutral planning context bound by one selected migration member.
 *
 * The pure planner depends only on the semantic policies needed to reconcile desired
 * and observed state. It does not select those policies from the complete Dialect.
 */
export type MigrationPlanningContext = Readonly<{
  identity: DialectIdentity
  naming: DialectNaming
  schema: Readonly<{
    lowerDesiredSchema(graph: AuthoredDesiredSchema): LoweredDesiredSchema
    normalizeDataType(dataType: string): string
    normalizeDefaultValue?: (value: string | number | boolean | null) => string
  }>
}>

type PlanningIssue = {
  identity: CanonicalRelationIdentity
  target: string
  property:
    | 'invalid_desired_table'
    | 'duplicate_registered_table'
    | 'duplicate_catalog_table'
    | 'duplicate_catalog_column'
    | 'duplicate_catalog_index'
    | 'primary_key'
    | 'unique_constraint'
    | 'foreign_key'
    | 'default'
    | 'identity'
    | 'index_definition'
    | 'ambiguous_semantic_match'
    | 'unsupported_catalog_semantics'
    | 'opaque_catalog_object'
  message: string
}

const MIGRATION_PHASE: Record<MigrationStep['kind'], number> = {
  ensure_namespace: 0,
  create_table: 1,
  add_column: 2,
  alter_column_type: 3,
  drop_not_null: 4,
  set_not_null: 5,
  create_index: 6,
  add_unique_constraint: 7,
  add_foreign_key: 8,
  drop_index: 9,
  drop_column: 10,
  drop_table: 11,
}

// Issues sort by schema/table/member first; this rank resolves one target's properties.
const ISSUE_PROPERTY_ORDER: Record<PlanningIssue['property'], number> = {
  invalid_desired_table: 0,
  duplicate_registered_table: 1,
  duplicate_catalog_table: 2,
  duplicate_catalog_column: 3,
  duplicate_catalog_index: 4,
  primary_key: 5,
  unique_constraint: 6,
  foreign_key: 7,
  default: 8,
  identity: 9,
  index_definition: 10,
  ambiguous_semantic_match: 11,
  unsupported_catalog_semantics: 12,
  opaque_catalog_object: 13,
}

/**
 * Compares strings by locale-independent UTF-16 code-unit order.
 *
 * @param left - First string to compare.
 * @param right - Second string to compare.
 */
function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * Validates every physical identifier in a canonical namespace.
 *
 * @param namespace - Canonical namespace whose identifiers are validated.
 * @param profile - Dialect-specific physical naming profile.
 */
function validateCanonicalNamespaceNames(
  namespace: CanonicalRelationIdentity['namespace'],
  naming: DialectNaming,
): void {
  for (const segment of namespace) {
    naming.validate(segment.identifier.spelling, `${segment.role} identifier`)
  }
}

/**
 * Validates the namespace and relation identifiers of a canonical identity.
 *
 * @param identity - Canonical relation identity to validate.
 * @param profile - Dialect-specific physical naming profile.
 */
function validateCanonicalRelationNames(
  identity: CanonicalRelationIdentity,
  naming: DialectNaming,
): void {
  validateCanonicalNamespaceNames(identity.namespace, naming)
  naming.validate(identity.relation.spelling, 'relation identifier')
}

/**
 * Compares namespace roles and comparison keys while ignoring the relation segment.
 *
 * @param left - First canonical namespace.
 * @param right - Second canonical namespace.
 */
function sameNamespace(
  left: CanonicalRelationIdentity['namespace'],
  right: CanonicalRelationIdentity['namespace'],
): boolean {
  return compareNamespaces(left, right) === 0
}

/**
 * Compares canonical namespaces by role then comparison key. Canonical plan order is a
 * structural property of the plan, so it is derived here rather than from the identity
 * module a caller may no longer hold.
 *
 * @param left - First canonical namespace.
 * @param right - Second canonical namespace.
 */
function compareNamespaces(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
): number {
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index++) {
    const role = compareCodeUnits(left[index]!.role, right[index]!.role)
    if (role !== 0) return role

    const identifier = compareCodeUnits(
      left[index]!.identifier.comparisonKey,
      right[index]!.identifier.comparisonKey,
    )
    if (identifier !== 0) return identifier
  }

  return left.length - right.length
}

/**
 * Reads the namespace addressed by any structured target.
 *
 * @param target - Structured Migration Plan target.
 */
function targetNamespace(target: MigrationTarget): readonly CanonicalNamespaceSegment[] {
  return target.kind === 'namespace' ? target.namespace : target.relation.namespace
}

/**
 * Reads the relation member addressed by a structured target, if any.
 *
 * @param target - Structured Migration Plan target.
 */
function targetMember(target: MigrationTarget): CanonicalIdentifier | undefined {
  if (target.kind === 'column') return target.column
  if (target.kind === 'index') return target.index
  return undefined
}

/**
 * Projects a target into its ordered comparison keys, then its authored spellings.
 * Adapters that fold identifier case make distinct targets share comparison keys, so
 * spelling keeps canonical order total.
 *
 * @param target - Structured Migration Plan target.
 * @param field - Identifier field the tuple is built from.
 */
function targetTuple(
  target: MigrationTarget,
  field: 'comparisonKey' | 'spelling',
): readonly string[] {
  return [
    target.kind === 'namespace' ? '' : target.relation.relation[field],
    targetMember(target)?.[field] ?? '',
  ]
}

/**
 * Orders structured targets by namespace, relation, then addressed member. Comparison
 * keys decide identity order; authored spellings then keep the order total for adapters
 * that fold identifier case.
 *
 * @param left - First structured target.
 * @param right - Second structured target.
 */
function compareMigrationTargets(left: MigrationTarget, right: MigrationTarget): number {
  const namespaces = [targetNamespace(left), targetNamespace(right)] as const
  return (
    compareNamespaces(...namespaces) ||
    compareStringArrays(
      targetTuple(left, 'comparisonKey'),
      targetTuple(right, 'comparisonKey'),
    ) ||
    compareStringArrays(
      namespaces[0].map((segment) => segment.identifier.spelling),
      namespaces[1].map((segment) => segment.identifier.spelling),
    ) ||
    compareStringArrays(targetTuple(left, 'spelling'), targetTuple(right, 'spelling'))
  )
}

/**
 * Orders plan steps by semantic phase, then by structured code-unit target order.
 *
 * @param left - First Migration Plan step.
 * @param right - Second Migration Plan step.
 */
function compareMigrationSteps(left: MigrationStep, right: MigrationStep): number {
  return (
    MIGRATION_PHASE[left.kind] - MIGRATION_PHASE[right.kind] ||
    compareMigrationTargets(left.target, right.target)
  )
}

/**
 * Selects planning issues deterministically by relation, member, property, and message.
 *
 * @param left - First planning issue.
 * @param right - Second planning issue.
 * @param identities - Identity module used to compare issue targets.
 */
function comparePlanningIssues(
  left: PlanningIssue,
  right: PlanningIssue,
  identities: CanonicalRelationIdentityModule,
): number {
  const relation = identities.compare(left.identity, right.identity)
  if (relation !== 0) return relation

  const target = compareCodeUnits(left.target, right.target)
  if (target !== 0) return target
  return (
    ISSUE_PROPERTY_ORDER[left.property] - ISSUE_PROPERTY_ORDER[right.property] ||
    compareCodeUnits(left.message, right.message)
  )
}

/**
 * Orders desired table handles by their resolved canonical relation identities.
 *
 * @param left - First desired table handle.
 * @param right - Second desired table handle.
 * @param identities - Identity module used to resolve and compare handles.
 */
function compareTableHandles(
  left: TableHandle,
  right: TableHandle,
  identities: CanonicalRelationIdentityModule,
): number {
  const leftInfo = left.getTableMetadata()
  const rightInfo = right.getTableMetadata()
  return identities.compare(
    identities.resolve(leftInfo.relation),
    identities.resolve(rightInfo.relation),
  )
}

/**
 * Orders introspected tables by their explicit canonical relation identities.
 *
 * @param left - First catalog table.
 * @param right - Second catalog table.
 * @param identities - Identity module used to resolve and compare catalog tables.
 */
function compareCatalogTables(
  left: CatalogTable,
  right: CatalogTable,
  identities: CanonicalRelationIdentityModule,
): number {
  return identities.compare(left.identity, right.identity)
}

/**
 * Registers catalog tables by structured identity and records duplicate identities as
 * planning issues while retaining the first table.
 *
 * @param tables - Canonically ordered catalog tables to register.
 * @param issues - Mutable collection that receives duplicate-table issues.
 * @param identities - Identity module used for structured registration.
 */
function catalogTableMap(
  tables: readonly CatalogTable[],
  issues: PlanningIssue[],
  identities: CanonicalRelationIdentityModule,
) {
  const map = identities.createRegistry<CatalogTable>()

  for (const table of tables) {
    const identity = table.identity

    if (map.has(identity)) {
      issues.push({
        identity,
        target: '',
        property: 'duplicate_catalog_table',
        message: `Duplicate catalog table ${identities.format(identity)}`,
      })

      continue
    }

    map.set(identity, table)
  }

  return map
}

/**
 * Tests arrays for positional string equality without mutating either input.
 *
 * @param left - First ordered string collection.
 * @param right - Second ordered string collection.
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

/** Canonicalizes authored or catalog member spellings for semantic comparison. */
function memberKeys(
  role: 'column' | 'index',
  spellings: readonly string[],
  identities: CanonicalRelationIdentityModule,
): string[] {
  return spellings.map((spelling) => identities.member(role, spelling).comparisonKey)
}

/**
 * Normalizes referential actions for catalog-to-desired comparisons.
 *
 * @param action - Introspected or desired action, or undefined for the SQL default.
 */
function normalizeAction(action: string | undefined): string {
  return action?.toLowerCase() ?? 'no action'
}

/**
 * Reports unsupported default drift when the catalog supplied complete default
 * information; returns undefined when values match or the catalog value is unknown.
 *
 * @param target - Structured diagnostic target for the column.
 * @param live - Introspected column definition.
 * @param desired - Desired column definition.
 * @param planning - Selected member's bound planning semantics.
 */
function defaultMismatch(
  target: string,
  live: CatalogColumn,
  desired: LoweredDesiredColumn,
  planning: MigrationPlanningContext,
): string | undefined {
  if (live.defaultExpression === undefined) return

  const expected =
    desired.databaseDefault?.normalized ??
    (desired.defaultValue === undefined
      ? null
      : planning.schema.normalizeDefaultValue?.(desired.defaultValue))

  if (
    desired.databaseDefault === undefined &&
    desired.defaultValue !== undefined &&
    expected === undefined
  ) {
    return `Cannot compare default for ${target}: dialect does not normalize defaults`
  }

  if (live.defaultExpression !== expected) {
    return `Unsupported default change for ${target}`
  }
}

/**
 * Reports unsupported identity-generation drift when the catalog supplied that
 * property; returns undefined when values match or the property is unknown.
 *
 * @param target - Structured diagnostic target for the column.
 * @param live - Introspected column definition.
 * @param desired - Desired column definition.
 */
function identityMismatch(
  target: string,
  live: CatalogColumn,
  desired: LoweredDesiredColumn,
): string | undefined {
  if (live.identityGeneration === undefined) return

  const expected = desired.generated ?? (desired.autoIncrement ? 'byDefault' : null)

  if (live.identityGeneration !== expected) {
    return `Unsupported identity change for ${target}`
  }
}

type CanonicalForeignKey = {
  columns: readonly string[]
  referencedRelation: CanonicalRelationIdentity
  referencedColumns: readonly string[]
  onDelete: string
  onUpdate: string
}

/**
 * Compares string arrays lexicographically using deterministic code-unit ordering.
 *
 * @param left - First ordered string collection.
 * @param right - Second ordered string collection.
 */
function compareStringArrays(left: readonly string[], right: readonly string[]): number {
  const length = Math.min(left.length, right.length)

  for (let index = 0; index < length; index++) {
    const result = compareCodeUnits(left[index]!, right[index]!)
    if (result !== 0) return result
  }

  return left.length - right.length
}

/**
 * Compares every semantic field of two normalized foreign-key definitions.
 *
 * @param left - First normalized foreign key.
 * @param right - Second normalized foreign key.
 * @param identities - Identity module used to compare referenced relations.
 */
function compareForeignKeys(
  left: CanonicalForeignKey,
  right: CanonicalForeignKey,
  identities: CanonicalRelationIdentityModule,
): number {
  return (
    compareStringArrays(left.columns, right.columns) ||
    identities.compare(left.referencedRelation, right.referencedRelation) ||
    compareStringArrays(left.referencedColumns, right.referencedColumns) ||
    compareCodeUnits(left.onDelete, right.onDelete) ||
    compareCodeUnits(left.onUpdate, right.onUpdate)
  )
}

/**
 * Checks whether a catalog object has complete, valid simple semantics.
 *
 * @param object - Catalog object whose semantic support is checked.
 */
function hasSupportedCatalogSemantics(
  object: CatalogIndex | CatalogKeyConstraint | CatalogForeignKey,
): boolean {
  return object.semanticCompleteness === 'supportedSimple' && object.isValid === true
}

/**
 * Normalizes an introspected foreign key for semantic comparison.
 *
 * @param foreignKey - Introspected foreign key to normalize.
 */
function canonicalCatalogForeignKey(
  foreignKey: CatalogForeignKey,
  identities: CanonicalRelationIdentityModule,
): CanonicalForeignKey {
  return {
    columns: memberKeys('column', foreignKey.columns, identities),
    referencedRelation: foreignKey.referencedRelation,
    referencedColumns: memberKeys('column', foreignKey.referencedColumns, identities),
    onDelete: normalizeAction(foreignKey.onDelete),
    onUpdate: normalizeAction(foreignKey.onUpdate),
  }
}

/**
 * Normalizes a desired column reference for semantic comparison.
 *
 * @param column - Desired column containing a foreign-key reference.
 * @param identities - Identity module used to resolve its referenced relation.
 */
function canonicalDesiredForeignKey(column: LoweredDesiredColumn): CanonicalForeignKey {
  const reference = column.reference!
  return {
    columns: [column.identifier.comparisonKey],
    referencedRelation: reference.relation,
    referencedColumns: [reference.column.comparisonKey],
    onDelete: normalizeAction(reference.onDelete),
    onUpdate: normalizeAction(reference.onUpdate),
  }
}

/**
 * Finds unique constraints that cover exactly one requested column.
 *
 * @param constraints - Introspected unique constraints to search.
 * @param column - Desired unique column name.
 */
function matchUniqueConstraints(
  constraints: readonly CatalogKeyConstraint[],
  column: CanonicalIdentifier,
  identities: CanonicalRelationIdentityModule,
): CatalogKeyConstraint[] {
  return constraints.filter((constraint) =>
    arraysEqual(memberKeys('column', constraint.columns, identities), [
      column.comparisonKey,
    ]),
  )
}

/**
 * Finds introspected foreign keys semantically equal to an expected key.
 *
 * @param foreignKeys - Introspected foreign keys to search.
 * @param expected - Normalized desired foreign key.
 * @param identities - Identity module used for relation comparison.
 */
function matchForeignKeys(
  foreignKeys: readonly CatalogForeignKey[],
  expected: CanonicalForeignKey,
  identities: CanonicalRelationIdentityModule,
): CatalogForeignKey[] {
  return foreignKeys.filter(
    (foreignKey) =>
      compareForeignKeys(
        canonicalCatalogForeignKey(foreignKey, identities),
        expected,
        identities,
      ) === 0,
  )
}

type ManagedConstraintIssueCollection = Readonly<{
  live: CatalogTable
  desired: LoweredDesiredTable
  shape: 'complete' | 'additive'
  issues: PlanningIssue[]
  identities: CanonicalRelationIdentityModule
  liveColumns: ReadonlyMap<string, CatalogColumn>
}>

/** Collects unsupported unique-constraint drift for one managed relation. */
function collectUniqueConstraintIssues({
  live,
  desired,
  shape,
  issues,
  identities,
  liveColumns,
}: ManagedConstraintIssueCollection): void {
  if (live.uniqueConstraints === undefined) return

  const identity = live.identity
  const expected = desired.columns.filter(
    (column) => column.unique && liveColumns.has(column.identifier.comparisonKey),
  )
  const matched = new Set<CatalogKeyConstraint>()

  for (const column of expected) {
    const matches = matchUniqueConstraints(
      live.uniqueConstraints,
      column.identifier,
      identities,
    )

    if (matches.length > 1) {
      issues.push({
        identity,
        target: column.identifier.comparisonKey,
        property: 'ambiguous_semantic_match',
        message: `Ambiguous unique constraint semantic match for ${identities.format(
          identity,
          { role: 'column', spelling: column.identifier.spelling },
        )}`,
      })
    }

    for (const match of matches) matched.add(match)
    const match = matches[0]
    if (!match) continue

    if (!hasSupportedCatalogSemantics(match)) {
      issues.push({
        identity,
        target: column.identifier.comparisonKey,
        property: 'unsupported_catalog_semantics',
        message: `Unsupported unique constraint catalog semantics for ${identities.format(
          identity,
          { role: 'column', spelling: column.identifier.spelling },
        )}`,
      })
    }
  }

  if (
    shape === 'complete' &&
    live.uniqueConstraints.some((constraint) => !matched.has(constraint))
  ) {
    issues.push({
      identity,
      target: '',
      property: 'unique_constraint',
      message: `Unsupported removal of extra unique constraints for '${identities.format(identity)}'`,
    })
  }
}

/** Collects unsupported foreign-key drift for one managed relation. */
function collectForeignKeyIssues({
  live,
  desired,
  shape,
  issues,
  identities,
  liveColumns,
}: ManagedConstraintIssueCollection): void {
  if (live.foreignKeys === undefined) return

  const identity = live.identity
  const tableName = identities.format(identity)
  const expected = desired.columns
    .filter(
      (column) =>
        column.reference !== undefined &&
        liveColumns.has(column.identifier.comparisonKey),
    )
    .map((column) => canonicalDesiredForeignKey(column))
    .sort((left, right) => compareForeignKeys(left, right, identities))
  const matched = new Set<CatalogForeignKey>()

  for (const expectedForeignKey of expected) {
    const matches = matchForeignKeys(live.foreignKeys, expectedForeignKey, identities)

    if (matches.length > 1) {
      issues.push({
        identity,
        target: expectedForeignKey.columns.join('\0'),
        property: 'ambiguous_semantic_match',
        message: `Ambiguous foreign key semantic match for '${tableName}'`,
      })
    }

    for (const match of matches) matched.add(match)
    const match = matches[0]
    if (!match) continue

    if (!hasSupportedCatalogSemantics(match)) {
      issues.push({
        identity,
        target: expectedForeignKey.columns.join('\0'),
        property: 'unsupported_catalog_semantics',
        message: `Unsupported foreign key catalog semantics for '${tableName}'`,
      })
    }
  }

  if (
    shape === 'complete' &&
    live.foreignKeys.some((foreignKey) => !matched.has(foreignKey))
  ) {
    issues.push({
      identity,
      target: '',
      property: 'foreign_key',
      message: `Unsupported removal of extra foreign keys for '${tableName}'`,
    })
  }
}

/**
 * Adds deterministic issues for managed properties that cannot yet be migrated safely.
 * Undefined catalog properties are treated as unavailable rather than as drift.
 *
 * @param live - Introspected table definition.
 * @param desired - Dialect-lowered desired table definition.
 * @param shape - Ownership shape controlling whether extra objects are drift.
 * @param planning - Selected member's bound planning semantics.
 * @param issues - Mutable collection that receives unsupported-drift issues.
 * @param identities - Identity module used for comparison and diagnostics.
 */
function collectManagedPropertyIssues(
  live: CatalogTable,
  desired: LoweredDesiredTable,
  shape: 'complete' | 'additive',
  planning: MigrationPlanningContext,
  issues: PlanningIssue[],
  identities: CanonicalRelationIdentityModule,
): void {
  const identity = live.identity
  const tableName = identities.format(identity)
  const liveColumns = new Map<string, CatalogColumn>()

  const orderedLiveColumns = live.columns
    .map((column) => ({
      column,
      identifier: memberIdentifier(identity, 'column', column.name, identities),
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.identifier.comparisonKey, right.identifier.comparisonKey) ||
        compareCodeUnits(left.identifier.spelling, right.identifier.spelling),
    )

  for (const { column, identifier } of orderedLiveColumns) {
    const key = identifier.comparisonKey

    if (liveColumns.has(key)) {
      issues.push({
        identity,
        target: key,
        property: 'duplicate_catalog_column',
        message: `Duplicate catalog column ${identities.format(identity, {
          role: 'column',
          spelling: column.name,
        })}`,
      })

      continue
    }

    liveColumns.set(key, column)
  }

  for (const column of desired.columns) {
    const current = liveColumns.get(column.identifier.comparisonKey)
    if (!current) continue
    const columnLabel = identities.format(identity, {
      role: 'column',
      spelling: column.identifier.spelling,
    })
    const defaultMessage = defaultMismatch(columnLabel, current, column, planning)

    if (defaultMessage) {
      issues.push({
        identity,
        target: column.identifier.comparisonKey,
        property: 'default',
        message: defaultMessage,
      })
    }

    const identityMessage = identityMismatch(columnLabel, current, column)

    if (identityMessage) {
      issues.push({
        identity,
        target: column.identifier.comparisonKey,
        property: 'identity',
        message: identityMessage,
      })
    }
  }

  if (live.primaryKey !== undefined) {
    const current = live.primaryKey?.columns ?? []

    if (
      (live.primaryKey && !hasSupportedCatalogSemantics(live.primaryKey)) ||
      !arraysEqual(
        memberKeys('column', current, identities),
        desired.primaryKey.map((column) => column.comparisonKey),
      )
    ) {
      issues.push({
        identity,
        target: '',
        property: 'primary_key',
        message: `Unsupported primary key change for '${tableName}'`,
      })
    }
  }

  const constraintInput = {
    live,
    desired,
    shape,
    issues,
    identities,
    liveColumns,
  }
  collectUniqueConstraintIssues(constraintInput)
  collectForeignKeyIssues(constraintInput)
}

/**
 * Builds the structured target for a whole relation.
 *
 * @param relation - Canonical relation identity.
 */
function relationTarget(relation: CanonicalRelationIdentity): MigrationRelationTarget {
  return { kind: 'relation', relation }
}

/**
 * Canonicalizes a relation member name and reports which relation rejected it. Desired
 * and introspected names both pass here, so an unaddressable catalog name fails with its
 * owning relation rather than with a bare identifier message.
 *
 * @param relation - Canonical relation identity owning the member.
 * @param role - Member role.
 * @param spelling - Member spelling.
 * @param identities - Identity module used to canonicalize the member identifier.
 *
 * @throws {MigrationError} When the member cannot be addressed canonically.
 */
function memberIdentifier(
  relation: CanonicalRelationIdentity,
  role: 'column' | 'index',
  spelling: string,
  identities: CanonicalRelationIdentityModule,
): CanonicalIdentifier {
  try {
    return identities.member(role, spelling)
  } catch (cause) {
    throw new MigrationError({
      message: `Cannot address ${role} ${JSON.stringify(spelling)} of ${identities.format(
        relation,
      )}: ${cause instanceof Error ? cause.message : 'invalid identifier'}`,
      ...(cause !== undefined ? { cause } : {}),
    })
  }
}

/**
 * Builds the structured target for one relation column.
 *
 * @param relation - Canonical relation identity.
 * @param column - Column spelling.
 * @param identities - Identity module used to canonicalize the column identifier.
 */
function columnTarget(
  relation: CanonicalRelationIdentity,
  column: string,
  identities: CanonicalRelationIdentityModule,
): MigrationColumnTarget {
  return {
    kind: 'column',
    relation,
    column: memberIdentifier(relation, 'column', column, identities),
  }
}

/**
 * Builds the structured target for one relation index.
 *
 * @param relation - Canonical relation identity.
 * @param index - Index spelling.
 * @param identities - Identity module used to canonicalize the index identifier.
 */
function indexTarget(
  relation: CanonicalRelationIdentity,
  index: string,
  identities: CanonicalRelationIdentityModule,
): MigrationIndexTarget {
  return {
    kind: 'index',
    relation,
    index: memberIdentifier(relation, 'index', index, identities),
  }
}

/**
 * Resolves a desired foreign-key reference into its structured plan payload.
 *
 * @param reference - Desired foreign-key reference to resolve.
 * @param identities - Identity module used to resolve the referenced relation.
 */
function structuredReference(
  reference: NonNullable<LoweredDesiredColumn['reference']>,
): MigrationColumnReference {
  return {
    relation: reference.relation,
    column: reference.column,
    ...(reference.onDelete === undefined ? {} : { onDelete: reference.onDelete }),
    ...(reference.onUpdate === undefined ? {} : { onUpdate: reference.onUpdate }),
  }
}

/**
 * Normalizes desired indexes and fills omitted names and uniqueness flags.
 *
 * @param info - Desired table metadata containing index declarations.
 * @param identity - Canonical identity of the desired table.
 * @param naming - Selected member's physical naming rules.
 */
function desiredIndexes(
  info: ReturnType<TableHandle['getTableMetadata']>,
  identity: CanonicalRelationIdentity,
  naming: DialectNaming,
  identities: CanonicalRelationIdentityModule,
): Array<{
  name: CanonicalIdentifier
  columns: CanonicalIdentifier[]
  unique: boolean
  origin: 'explicit' | 'generated'
}> {
  return (info.indexes ?? [])
    .map((raw) => {
      const index = raw
      const unique = index.unique ?? false
      return {
        name: identities.member(
          'index',
          index.name ??
            naming.generate({
              kind: 'index',
              owner: identity,
              columns: index.columns,
              unique,
            }),
        ),
        columns: index.columns.map((column) => identities.member('column', column)),
        unique,
        origin: index.name === undefined ? ('generated' as const) : ('explicit' as const),
      }
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.name.comparisonKey, right.name.comparisonKey) ||
        compareCodeUnits(left.name.spelling, right.name.spelling) ||
        compareStringArrays(
          left.columns.map((column) => column.comparisonKey),
          right.columns.map((column) => column.comparisonKey),
        ) ||
        Number(left.unique) - Number(right.unique),
    )
}

/** Orders catalog indexes canonically and keeps one reservation per member identity. */
function uniqueCatalogIndexes(
  indexes: readonly CatalogIndex[],
  identity: CanonicalRelationIdentity,
  identities: CanonicalRelationIdentityModule,
): CatalogIndex[] {
  const comparisonKeys = new Set<string>()

  return indexes
    .map((index) => ({
      index,
      identifier: memberIdentifier(identity, 'index', index.name, identities),
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.identifier.comparisonKey, right.identifier.comparisonKey) ||
        compareCodeUnits(left.identifier.spelling, right.identifier.spelling),
    )
    .flatMap(({ index, identifier }) => {
      if (comparisonKeys.has(identifier.comparisonKey)) return []

      comparisonKeys.add(identifier.comparisonKey)
      return [index]
    })
}

/** Reserves canonically unique catalog indexes while recognizing every spelling. */
function reserveCatalogIndexes(
  indexes: readonly CatalogIndex[],
  identity: CanonicalRelationIdentity,
  identities: CanonicalRelationIdentityModule,
  physicalNames: ReturnType<DialectNaming['createRegistry']>,
  representedCatalogNames: Set<string>,
): void {
  for (const index of indexes) {
    representedCatalogNames.add(namespaceNameKey(identity.namespace, index.name))
  }

  for (const index of uniqueCatalogIndexes(indexes, identity, identities)) {
    physicalNames.reserve({
      kind: 'index',
      owner: identity,
      name: index.name,
      token: `catalog:${namespaceNameKey(identity.namespace, index.name)}`,
      description: `catalog index ${JSON.stringify(index.name)}`,
    })
  }
}

export type PlannedMigration = {
  plan: MigrationPlan
  profile: MigrationSemanticProfile
  identities: CanonicalRelationIdentityModule
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>
  planningCatalog: PlanningCatalog
}

/**
 * Identifies one catalog-reported physical name within its namespace. Names sharing a
 * namespace share a reservation scope, so the same name reported twice is one object,
 * while a differently spelled name stays a separate object the registry can reject.
 *
 * @param namespace - Canonical namespace owning the name.
 * @param name - Reported physical name.
 */
function namespaceNameKey(
  namespace: readonly CanonicalNamespaceSegment[],
  name: string,
): string {
  return JSON.stringify([
    namespace.map((segment) => [segment.role, segment.identifier.comparisonKey]),
    name,
  ])
}

type DesiredIndex = ReturnType<typeof desiredIndexes>[number]

type IndexReconciliation = Readonly<{
  live: CatalogTable
  desired: readonly DesiredIndex[]
  identity: CanonicalRelationIdentity
  shape: 'complete' | 'additive'
  relationStepStart: number
  steps: MigrationStep[]
  issues: PlanningIssue[]
  identities: CanonicalRelationIdentityModule
  physicalNames: ReturnType<DialectNaming['createRegistry']>
}>

/** Indexes observed catalog indexes and reports duplicate or opaque semantics. */
function collectLiveIndexes(
  input: Pick<
    IndexReconciliation,
    'live' | 'identity' | 'shape' | 'issues' | 'identities'
  >,
): Readonly<{
  indexes: ReadonlyMap<string, CatalogIndex>
  unsupportedNames: Set<string>
}> {
  const { live, identity, shape, issues, identities } = input
  const indexes = new Map<string, CatalogIndex>()
  const unsupportedNames = new Set<string>()
  const ordered = (live.indexes ?? [])
    .map((liveIndex) => ({
      liveIndex,
      identifier: memberIdentifier(identity, 'index', liveIndex.name, identities),
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.identifier.comparisonKey, right.identifier.comparisonKey) ||
        compareCodeUnits(left.identifier.spelling, right.identifier.spelling),
    )

  for (const { liveIndex, identifier } of ordered) {
    const key = identifier.comparisonKey

    if (indexes.has(key)) {
      issues.push({
        identity,
        target: key,
        property: 'duplicate_catalog_index',
        message: `Duplicate catalog index ${identities.format(identity, {
          role: 'index',
          spelling: liveIndex.name,
        })}`,
      })

      continue
    }

    indexes.set(key, liveIndex)

    if (shape === 'complete' && !hasSupportedCatalogSemantics(liveIndex)) {
      unsupportedNames.add(key)

      issues.push({
        identity,
        target: key,
        property: 'unsupported_catalog_semantics',
        message: `Unsupported index catalog semantics for ${identities.format(identity, {
          role: 'index',
          spelling: liveIndex.name,
        })}`,
      })
    }
  }

  return { indexes, unsupportedNames }
}

/**
 * Reconciles desired and observed indexes for one existing relation.
 *
 * Index matching is its own planning phase because generated names match by semantics,
 * while explicit names match by identity. Keeping the complete phase together also
 * localizes the opaque-object guard for destructive index changes.
 */
function reconcileIndexes({
  live,
  desired,
  identity,
  shape,
  relationStepStart,
  steps,
  issues,
  identities,
  physicalNames,
}: IndexReconciliation): void {
  const claimedLiveIndexNames = new Set<string>()
  const { indexes: liveIndexes, unsupportedNames: unsupportedLiveIndexNames } =
    collectLiveIndexes({ live, identity, shape, issues, identities })

  for (const index of desired) {
    let current: CatalogIndex | undefined

    if (index.origin === 'generated') {
      const semanticMatches = [...liveIndexes.values()].filter(
        (candidate) =>
          candidate.unique === index.unique &&
          arraysEqual(
            memberKeys('column', candidate.columns, identities),
            index.columns.map((column) => column.comparisonKey),
          ),
      )

      if (semanticMatches.length > 1) {
        issues.push({
          identity,
          target: index.name.comparisonKey,
          property: 'ambiguous_semantic_match',
          message: `Ambiguous index semantic match for ${identities.format(identity, {
            role: 'index',
            spelling: index.name.spelling,
          })}`,
        })

        continue
      }

      current = semanticMatches[0]
      if (!current) current = liveIndexes.get(index.name.comparisonKey)
    } else {
      current = liveIndexes.get(index.name.comparisonKey)
    }

    if (!current) {
      physicalNames.reserve({
        kind: 'index',
        owner: identity,
        name: index.name.spelling,
        token: `${index.origin}-index:${identities.format(identity)}:${JSON.stringify(index.columns.map((column) => column.comparisonKey))}:${index.unique}`,
        description: `${index.origin} index ${JSON.stringify(index.name.spelling)}`,
      })

      steps.push({
        kind: 'create_index',
        target: { kind: 'index', relation: identity, index: index.name },
        columns: index.columns,
        unique: index.unique,
      })

      continue
    }

    const currentKey = identities.member('index', current.name).comparisonKey
    claimedLiveIndexNames.add(currentKey)

    if (
      !hasSupportedCatalogSemantics(current) &&
      !unsupportedLiveIndexNames.has(currentKey)
    ) {
      unsupportedLiveIndexNames.add(currentKey)

      issues.push({
        identity,
        target: currentKey,
        property: 'unsupported_catalog_semantics',
        message: `Unsupported index catalog semantics for ${identities.format(identity, {
          role: 'index',
          spelling: current.name,
        })}`,
      })
    }

    if (
      hasSupportedCatalogSemantics(current) &&
      (current.unique !== index.unique ||
        !arraysEqual(
          memberKeys('column', current.columns, identities),
          index.columns.map((column) => column.comparisonKey),
        ))
    ) {
      issues.push({
        identity,
        target: index.name.comparisonKey,
        property: 'index_definition',
        message: `Unsupported index definition change for ${identities.format(identity, {
          role: 'index',
          spelling: index.name.spelling,
        })}`,
      })
    }
  }

  if (shape === 'complete') {
    for (const liveIndex of live.indexes ?? []) {
      if (
        claimedLiveIndexNames.has(
          identities.member('index', liveIndex.name).comparisonKey,
        )
      )
        continue

      steps.push({
        kind: 'drop_index',
        target: indexTarget(identity, liveIndex.name, identities),
      })
    }
  }

  if (
    live.opaqueObjects.length > 0 &&
    steps
      .slice(relationStepStart)
      .some(
        (step) =>
          step.kind === 'alter_column_type' ||
          step.kind === 'drop_column' ||
          step.kind === 'drop_index',
      )
  ) {
    issues.push({
      identity,
      target: '',
      property: 'opaque_catalog_object',
      message: `Cannot destructively change '${identities.format(identity)}' while it contains opaque catalog objects: ${live.opaqueObjects.join(', ')}`,
    })
  }
}

/** Validates authored relation, column, and reference names before lowering. */
function validateDesiredNames(
  schemas: readonly TableHandle[],
  identities: CanonicalRelationIdentityModule,
  naming: DialectNaming,
): void {
  for (const handle of schemas) {
    const metadata = handle.getTableMetadata()
    validateCanonicalRelationNames(identities.resolve(metadata.relation), naming)

    for (const value of Object.values(handle.getSchema().entries)) {
      if (!value || value.kind !== 'schema') continue
      const reference = getReferenceMetadata(value)
      if (!reference) continue

      validateCanonicalRelationNames(
        identities.resolve(reference.target.relation),
        naming,
      )

      naming.validate(reference.target.column, 'referenced column name')
    }
  }
}

/** Validates relation and namespace names introduced by ownership declarations. */
function validateOwnershipNames(
  ownership: ReturnType<typeof resolveMigrationOwnership>,
  naming: DialectNaming,
): void {
  for (const identity of [...ownership.explicitRelations, ...ownership.absentRelations]) {
    validateCanonicalRelationNames(identity, naming)
  }

  for (const namespace of ownership.completeNamespaces) {
    validateCanonicalNamespaceNames(namespace, naming)
  }
}

type ExistingColumnReconciliation = Readonly<{
  live: CatalogTable
  desired: LoweredDesiredTable
  identity: CanonicalRelationIdentity
  shape: 'complete' | 'additive'
  steps: MigrationStep[]
  deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[]
  planning: MigrationPlanningContext
  identities: CanonicalRelationIdentityModule
  reserveForeignKey: (
    owner: CanonicalRelationIdentity,
    column: string,
    reference: NonNullable<LoweredDesiredColumn['reference']>,
  ) => void
  reserveUniqueConstraint: (owner: CanonicalRelationIdentity, column: string) => void
}>

type ColumnConstraintReconciliation = Pick<
  ExistingColumnReconciliation,
  | 'live'
  | 'desired'
  | 'identity'
  | 'steps'
  | 'deferredForeignKeys'
  | 'identities'
  | 'reserveForeignKey'
  | 'reserveUniqueConstraint'
> &
  Readonly<{ liveColumns: ReadonlyMap<string, CatalogColumn> }>

/** Adds desired unique and foreign-key constraints missing from an existing relation. */
function appendMissingColumnConstraints({
  live,
  desired,
  identity,
  steps,
  deferredForeignKeys,
  identities,
  reserveForeignKey,
  reserveUniqueConstraint,
  liveColumns,
}: ColumnConstraintReconciliation): void {
  if (live.uniqueConstraints !== undefined) {
    for (const desiredColumn of desired.columns) {
      if (
        !desiredColumn.unique ||
        !liveColumns.has(desiredColumn.identifier.comparisonKey)
      )
        continue
      const matches = matchUniqueConstraints(
        live.uniqueConstraints,
        desiredColumn.identifier,
        identities,
      )
      if (matches.length !== 0) continue
      reserveUniqueConstraint(identity, desiredColumn.identifier.spelling)

      steps.push({
        kind: 'add_unique_constraint',
        target: {
          kind: 'column',
          relation: identity,
          column: desiredColumn.identifier,
        },
      })
    }
  }

  if (live.foreignKeys !== undefined) {
    for (const desiredColumn of desired.columns) {
      if (
        !desiredColumn.reference ||
        !liveColumns.has(desiredColumn.identifier.comparisonKey)
      )
        continue
      const expected = canonicalDesiredForeignKey(desiredColumn)
      const matches = matchForeignKeys(live.foreignKeys, expected, identities)
      if (matches.length !== 0) continue

      reserveForeignKey(
        identity,
        desiredColumn.identifier.spelling,
        desiredColumn.reference,
      )

      deferredForeignKeys.push({
        kind: 'add_foreign_key',
        target: {
          kind: 'column',
          relation: identity,
          column: desiredColumn.identifier,
        },
        references: structuredReference(desiredColumn.reference),
      })
    }
  }
}

/** Adds drops for catalog columns outside a complete desired relation shape. */
function appendDroppedColumns(
  live: CatalogTable,
  desired: LoweredDesiredTable,
  shape: 'complete' | 'additive',
  identity: CanonicalRelationIdentity,
  steps: MigrationStep[],
  identities: CanonicalRelationIdentityModule,
): void {
  if (shape !== 'complete') return

  const desiredNames = new Set(
    desired.columns.map((column) => column.identifier.comparisonKey),
  )

  for (const liveColumn of live.columns ?? []) {
    if (desiredNames.has(identities.member('column', liveColumn.name).comparisonKey)) {
      continue
    }

    steps.push({
      kind: 'drop_column',
      target: columnTarget(identity, liveColumn.name, identities),
    })
  }
}

/** Reconciles columns and their column-owned constraints for one existing relation. */
function reconcileExistingColumns({
  live,
  desired,
  identity,
  shape,
  steps,
  deferredForeignKeys,
  planning,
  identities,
  reserveForeignKey,
  reserveUniqueConstraint,
}: ExistingColumnReconciliation): void {
  const liveColumns = new Map(
    (live.columns ?? []).map((column) => [
      identities.member('column', column.name).comparisonKey,
      column,
    ]),
  )

  for (const desiredColumn of desired.columns) {
    const current = liveColumns.get(desiredColumn.identifier.comparisonKey)

    if (!current) {
      if (desiredColumn.reference) {
        reserveForeignKey(
          identity,
          desiredColumn.identifier.spelling,
          desiredColumn.reference,
        )

        deferredForeignKeys.push({
          kind: 'add_foreign_key',
          target: {
            kind: 'column',
            relation: identity,
            column: desiredColumn.identifier,
          },
          references: structuredReference(desiredColumn.reference),
        })
      }

      steps.push({
        kind: 'add_column',
        target: {
          kind: 'column',
          relation: identity,
          column: desiredColumn.identifier,
        },
        dataType: desiredColumn.dataType,
        notNull: desiredColumn.notNull,
        ...(desiredColumn.unique ? { unique: true } : {}),
        ...(desiredColumn.defaultValue !== undefined
          ? { defaultValue: desiredColumn.defaultValue }
          : {}),
        ...(desiredColumn.databaseDefault !== undefined
          ? { databaseDefault: desiredColumn.databaseDefault }
          : {}),
        ...(desiredColumn.generated ? { generated: desiredColumn.generated } : {}),
        ...(desiredColumn.autoIncrement ? { autoIncrement: true } : {}),
      })

      if (desiredColumn.unique) {
        reserveUniqueConstraint(identity, desiredColumn.identifier.spelling)
      }

      continue
    }

    const columnLabel = identities.format(identity, {
      role: 'column',
      spelling: desiredColumn.identifier.spelling,
    })

    if (current.dataType === undefined) {
      throw new MigrationError({
        message: `Cannot plan desired-table column ${columnLabel}: catalog data type is unresolved`,
      })
    }

    if (current.isNullable === undefined) {
      throw new MigrationError({
        message: `Cannot plan desired-table column ${columnLabel}: catalog nullability is unresolved`,
      })
    }

    const desiredType = planning.schema.normalizeDataType(desiredColumn.dataType)
    const currentType = planning.schema.normalizeDataType(current.dataType)

    if (desiredType !== currentType) {
      steps.push({
        kind: 'alter_column_type',
        target: {
          kind: 'column',
          relation: identity,
          column: desiredColumn.identifier,
        },
        dataType: desiredColumn.dataType,
      })
    }

    if (desiredColumn.notNull && current.isNullable) {
      steps.push({
        kind: 'set_not_null',
        target: {
          kind: 'column',
          relation: identity,
          column: desiredColumn.identifier,
        },
      })
    } else if (!desiredColumn.notNull && !current.isNullable) {
      steps.push({
        kind: 'drop_not_null',
        target: {
          kind: 'column',
          relation: identity,
          column: desiredColumn.identifier,
        },
      })
    }
  }

  appendDroppedColumns(live, desired, shape, identity, steps, identities)

  appendMissingColumnConstraints({
    live,
    desired,
    identity,
    steps,
    deferredForeignKeys,
    identities,
    reserveForeignKey,
    reserveUniqueConstraint,
    liveColumns,
  })
}

type DroppedTablePlanning = Readonly<{
  catalogTables: readonly CatalogTable[]
  registered: CanonicalRelationRegistry<TableHandle>
  ownership: ReturnType<typeof resolveMigrationOwnership>
  steps: MigrationStep[]
  issues: PlanningIssue[]
  identities: CanonicalRelationIdentityModule
}>

/** Adds drops for owned catalog relations absent from the desired schema. */
function appendDroppedTables({
  catalogTables,
  registered,
  ownership,
  steps,
  issues,
  identities,
}: DroppedTablePlanning): void {
  for (const live of catalogTables) {
    const identity = live.identity
    if (registered.has(identity)) continue

    if (!ownership.isAbsent(identity) && !ownership.ownsNamespace(identity.namespace)) {
      continue
    }

    if (live.opaqueObjects.length > 0) {
      issues.push({
        identity,
        target: '',
        property: 'opaque_catalog_object',
        message: `Cannot drop '${identities.format(identity)}' while it contains opaque catalog objects: ${live.opaqueObjects.join(', ')}`,
      })

      continue
    }

    steps.push({ kind: 'drop_table', target: relationTarget(identity) })
  }
}

type CreatedTablePlanning = Readonly<{
  name: string
  desired: LoweredDesiredTable
  indexes: readonly DesiredIndex[]
  identity: CanonicalRelationIdentity
  ensuredNamespaces: Array<readonly CanonicalNamespaceSegment[]>
  steps: MigrationStep[]
  deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[]
  physicalNames: ReturnType<DialectNaming['createRegistry']>
  naming: DialectNaming
  identities: CanonicalRelationIdentityModule
  reserveForeignKey: (
    owner: CanonicalRelationIdentity,
    column: string,
    reference: NonNullable<LoweredDesiredColumn['reference']>,
  ) => void
  reserveUniqueConstraint: (owner: CanonicalRelationIdentity, column: string) => void
}>

/** Adds all steps and physical-name reservations for one absent desired relation. */
function appendCreatedTable({
  name,
  desired,
  indexes,
  identity,
  ensuredNamespaces,
  steps,
  deferredForeignKeys,
  physicalNames,
  naming,
  identities,
  reserveForeignKey,
  reserveUniqueConstraint,
}: CreatedTablePlanning): void {
  if (
    !ensuredNamespaces.some((existing) => sameNamespace(existing, identity.namespace))
  ) {
    steps.push({
      kind: 'ensure_namespace',
      target: { kind: 'namespace', namespace: identity.namespace },
    })

    ensuredNamespaces.push(identity.namespace)
  }

  steps.push({ kind: 'create_table', target: relationTarget(identity) })

  physicalNames.reserve({
    kind: 'relation',
    owner: identity,
    name,
    token: `relation:${identities.format(identity)}`,
    description: `desired relation ${identities.format(identity)}`,
  })

  const primaryKeyName = naming.generate({
    kind: 'primaryKey',
    owner: identity,
    columns: desired.primaryKey.map((column) => column.spelling),
  })
  const primaryKeyToken = `generated-primary-key:${identities.format(identity)}:${JSON.stringify(desired.primaryKey.map((column) => column.comparisonKey))}`
  const primaryKeyDescription = `generated primary key on ${identities.format(identity)}`
  physicalNames.reserve({
    kind: 'primaryKey',
    owner: identity,
    name: primaryKeyName,
    token: primaryKeyToken,
    description: primaryKeyDescription,
  })

  physicalNames.reserve({
    kind: 'check',
    owner: identity,
    name: primaryKeyName,
    token: primaryKeyToken,
    description: primaryKeyDescription,
  })

  for (const column of desired.columns.filter((column) => column.unique)) {
    reserveUniqueConstraint(identity, column.identifier.spelling)
  }

  for (const index of indexes) {
    physicalNames.reserve({
      kind: 'index',
      owner: identity,
      name: index.name.spelling,
      token: `${index.origin}-index:${identities.format(identity)}:${JSON.stringify(index.columns.map((column) => column.comparisonKey))}:${index.unique}`,
      description: `${index.origin} index ${JSON.stringify(index.name.spelling)}`,
    })

    steps.push({
      kind: 'create_index',
      target: { kind: 'index', relation: identity, index: index.name },
      columns: index.columns,
      unique: index.unique,
    })
  }

  for (const column of desired.columns) {
    if (!column.reference) continue
    reserveForeignKey(identity, column.identifier.spelling, column.reference)

    deferredForeignKeys.push({
      kind: 'add_foreign_key',
      target: { kind: 'column', relation: identity, column: column.identifier },
      references: structuredReference(column.reference),
    })
  }
}

type DesiredTablePreparation = Readonly<{
  handle: TableHandle
  registered: CanonicalRelationRegistry<TableHandle>
  existing: CanonicalRelationRegistry<CatalogTable>
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>
  ownership: ReturnType<typeof resolveMigrationOwnership>
  issues: PlanningIssue[]
  naming: DialectNaming
  identities: CanonicalRelationIdentityModule
}>

type PreparedDesiredTable = Readonly<{
  info: ReturnType<TableHandle['getTableMetadata']>
  identity: CanonicalRelationIdentity
  live: CatalogTable | undefined
  desired: LoweredDesiredTable
  indexes: readonly DesiredIndex[]
  shape: 'complete' | 'additive'
}>

/** Resolves and validates one desired relation before plan steps are produced. */
function prepareDesiredTable({
  handle,
  registered,
  existing,
  desiredTables,
  ownership,
  issues,
  naming,
  identities,
}: DesiredTablePreparation): PreparedDesiredTable | undefined {
  const info = handle.getTableMetadata()
  const identity = identities.resolve(info.relation)

  if (registered.has(identity)) {
    issues.push({
      identity,
      target: '',
      property: 'duplicate_registered_table',
      message: `Duplicate registered table ${identities.format(identity)}`,
    })
  }

  registered.set(identity, handle)
  const desired = desiredTables.get(identity)

  if (!desired) {
    issues.push({
      identity,
      target: '',
      property: 'invalid_desired_table',
      message: `Invalid desired table ${identities.format(identity)}`,
    })

    return undefined
  }

  validateCanonicalRelationNames(identity, naming)

  for (const column of desired.columns) {
    naming.validate(column.identifier.spelling, 'column name')

    if (column.reference) {
      validateCanonicalRelationNames(column.reference.relation, naming)
      naming.validate(column.reference.column.spelling, 'referenced column name')
    }
  }

  const indexes = desiredIndexes(info, identity, naming, identities)

  for (let index = 1; index < indexes.length; index++) {
    const previous = indexes[index - 1]!
    const current = indexes[index]!
    if (previous.name.comparisonKey !== current.name.comparisonKey) continue
    throw new MigrationError({
      message: `Duplicate desired indexes ${identities.format(identity, {
        role: 'index',
        spelling: previous.name.spelling,
      })} and ${identities.format(identity, {
        role: 'index',
        spelling: current.name.spelling,
      })}`,
    })
  }

  for (const index of indexes) {
    if (index.origin === 'explicit') {
      naming.validate(index.name.spelling, 'explicit index name')
    }
  }

  return {
    info,
    identity,
    live: existing.get(identity),
    desired,
    indexes,
    shape: ownership.relationShape(identity) ?? 'complete',
  }
}

/** Adds missing namespace steps for every completely owned namespace. */
function appendOwnedNamespaces(
  ownership: ReturnType<typeof resolveMigrationOwnership>,
  ensuredNamespaces: Array<readonly CanonicalNamespaceSegment[]>,
  steps: MigrationStep[],
): void {
  for (const namespace of ownership.completeNamespaces) {
    if (ensuredNamespaces.some((existing) => sameNamespace(existing, namespace))) {
      continue
    }

    steps.push({ kind: 'ensure_namespace', target: { kind: 'namespace', namespace } })
    ensuredNamespaces.push(namespace)
  }
}

/**
 * Reconciles desired tables with an introspected catalog into one canonical plan.
 *
 * @param schemas - Registered desired table handles.
 * @param catalog - Introspected catalog snapshot and namespace context.
 * @param planning - Selected member's bound planning semantics.
 * @param registrationDefault - Optional namespace for registrations that omit one.
 * @param ownershipDeclarations - Explicit relation and namespace authority declarations.
 */
function buildMigrationPlan(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  planning: MigrationPlanningContext,
  registrationDefault?: readonly NamespaceIdentifierInput[],
  ownershipDeclarations: readonly MigrationOwnershipDeclaration[] = [],
): PlannedMigration {
  const identities = planning.identity.create({
    context: catalog.namespaceContext,
    ...(registrationDefault === undefined ? {} : { registrationDefault }),
  })
  const steps: MigrationStep[] = []
  const deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[] = []
  const issues: PlanningIssue[] = []
  const sortedSchemas = [...schemas].sort((left, right) =>
    compareTableHandles(left, right, identities),
  )
  const naming = planning.naming

  validateDesiredNames(sortedSchemas, identities, naming)

  const lowered = lowerDesiredSchema(sortedSchemas, identities, planning.schema)
  const desiredTables = identities.createRegistry<LoweredDesiredTable>()
  for (const table of lowered.tables) desiredTables.set(table.identity, table)
  const ownership = resolveMigrationOwnership(schemas, ownershipDeclarations, identities)
  const planningCatalog = catalogForPlanning(
    catalog,
    identities,
    desiredTables,
    lowered.tables.map(({ identity }) => identity),
    ownership,
  )
  const sortedCatalogTables = [...planningCatalog.tables].sort((left, right) =>
    compareCatalogTables(left, right, identities),
  )
  const existing = catalogTableMap(sortedCatalogTables, issues, identities)
  const ensuredSchemas = [...planningCatalog.namespaces]
  const registered = identities.createRegistry<TableHandle>()
  const physicalNames = naming.createRegistry()
  const representedCatalogNames = new Set<string>()

  validateOwnershipNames(ownership, naming)

  for (const table of sortedCatalogTables) {
    const identity = table.identity
    const namespace = identity.namespace
    const relationToken = `relation:${identities.format(identity)}`
    physicalNames.reserve({
      kind: 'relation',
      owner: identity,
      name: identity.relation.spelling,
      token: relationToken,
      description: `catalog relation ${identities.format(identity)}`,
    })

    representedCatalogNames.add(namespaceNameKey(namespace, identity.relation.spelling))

    reserveCatalogIndexes(
      table.indexes ?? [],
      identity,
      identities,
      physicalNames,
      representedCatalogNames,
    )

    if (table.primaryKey) {
      const backingToken = `catalog:${namespaceNameKey(namespace, table.primaryKey.name)}`
      const constraintToken = `catalog-constraint:${identities.format(identity)}:${table.primaryKey.name}`

      physicalNames.reserve({
        kind: 'primaryKey',
        owner: identity,
        name: table.primaryKey.name,
        token: backingToken,
        description: `catalog primary key ${JSON.stringify(table.primaryKey.name)}`,
      })

      physicalNames.reserve({
        kind: 'check',
        owner: identity,
        name: table.primaryKey.name,
        token: constraintToken,
        description: `catalog primary key ${JSON.stringify(table.primaryKey.name)}`,
      })

      representedCatalogNames.add(namespaceNameKey(namespace, table.primaryKey.name))
    }

    for (const constraint of table.uniqueConstraints ?? []) {
      const backingToken = `catalog:${namespaceNameKey(namespace, constraint.name)}`
      const constraintToken = `catalog-constraint:${identities.format(identity)}:${constraint.name}`

      physicalNames.reserve({
        kind: 'unique',
        owner: identity,
        name: constraint.name,
        token: backingToken,
        description: `catalog unique constraint ${JSON.stringify(constraint.name)}`,
      })

      physicalNames.reserve({
        kind: 'check',
        owner: identity,
        name: constraint.name,
        token: constraintToken,
        description: `catalog unique constraint ${JSON.stringify(constraint.name)}`,
      })

      representedCatalogNames.add(namespaceNameKey(namespace, constraint.name))
    }

    for (const constraint of table.foreignKeys ?? []) {
      physicalNames.reserve({
        kind: 'foreignKey',
        owner: identity,
        name: constraint.name,
        token: `catalog-constraint:${identities.format(identity)}:${constraint.name}`,
        description: `catalog foreign key ${JSON.stringify(constraint.name)}`,
      })
    }
  }

  for (const reservation of planningCatalog.nameReservations) {
    if (
      representedCatalogNames.has(
        namespaceNameKey(reservation.namespace, reservation.name),
      )
    ) {
      continue
    }

    if (reservation.namespace.length === 0) {
      throw new MigrationError({
        message: `Catalog name reservation ${JSON.stringify(reservation.name)} is missing its namespace`,
      })
    }

    // A reserved name occupies its namespace's relation scope, whatever object it is.
    const owner = identities.resolve({
      namespace: reservation.namespace.map(({ role, identifier }) => ({
        role,
        spelling: identifier.spelling,
      })),
      relation: reservation.name,
    })
    physicalNames.reserve({
      kind: 'relation',
      owner,
      name: reservation.name,
      token: `catalog:${namespaceNameKey(reservation.namespace, reservation.name)}`,
      description: `catalog object ${JSON.stringify(reservation.name)}`,
    })
  }

  for (const reservation of planningCatalog.constraintNameReservations) {
    const owner = reservation.relation
    physicalNames.reserve({
      kind: 'check',
      owner,
      name: reservation.name,
      token: `catalog-constraint:${identities.format(owner)}:${reservation.name}`,
      description: `catalog constraint ${JSON.stringify(reservation.name)}`,
    })
  }

  appendOwnedNamespaces(ownership, ensuredSchemas, steps)

  /**
   * Reserves the deterministic physical name for a desired foreign key.
   *
   * @param owner - Canonical identity of the referencing table.
   * @param column - Referencing column name.
   * @param reference - Desired foreign-key target and actions.
   */
  const reserveForeignKey = (
    owner: CanonicalRelationIdentity,
    column: string,
    reference: NonNullable<LoweredDesiredColumn['reference']>,
  ) => {
    const referenced = reference.relation
    const name = naming.generate({
      kind: 'foreignKey',
      owner,
      columns: [column],
      referencedRelation: referenced,
      referencedColumns: [reference.column.spelling],
      onDelete: normalizeAction(reference.onDelete),
      onUpdate: normalizeAction(reference.onUpdate),
    })
    physicalNames.reserve({
      kind: 'foreignKey',
      owner,
      name,
      token: `generated-foreign-key:${identities.format(owner)}:${column}:${identities.format(referenced)}:${reference.column.comparisonKey}:${normalizeAction(reference.onDelete)}:${normalizeAction(reference.onUpdate)}`,
      description: `generated foreign key on ${identities.format(owner, {
        role: 'column',
        spelling: column,
      })}`,
    })
  }

  /**
   * Reserves the deterministic names used by a desired unique constraint.
   *
   * @param owner - Canonical identity of the constrained table.
   * @param column - Unique column name.
   */
  const reserveUniqueConstraint = (owner: CanonicalRelationIdentity, column: string) => {
    const name = naming.generate({ kind: 'unique', owner, columns: [column] })
    const token = `generated-unique:${identities.format(owner)}:${column}`
    const description = `generated unique constraint on ${identities.format(owner, {
      role: 'column',
      spelling: column,
    })}`
    physicalNames.reserve({
      kind: 'unique',
      owner,
      name,
      token,
      description,
    })

    physicalNames.reserve({
      kind: 'check',
      owner,
      name,
      token,
      description,
    })
  }

  for (const handle of sortedSchemas) {
    const prepared = prepareDesiredTable({
      handle,
      registered,
      existing,
      desiredTables,
      ownership,
      issues,
      naming,
      identities,
    })
    if (!prepared) continue
    const { info, identity, live, desired: createAst, indexes, shape } = prepared

    if (!live) {
      appendCreatedTable({
        name: info.name,
        desired: createAst,
        indexes,
        identity,
        ensuredNamespaces: ensuredSchemas,
        steps,
        deferredForeignKeys,
        physicalNames,
        naming,
        identities,
        reserveForeignKey,
        reserveUniqueConstraint,
      })

      continue
    }

    // This window contains only this relation's steps; deferred foreign keys follow the loop.
    const relationStepStart = steps.length
    collectManagedPropertyIssues(live, createAst, shape, planning, issues, identities)

    reconcileExistingColumns({
      live,
      desired: createAst,
      identity,
      shape,
      steps,
      deferredForeignKeys,
      planning,
      identities,
      reserveForeignKey,
      reserveUniqueConstraint,
    })

    reconcileIndexes({
      live,
      desired: indexes,
      identity,
      shape,
      relationStepStart,
      steps,
      issues,
      identities,
      physicalNames,
    })
  }

  steps.push(...deferredForeignKeys)

  appendDroppedTables({
    catalogTables: sortedCatalogTables,
    registered,
    ownership,
    steps,
    issues,
    identities,
  })

  const issue = issues.sort((left, right) =>
    comparePlanningIssues(left, right, identities),
  )[0]
  if (issue) throw new MigrationError({ message: issue.message })

  return {
    plan: { steps: steps.sort(compareMigrationSteps) },
    profile: {
      identityAdapter: planning.identity.id,
      namespaceContext: catalog.namespaceContext,
      ...(registrationDefault === undefined ? {} : { registrationDefault }),
    },
    identities,
    desiredTables,
    planningCatalog,
  }
}

/**
 * Constructs a Migration Plan from registered tables and a catalog snapshot.
 * This interface is synchronous and performs no database operations.
 *
 * @example
 *   const planning = selectedMigration.planning
 *   const { plan } = planMigration([Users], observedCatalog, planning)
 *
 * @param schemas - Registered desired table handles.
 * @param catalog - Introspected catalog snapshot and namespace context.
 * @param planning - Selected member's bound planning semantics.
 * @param options - Migration registration options.
 * @param options.registrationDefault - Namespace for registrations that omit one.
 * @param options.migrationOwnership - Explicit relation/namespace authority declarations.
 *
 * @returns The semantic plan and its reusable identity and lowered-table registries.
 *
 * @throws {MigrationError} When identity resolution, desired lowering, or reconciliation
 *   fails, including unsupported schema drift.
 */
export function planMigration(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  planning: MigrationPlanningContext,
  options: {
    registrationDefault?: readonly NamespaceIdentifierInput[]
    migrationOwnership?: readonly MigrationOwnershipDeclaration[]
  } = {},
): PlannedMigration {
  try {
    return buildMigrationPlan(
      schemas,
      catalog,
      planning,
      options.registrationDefault,
      options.migrationOwnership ?? [],
    )
  } catch (cause) {
    if (cause instanceof MigrationError) throw cause
    throw new MigrationError({
      message: cause instanceof Error ? cause.message : 'Migration planning failed',
      ...(cause !== undefined ? { cause } : {}),
    })
  }
}
