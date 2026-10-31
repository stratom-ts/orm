import type {
  CatalogSnapshot,
  DialectIdentity,
  DialectNaming,
  DialectSchema,
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
import type {
  MigrationOwnershipDeclaration,
  ResolvedMigrationOwnership,
} from '@/migrations/migrationOwnership'
import {
  MigrationOwnershipSchemaError,
  resolveMigrationOwnership,
} from '@/migrations/migrationOwnership'
import type { PhysicalNameRegistry, PhysicalNameSeed } from '@/migrations/physicalNaming'
import { getReferenceMetadata } from '@/schemas/actions/reference'
import type { TableHandle } from '@/types'
import type { AnySchema } from '@/types/schema'
import { MigrationError, isErrorTag } from '@/utils/error'

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
    /**
     * Resolves authored column storage into the selected dialect's desired-schema
     * representation.
     *
     * @param graph - Registered authored tables and their resolved reference graph.
     *
     * @returns Desired tables with dialect-specific physical storage and resolved
     *   references.
     */
    lowerDesiredSchema: DialectSchema['lowerDesiredSchema']
    /**
     * Normalizes physical SQL type spelling for stable schema comparison.
     *
     * @param dataType - Physical SQL type used for validation, comparison, or value
     *   mapping.
     *
     * @returns The normalized type spelling used for storage equality.
     */
    normalizeDataType(dataType: string): string
    normalizeDefaultValue?: (value: string | number | boolean | null) => string
  }>
}>

type PlanningIssue = {
  identity: CanonicalRelationIdentity
  target: string
  property:
    | 'identifier'
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
  cause?: unknown
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
  // Relation and member order come first. Identifier failures precede all other
  // properties of the same target because that target cannot be addressed safely.
  identifier: -1,
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
 * Collects only recognized naming failures. Invalid members stay internal until issue
 * selection.
 */
class RankedNames {
  constructor(
    readonly originalIdentity: CanonicalRelationIdentityModule,
    readonly original: DialectNaming,
    readonly issues: PlanningIssue[],
    readonly defaultNamespace: readonly NamespaceIdentifierInput[],
  ) {}

  record(
    identity: CanonicalRelationIdentity,
    target: string,
    description: string,
    cause: unknown,
  ) {
    if (!isErrorTag(cause, 'SchemaError')) throw cause

    this.issues.push({
      identity,
      target,
      property: 'identifier',
      message: `Cannot address ${description} of ${this.originalIdentity.format(identity)}: ${cause.message}`,
      cause,
    })
  }

  validate(
    identity: CanonicalRelationIdentity,
    name: string,
    description: string,
    target = name,
  ) {
    try {
      this.original.validate(name, description)
    } catch (cause) {
      this.record(identity, target, `${description} ${JSON.stringify(name)}`, cause)
    }
  }

  resolve = (
    input: Parameters<CanonicalRelationIdentityModule['resolve']>[0],
  ): CanonicalRelationIdentity => {
    try {
      return this.originalIdentity.resolve(input)
    } catch (cause) {
      if (!isErrorTag(cause, 'SchemaError')) throw cause

      return this.rejectedRelation(input)
    }
  }

  rejectedRelation(
    input: Parameters<CanonicalRelationIdentityModule['resolve']>[0],
    namespaceOnly = false,
  ): CanonicalRelationIdentity {
    const rejected: { spelling: string; role: string; cause: unknown }[] = []
    const safe = (spelling: string, role: string) => {
      try {
        this.originalIdentity.member('namespace', spelling)
        return spelling
      } catch (cause) {
        if (!isErrorTag(cause, 'SchemaError')) throw cause

        rejected.push({ spelling, role, cause })
        return '__stratom_rejected_identifier__'
      }
    }

    const namespace = (input.namespace ?? this.defaultNamespace).map((segment) => ({
      role: segment.role,
      spelling: safe(segment.spelling, segment.role),
    }))

    const relation = safe(input.relation, 'relation')
    const resolved = this.originalIdentity.resolve({ namespace, relation })

    const restore = (role: string, identifier: CanonicalIdentifier) => {
      const invalid = rejected.find((entry) => entry.role === role)
      return invalid
        ? { spelling: invalid.spelling, comparisonKey: invalid.spelling }
        : identifier
    }

    const identity = {
      namespace: resolved.namespace.map((segment) => ({
        ...segment,
        identifier: restore(segment.role, segment.identifier),
      })),
      relation: namespaceOnly
        ? { spelling: '', comparisonKey: '' }
        : restore('relation', resolved.relation),
    }

    for (const entry of rejected)
      this.record(
        identity,
        '',
        `${entry.role} ${JSON.stringify(entry.spelling)}`,
        entry.cause,
      )
    return identity
  }

  get identities(): CanonicalRelationIdentityModule {
    return {
      ...this.originalIdentity,
      resolve: this.resolve,
      resolveNamespace: (namespace) => {
        try {
          return this.originalIdentity.resolveNamespace(namespace)
        } catch (cause) {
          if (!isErrorTag(cause, 'SchemaError')) throw cause

          return this.rejectedRelation(
            { namespace: namespace ?? this.defaultNamespace, relation: '__namespace__' },
            true,
          ).namespace
        }
      },
    }
  }

  get naming(): DialectNaming {
    return {
      ...this.original,
      generate: (seed) => this.generate(seed),
      createRegistry: () => this.createRegistry(),
    }
  }

  generate(seed: PhysicalNameSeed): string {
    try {
      const name = this.original.generate(seed)
      this.validate(seed.owner, name, `generated ${seed.kind} name`, this.targetKey(name))
      return name
    } catch (cause) {
      this.record(seed.owner, '', `generated ${seed.kind} name`, cause)
      return ''
    }
  }

  createRegistry(): PhysicalNameRegistry {
    const registry = this.original.createRegistry()
    return {
      reserve: (options) => {
        try {
          registry.reserve(options)
        } catch (cause) {
          this.record(
            options.owner,
            options.kind === 'relation' ? '' : this.targetKey(options.name),
            `${options.description} ${JSON.stringify(options.name)}`,
            cause,
          )
        }
      },
    }
  }

  namingFor(identity: CanonicalRelationIdentity): DialectNaming {
    return {
      ...this.naming,
      validate: (name, description) => {
        const relationTarget = description.endsWith('identifier')
        this.validate(
          identity,
          name,
          description,
          relationTarget ? '' : this.targetKey(name),
        )
      },
    }
  }

  targetKey(spelling: string): string {
    try {
      return this.originalIdentity.member('namespace', spelling).comparisonKey
    } catch (cause) {
      if (!isErrorTag(cause, 'SchemaError')) throw cause

      return spelling
    }
  }

  identitiesFor = (
    identity: CanonicalRelationIdentity,
  ): CanonicalRelationIdentityModule => {
    return {
      ...this.identities,
      member: (role, spelling) => {
        try {
          const identifier = this.originalIdentity.member(role, spelling)
          this.validate(identity, spelling, role, identifier.comparisonKey)
          return identifier
        } catch (cause) {
          this.record(identity, spelling, `${role} ${JSON.stringify(spelling)}`, cause)

          // Rejected ordering keys stay internal. Final issue selection prevents a plan.
          return { spelling, comparisonKey: spelling }
        }
      },
    }
  }
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
 * @param naming - Physical-name generation, validation, and uniqueness rules.
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
 * @param naming - Physical-name generation, validation, and uniqueness rules.
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
 *
 * @returns Desired foreign-key semantics with canonical target and member identifiers.
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
  const identity = live.identity
  const expected = desired.columns.filter(
    (column) => column.unique && liveColumns.has(column.identifier.comparisonKey),
  )

  const matched = new Set<CatalogKeyConstraint>()

  matchDesiredUniqueConstraints({ expected, live, identities, issues, identity, matched })

  if (
    shape === 'complete' &&
    live.uniqueConstraints.some(
      (constraint) =>
        !matched.has(constraint) &&
        constraintColumnsRetained(constraint, desired, identities),
    )
  ) {
    issues.push({
      identity,
      target: '',
      property: 'unique_constraint',
      message: `Unsupported removal of extra unique constraints for '${identities.format(identity)}'`,
    })
  }
}

/**
 * Matches desired unique keys and records unsupported changes to existing keys.
 *
 * @param input - Desired unique constraint matching inputs and shared accumulators.
 */
function matchDesiredUniqueConstraints(input: DesiredUniqueConstraintMatching) {
  const { expected, live, identities, issues, identity, matched } = input

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
    const match = matches.at(0)

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

  matchDesiredForeignKeys(
    expected,
    live,
    identities,
    issues,
    identity,
    tableName,
    matched,
  )

  if (
    shape === 'complete' &&
    live.foreignKeys.some(
      (foreignKey) =>
        !matched.has(foreignKey) &&
        constraintColumnsRetained(foreignKey, desired, identities),
    )
  ) {
    issues.push({
      identity,
      target: '',
      property: 'foreign_key',
      message: `Unsupported removal of extra foreign keys for '${tableName}'`,
    })
  }
}

/** Tests whether a constraint survives the column drops of a complete desired shape. */
function constraintColumnsRetained(
  constraint: CatalogKeyConstraint,
  desired: LoweredDesiredTable,
  identities: CanonicalRelationIdentityModule,
): boolean {
  return constraint.columns.every((name) =>
    desired.columns.some(
      (column) =>
        column.identifier.comparisonKey ===
        identities.member('column', name).comparisonKey,
    ),
  )
}

/**
 * Matches existing foreign keys and records ambiguous or unsupported reference changes.
 *
 * @param expected - Expected profile, evidence, or result used by the current check.
 * @param live - Observed table or index definition to compare with desired metadata.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param tableName - Authored table spelling used in validation diagnostics.
 * @param matched - Observed constraints already matched to desired semantics.
 */
function matchDesiredForeignKeys(
  expected: CanonicalForeignKey[],
  live: CatalogTable,
  identities: CanonicalRelationIdentityModule,
  issues: PlanningIssue[],
  identity: CanonicalRelationIdentity,
  tableName: string,
  matched: Set<CatalogForeignKey>,
) {
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
    const match = matches.at(0)

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
  const liveColumns = collectLiveColumnNames(live, identity, identities, issues)

  collectColumnPropertyIssues(
    desired,
    liveColumns,
    identities,
    identity,
    planning,
    issues,
  )

  collectPrimaryKeyIssues(live, identities, desired, issues, identity, tableName)

  collectOwnedConstraintIssues(live, desired, shape, issues, identities, liveColumns)
}

/**
 * Indexes observed columns by canonical identity and reports duplicate names.
 *
 * @param live - Observed table or index definition to compare with desired metadata.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 *
 * @returns Observed columns indexed by canonical identity, with duplicate-name issues
 *   retained.
 */
function collectLiveColumnNames(
  live: CatalogTable,
  identity: CanonicalRelationIdentity,
  identities: CanonicalRelationIdentityModule,
  issues: PlanningIssue[],
) {
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

  return liveColumns
}

/**
 * Validates constraints according to the relation's complete or additive ownership shape.
 *
 * @param live - Observed table or index definition to compare with desired metadata.
 * @param desired - Lowered desired table or schema metadata used for comparison.
 * @param shape - Complete or additive relation ownership that controls removal of extra
 *   catalog members.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param liveColumns - Observed columns indexed by canonical comparison key.
 */
function collectOwnedConstraintIssues(
  live: CatalogTable,
  desired: LoweredDesiredTable,
  shape: 'complete' | 'additive',
  issues: PlanningIssue[],
  identities: CanonicalRelationIdentityModule,
  liveColumns: Map<string, CatalogColumn>,
) {
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
 * Reports unsupported changes to an observed primary key.
 *
 * @param live - Observed table or index definition to compare with desired metadata.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param desired - Lowered desired table or schema metadata used for comparison.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param tableName - Authored table spelling used in validation diagnostics.
 */
function collectPrimaryKeyIssues(
  live: CatalogTable,
  identities: CanonicalRelationIdentityModule,
  desired: LoweredDesiredTable,
  issues: PlanningIssue[],
  identity: CanonicalRelationIdentity,
  tableName: string,
) {
  if (live.primaryKey !== null) {
    const current = live.primaryKey.columns

    if (
      !hasSupportedCatalogSemantics(live.primaryKey) ||
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
}

/**
 * Checks managed column defaults, generation, and opaque properties for unsupported
 * drift.
 */
function collectColumnPropertyIssues(
  desired: LoweredDesiredTable,
  liveColumns: Map<string, CatalogColumn>,
  identities: CanonicalRelationIdentityModule,
  identity: CanonicalRelationIdentity,
  planning: MigrationPlanningContext,
  issues: PlanningIssue[],
) {
  for (const column of desired.columns) {
    const current = liveColumns.get(column.identifier.comparisonKey)

    if (!current) continue

    collectExistingColumnIssues(identities, identity, column, current, planning, issues)
  }
}

/**
 * Adds deterministic issues for properties that the planner cannot change safely.
 *
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param column - Authored or observed column metadata used for storage comparison.
 * @param current - Existing definition or resolved properties being compared with desired
 *   metadata.
 * @param planning - Selected identity, naming, and schema semantics for Migration Plan
 *   construction.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 */
function collectExistingColumnIssues(
  identities: CanonicalRelationIdentityModule,
  identity: CanonicalRelationIdentity,
  column: LoweredDesiredColumn,
  current: CatalogColumn,
  planning: MigrationPlanningContext,
  issues: PlanningIssue[],
) {
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
    if (!isErrorTag(cause, 'SchemaError')) throw cause

    throw new MigrationError({
      message: `Cannot address ${role} ${JSON.stringify(spelling)} of ${identities.format(
        relation,
      )}: ${cause.message}`,
      cause,
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
): {
  name: CanonicalIdentifier
  columns: CanonicalIdentifier[]
  unique: boolean
  origin: 'explicit' | 'generated'
}[] {
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
  /** Full observed facts retained for dialect lowering and preservation checks. */
  catalogSnapshot: CatalogSnapshot
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

  const ordered = live.indexes
    .map((liveIndex) => ({
      liveIndex,
      identifier: memberIdentifier(identity, 'index', liveIndex.name, identities),
    }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.identifier.comparisonKey, right.identifier.comparisonKey) ||
        compareCodeUnits(left.identifier.spelling, right.identifier.spelling),
    )

  registerCatalogIndexes({
    ordered,
    indexes,
    issues,
    identity,
    identities,
    shape,
    unsupportedNames,
  })

  return { indexes, unsupportedNames }
}

/**
 * Reserves observed index names and reports duplicate or unsupported index definitions.
 *
 * @param input - Catalog index registration inputs and shared accumulators.
 */
function registerCatalogIndexes(input: CatalogIndexRegistration) {
  const { ordered, indexes, issues, identity, identities, shape, unsupportedNames } =
    input

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

  /** Compares one desired index and appends its required Migration Plan steps. */
  const reconcileIndex = (index: (typeof desired)[number]) =>
    reconcileDesiredIndex({
      index,
      liveIndexes,
      identities,
      issues,
      identity,
      physicalNames,
      steps,
      claimedLiveIndexNames,
      unsupportedLiveIndexNames,
    })

  for (const index of desired) reconcileIndex(index)

  reconcileUnclaimedIndexes(
    shape,
    live,
    claimedLiveIndexNames,
    identities,
    steps,
    identity,
    relationStepStart,
    issues,
  )
}

/**
 * Drops unclaimed indexes only when complete ownership permits their removal.
 *
 * @param shape - Complete or additive relation ownership that controls removal of extra
 *   catalog members.
 * @param live - Observed table or index definition to compare with desired metadata.
 * @param claimedLiveIndexNames - Observed index names already matched to desired indexes.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param steps - Mutable Migration Plan steps accumulated before canonical ordering.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param relationStepStart - First planned step index for the current relation.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 */
function reconcileUnclaimedIndexes(
  shape: string,
  live: CatalogTable,
  claimedLiveIndexNames: Set<string>,
  identities: CanonicalRelationIdentityModule,
  steps: MigrationStep[],
  identity: CanonicalRelationIdentity,
  relationStepStart: number,
  issues: PlanningIssue[],
) {
  if (shape === 'complete') {
    const unclaimedIndexes = live.indexes.filter(
      (liveIndex) =>
        !claimedLiveIndexNames.has(
          identities.member('index', liveIndex.name).comparisonKey,
        ),
    )

    for (const liveIndex of unclaimedIndexes) {
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
  /**
   * Validates physical identifiers introduced by a foreign-key reference.
   *
   * @param value - Runtime value to validate, normalize, or map.
   */
  function validateReferenceName(value: AnySchema | undefined): void {
    if (value?.kind !== 'schema') return

    const reference = getReferenceMetadata(value)

    if (!reference) return

    validateCanonicalRelationNames(identities.resolve(reference.target.relation), naming)
    naming.validate(reference.target.column, 'referenced column name')
  }

  for (const handle of schemas) {
    const metadata = handle.getTableMetadata()
    validateCanonicalRelationNames(identities.resolve(metadata.relation), naming)

    for (const value of Object.values(handle.getSchema().entries)) {
      validateReferenceName(value)
    }
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
function appendMissingColumnConstraints(input: ColumnConstraintReconciliation): void {
  const {
    live,
    desired,
    identity,
    steps,
    identities,
    reserveUniqueConstraint,
    liveColumns,
  } = input

  appendMissingUniqueConstraints(
    desired,
    liveColumns,
    live,
    identities,
    reserveUniqueConstraint,
    identity,
    steps,
  )

  appendMissingForeignKeys(input)
}

/**
 * Reserves and adds desired unique keys absent from existing columns.
 *
 * @param desired - Lowered desired table or schema metadata used for comparison.
 * @param liveColumns - Observed columns indexed by canonical comparison key.
 * @param live - Observed table or index definition to compare with desired metadata.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param reserveUniqueConstraint - Callback that reserves a desired unique-key physical
 *   name.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param steps - Mutable Migration Plan steps accumulated before canonical ordering.
 */
function appendMissingUniqueConstraints(
  desired: LoweredDesiredTable,
  liveColumns: ReadonlyMap<string, CatalogColumn>,
  live: CatalogTable,
  identities: CanonicalRelationIdentityModule,
  reserveUniqueConstraint: (owner: CanonicalRelationIdentity, column: string) => void,
  identity: CanonicalRelationIdentity,
  steps: MigrationStep[],
) {
  const uniqueColumns = desired.columns

  for (const desiredColumn of uniqueColumns) {
    if (!desiredColumn.unique || !liveColumns.has(desiredColumn.identifier.comparisonKey))
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

  for (const liveColumn of live.columns) {
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
function reconcileExistingColumns(input: ExistingColumnReconciliation): void {
  const { live, desired, identity, shape, steps, identities } = input

  const liveColumns = new Map(
    live.columns.map((column) => [
      identities.member('column', column.name).comparisonKey,
      column,
    ]),
  )

  /** Appends a column addition and defers its foreign key until relations exist. */
  function appendMissingColumn(desiredColumn: LoweredDesiredColumn): void {
    appendDesiredColumn({ ...input, desiredColumn })
  }

  reconcileDesiredColumns({ ...input, liveColumns, appendMissingColumn })

  appendDroppedColumns(live, desired, shape, identity, steps, identities)

  appendMissingColumnConstraints({ ...input, liveColumns })
}

type DroppedTablePlanning = Readonly<{
  catalogTables: readonly CatalogTable[]
  registered: CanonicalRelationRegistry<TableHandle>
  ownership: ReturnType<typeof resolveMigrationOwnership>
  steps: MigrationStep[]
  issues: PlanningIssue[]
  identities: CanonicalRelationIdentityModule
}>

/** Compares each desired column against the existing relation's canonical column map. */
function reconcileDesiredColumns(input: DesiredColumnReconciliation) {
  for (const column of input.desired.columns) reconcileDesiredColumn(input, column)
}

/**
 * Adds a missing column and reserves its column-owned constraint names.
 *
 * @param input - Missing column planning inputs and shared accumulators.
 */
function appendDesiredColumn(input: MissingColumnPlanning) {
  const { desiredColumn, identity, steps, reserveUniqueConstraint } = input

  appendMissingForeignKey(input)

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

  if (desiredColumn.unique)
    reserveUniqueConstraint(identity, desiredColumn.identifier.spelling)
}

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
  ensuredNamespaces: (readonly CanonicalNamespaceSegment[])[]
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

  reserveCreatedPrimaryKey(naming, identity, desired, identities, physicalNames)

  appendCreatedConstraintsAndIndexes({
    desired,
    reserveUniqueConstraint,
    identity,
    indexes,
    physicalNames,
    identities,
    steps,
    reserveForeignKey,
    deferredForeignKeys,
  })
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

/**
 * Adds constraints and indexes after reserving a new relation's physical names.
 *
 * @param input - Created constraint planning inputs and shared accumulators.
 */
function appendCreatedConstraintsAndIndexes(input: CreatedConstraintPlanning) {
  const {
    desired,
    reserveUniqueConstraint,
    identity,
    indexes,
    physicalNames,
    identities,
    steps,
    reserveForeignKey,
    deferredForeignKeys,
  } = input

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

/**
 * Reserves the generated primary-key name before creating a relation.
 *
 * @param naming - Physical-name generation, validation, and uniqueness rules.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param desired - Lowered desired table or schema metadata used for comparison.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param physicalNames - Registry that detects physical-name collisions in the selected
 *   dialect scopes.
 */
function reserveCreatedPrimaryKey(
  naming: Readonly<{
    generate(seed: PhysicalNameSeed): string
    validate(name: string, description: string): void
    createRegistry(): PhysicalNameRegistry
  }>,
  identity: CanonicalRelationIdentity,
  desired: LoweredDesiredTable,
  identities: CanonicalRelationIdentityModule,
  physicalNames: PhysicalNameRegistry,
) {
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
}

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

  const desired = requireRegisteredDesiredTable(
    registered,
    identity,
    handle,
    desiredTables,
    identities,
    issues,
  )

  if (!desired) return undefined

  validateCanonicalRelationNames(identity, naming)

  validateDesiredColumnNames(desired, naming)

  const indexes = desiredIndexes(info, identity, naming, identities)

  validateDesiredIndexes(indexes, identities, identity, naming)

  return {
    info,
    identity,
    live: existing.get(identity),
    desired,
    indexes,
    shape: ownership.relationShape(identity) ?? 'complete',
  }
}

/**
 * Validates desired column identifiers under the selected dialect's naming rules.
 *
 * @param desired - Lowered desired table or schema metadata used for comparison.
 * @param naming - Physical-name generation, validation, and uniqueness rules.
 */
function validateDesiredColumnNames(
  desired: LoweredDesiredTable,
  naming: Readonly<{
    generate(seed: PhysicalNameSeed): string
    validate(name: string, description: string): void
    createRegistry(): PhysicalNameRegistry
  }>,
) {
  for (const column of desired.columns) {
    naming.validate(column.identifier.spelling, 'column name')

    if (column.reference) {
      validateCanonicalRelationNames(column.reference.relation, naming)
      naming.validate(column.reference.column.spelling, 'referenced column name')
    }
  }
}

/**
 * Checks canonical index names and their desired column references.
 *
 * @param indexes - Observed or desired indexes to validate, reserve, or reconcile.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param naming - Physical-name generation, validation, and uniqueness rules.
 */
function validateDesiredIndexes(
  indexes: {
    name: CanonicalIdentifier
    columns: CanonicalIdentifier[]
    unique: boolean
    origin: 'explicit' | 'generated'
  }[],
  identities: CanonicalRelationIdentityModule,
  identity: CanonicalRelationIdentity,
  naming: Readonly<{
    generate(seed: PhysicalNameSeed): string
    validate(name: string, description: string): void
    createRegistry(): PhysicalNameRegistry
  }>,
) {
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
}

/** Adds missing namespace steps for every completely owned namespace. */
function appendOwnedNamespaces(
  ownership: ReturnType<typeof resolveMigrationOwnership>,
  ensuredNamespaces: (readonly CanonicalNamespaceSegment[])[],
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

/** Reserves observed relation and constraint names before desired names are generated. */
function reservePlanningCatalogNames(
  planningCatalog: PlanningCatalog,
  sortedCatalogTables: readonly CatalogTable[],
  identities: CanonicalRelationIdentityModule,
  physicalNames: ReturnType<MigrationPlanningContext['naming']['createRegistry']>,
  names: RankedNames,
) {
  const representedCatalogNames = new Set<string>()

  reserveCatalogTableNames(
    sortedCatalogTables,
    physicalNames,
    representedCatalogNames,
    names,
  )

  reservePhysicalCatalogNames(
    planningCatalog,
    representedCatalogNames,
    identities,
    physicalNames,
  )

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
}

/**
 * Reserves catalog names that are not already represented by decoded relations or
 * indexes.
 *
 * @param planningCatalog - Validated catalog fields used by Migration Plan construction.
 * @param representedCatalogNames - Observed names already represented by decoded catalog
 *   objects.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param physicalNames - Registry that detects physical-name collisions in the selected
 *   dialect scopes.
 */
function reservePhysicalCatalogNames(
  planningCatalog: PlanningCatalog,
  representedCatalogNames: Set<string>,
  identities: CanonicalRelationIdentityModule,
  physicalNames: PhysicalNameRegistry,
) {
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
}

/**
 * Reserves observed relations and their index names before generating desired names.
 *
 * @param sortedCatalogTables - Catalog relations in the expected canonical fixture order.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param physicalNames - Registry that detects physical-name collisions in the selected
 *   dialect scopes.
 * @param representedCatalogNames - Observed names already represented by decoded catalog
 *   objects.
 */
function reserveCatalogTableNames(
  sortedCatalogTables: readonly CatalogTable[],
  physicalNames: PhysicalNameRegistry,
  representedCatalogNames: Set<string>,
  names: RankedNames,
) {
  for (const table of sortedCatalogTables) {
    const identity = table.identity
    const namespace = identity.namespace
    reserveCatalogConstraintNames(
      names.identitiesFor(identity),
      identity,
      physicalNames,
      representedCatalogNames,
      namespace,
      table,
    )
  }
}

/**
 * Reserves catalog constraint names within their required dialect uniqueness scope.
 *
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param physicalNames - Registry that detects physical-name collisions in the selected
 *   dialect scopes.
 * @param representedCatalogNames - Observed names already represented by decoded catalog
 *   objects.
 * @param namespace - Ordered role-tagged namespace segments used for identity resolution.
 * @param table - Table metadata or evidence used to resolve its members.
 */
function reserveCatalogConstraintNames(
  identities: CanonicalRelationIdentityModule,
  identity: CanonicalRelationIdentity,
  physicalNames: PhysicalNameRegistry,
  representedCatalogNames: Set<string>,
  namespace: readonly CanonicalNamespaceSegment[],
  table: CatalogTable,
) {
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
    table.indexes,
    identity,
    identities,
    physicalNames,
    representedCatalogNames,
  )

  reserveCatalogKeys(
    table,
    namespace,
    identities,
    identity,
    physicalNames,
    representedCatalogNames,
  )
}

/**
 * Reserves observed primary, unique, and foreign-key names.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 * @param namespace - Ordered role-tagged namespace segments used for identity resolution.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param physicalNames - Registry that detects physical-name collisions in the selected
 *   dialect scopes.
 * @param representedCatalogNames - Observed names already represented by decoded catalog
 *   objects.
 */
function reserveCatalogKeys(
  table: CatalogTable,
  namespace: readonly CanonicalNamespaceSegment[],
  identities: CanonicalRelationIdentityModule,
  identity: CanonicalRelationIdentity,
  physicalNames: PhysicalNameRegistry,
  representedCatalogNames: Set<string>,
) {
  reserveCatalogPrimaryKey(
    table,
    namespace,
    identities,
    identity,
    physicalNames,
    representedCatalogNames,
  )

  reserveCatalogUniqueKeys(
    table,
    namespace,
    identities,
    identity,
    physicalNames,
    representedCatalogNames,
  )

  for (const constraint of table.foreignKeys) {
    if (constraint.name === undefined) continue

    physicalNames.reserve({
      kind: 'foreignKey',
      owner: identity,
      name: constraint.name,
      token: `catalog-constraint:${identities.format(identity)}:${constraint.name}`,
      description: `catalog foreign key ${JSON.stringify(constraint.name)}`,
    })
  }
}

/**
 * Reserves physical names reported by observed unique constraints.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 * @param namespace - Ordered role-tagged namespace segments used for identity resolution.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param physicalNames - Registry that detects physical-name collisions in the selected
 *   dialect scopes.
 * @param representedCatalogNames - Observed names already represented by decoded catalog
 *   objects.
 */
function reserveCatalogUniqueKeys(
  table: CatalogTable,
  namespace: readonly CanonicalNamespaceSegment[],
  identities: CanonicalRelationIdentityModule,
  identity: CanonicalRelationIdentity,
  physicalNames: PhysicalNameRegistry,
  representedCatalogNames: Set<string>,
) {
  for (const constraint of table.uniqueConstraints) {
    if (constraint.name === undefined) continue

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
}

/**
 * Reserves the observed primary-key name when one exists.
 *
 * @param table - Table metadata or evidence used to resolve its members.
 * @param namespace - Ordered role-tagged namespace segments used for identity resolution.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param physicalNames - Registry that detects physical-name collisions in the selected
 *   dialect scopes.
 * @param representedCatalogNames - Observed names already represented by decoded catalog
 *   objects.
 */
function reserveCatalogPrimaryKey(
  table: CatalogTable,
  namespace: readonly CanonicalNamespaceSegment[],
  identities: CanonicalRelationIdentityModule,
  identity: CanonicalRelationIdentity,
  physicalNames: PhysicalNameRegistry,
  representedCatalogNames: Set<string>,
) {
  if (table.primaryKey?.name !== undefined) {
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
}

/**
 * Reserves the deterministic names used by a desired unique constraint.
 *
 * @param owner - Canonical identity of the constrained table.
 * @param column - Unique column name.
 */
function reserveDesiredUniqueConstraint(
  owner: CanonicalRelationIdentity,
  column: string,
  naming: MigrationPlanningContext['naming'],
  physicalNames: ReturnType<MigrationPlanningContext['naming']['createRegistry']>,
  identities: CanonicalRelationIdentityModule,
): void {
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

/**
 * Reserves the deterministic physical name for a desired foreign key.
 *
 * @param owner - Canonical identity of the referencing table.
 * @param column - Referencing column name.
 * @param reference - Desired foreign-key target and actions.
 */
function reserveDesiredForeignKey(
  owner: CanonicalRelationIdentity,
  column: string,
  reference: NonNullable<LoweredDesiredColumn['reference']>,
  naming: MigrationPlanningContext['naming'],
  physicalNames: ReturnType<MigrationPlanningContext['naming']['createRegistry']>,
  identities: CanonicalRelationIdentityModule,
): void {
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

/** Selects the first canonical planning issue before exposing a plan. */
function assertPlanningIssues(
  issues: PlanningIssue[],
  identities: CanonicalRelationIdentityModule,
): void {
  const issue = issues
    .sort((left, right) => comparePlanningIssues(left, right, identities))
    .at(0)

  if (issue)
    throw new MigrationError({
      message: issue.message,
      ...(issue.cause === undefined ? {} : { cause: issue.cause }),
    })
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
  const state = createPlanningState(
    schemas,
    catalog,
    planning,
    registrationDefault,
    ownershipDeclarations,
  )

  reconcileDesiredTables(state)
  state.steps.push(...state.deferredForeignKeys)
  appendDroppedTables({ ...state, catalogTables: state.sortedCatalogTables })
  assertPlanningIssues(state.issues, state.identities)
  return completeMigrationPlan(
    state.steps,
    planning,
    catalog,
    registrationDefault,
    state.names.originalIdentity,
    state.desiredTables,
    state.planningCatalog,
  )
}

/** Sorts the completed Migration Plan and attaches its resolved Semantic Profile. */
function completeMigrationPlan(
  steps: MigrationStep[],
  planning: MigrationPlanningContext,
  catalog: CatalogSnapshot,
  registrationDefault: readonly NamespaceIdentifierInput[] | undefined,
  identities: CanonicalRelationIdentityModule,
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>,
  planningCatalog: PlanningCatalog,
): PlannedMigration {
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
    catalogSnapshot: catalog,
  }
}

/**
 * Indexes lowered desired tables by canonical relation identity.
 *
 * @param sortedSchemas - Desired schema handles in the expected canonical order.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param planning - Selected identity, naming, and schema semantics for Migration Plan
 *   construction.
 *
 * @returns Desired table registrations indexed under canonical relation identity.
 */
function registerLoweredTables(
  sortedSchemas: TableHandle[],
  identities: CanonicalRelationIdentityModule,
  planning: MigrationPlanningContext,
  forRelation: (identity: CanonicalRelationIdentity) => CanonicalRelationIdentityModule,
  issues: PlanningIssue[],
) {
  let lowered: LoweredDesiredSchema
  try {
    lowered = lowerDesiredSchema(sortedSchemas, identities, planning.schema, forRelation)
  } catch (cause) {
    if (isErrorTag(cause, 'MigrationError') && !cause.defect)
      assertPlanningIssues(issues, identities)

    throw cause
  }

  const desiredTables = identities.createRegistry<LoweredDesiredTable>()
  for (const table of lowered.tables) desiredTables.set(table.identity, table)
  return { desiredTables, lowered }
}

/** Appends schema changes for each registered desired relation. */
function reconcileDesiredTables(input: DesiredTableReconciliation) {
  for (const handle of input.sortedSchemas) reconcileDesiredTable(handle, input)
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
    if (
      isErrorTag(cause, 'MigrationError') ||
      cause instanceof MigrationOwnershipSchemaError
    )
      throw cause

    if (!isErrorTag(cause, 'SchemaError')) throw cause

    throw new MigrationError({
      message: `Migration planning failed: ${cause.message}`,
      cause,
    })
  }
}

/**
 * Matches an existing index and adds creation or replacement steps when supported.
 *
 * @param input - Desired index reconciliation inputs and shared accumulators.
 */
function reconcileDesiredIndex(input: DesiredIndexReconciliation): void {
  const { index, identities, identity, physicalNames, steps, claimedLiveIndexNames } =
    input

  const matched = findDesiredIndex(input)

  if (matched.ambiguous) return

  const current = matched.current

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

    return
  }

  const currentKey = identities.member('index', current.name).comparisonKey
  claimedLiveIndexNames.add(currentKey)

  collectIndexDefinitionIssues({ ...input, current, currentKey })
}

/**
 * Reports index differences that cannot be reconciled safely.
 *
 * @param input - Index definition validation inputs and shared accumulators.
 */
function collectIndexDefinitionIssues(input: IndexDefinitionValidation) {
  const {
    current,
    unsupportedLiveIndexNames,
    currentKey,
    issues,
    identity,
    identities,
    index,
  } = input

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

/**
 * Binds desired unique and foreign-key name reservations to the planning registries.
 *
 * @param naming - Physical-name generation, validation, and uniqueness rules.
 * @param physicalNames - Registry that detects physical-name collisions in the selected
 *   dialect scopes.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Foreign-key and unique-key reservation callbacks bound to the planning
 *   registries.
 */
function createDesiredNameReservations(
  naming: DialectNaming,
  physicalNames: PhysicalNameRegistry,
  identities: CanonicalRelationIdentityModule,
) {
  /**
   * Reserves the generated foreign-key name using the planning state's identity and
   * naming policies.
   */
  const reserveForeignKey = (
    owner: CanonicalRelationIdentity,
    column: string,
    reference: NonNullable<LoweredDesiredColumn['reference']>,
  ) =>
    reserveDesiredForeignKey(owner, column, reference, naming, physicalNames, identities)

  /** Reserves the generated unique-constraint name using the planning state's policies. */
  const reserveUniqueConstraint = (owner: CanonicalRelationIdentity, column: string) =>
    reserveDesiredUniqueConstraint(owner, column, naming, physicalNames, identities)

  return { reserveForeignKey, reserveUniqueConstraint }
}

type DesiredTableReconciliation = {
  names: RankedNames
  sortedSchemas: TableHandle[]
  registered: CanonicalRelationRegistry<TableHandle>
  existing: CanonicalRelationRegistry<CatalogTable>
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>
  ownership: ResolvedMigrationOwnership
  issues: PlanningIssue[]
  naming: DialectNaming
  identities: CanonicalRelationIdentityModule
  ensuredSchemas: CanonicalRelationIdentity['namespace'][]
  steps: MigrationStep[]
  deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[]
  physicalNames: PhysicalNameRegistry
  reserveForeignKey: (
    owner: CanonicalRelationIdentity,
    column: string,
    reference: NonNullable<LoweredDesiredColumn['reference']>,
  ) => void
  reserveUniqueConstraint: (owner: CanonicalRelationIdentity, column: string) => void
  planning: MigrationPlanningContext
}

type DesiredColumnReconciliation = {
  desired: LoweredDesiredTable
  liveColumns: Map<string, CatalogColumn>
  appendMissingColumn: (desiredColumn: LoweredDesiredColumn) => void
  identities: CanonicalRelationIdentityModule
  identity: CanonicalRelationIdentity
  planning: MigrationPlanningContext
  steps: MigrationStep[]
}

type MissingColumnPlanning = {
  desiredColumn: LoweredDesiredColumn
  reserveForeignKey: (
    owner: CanonicalRelationIdentity,
    column: string,
    reference: NonNullable<LoweredDesiredColumn['reference']>,
  ) => void
  identity: CanonicalRelationIdentity
  deferredForeignKeys: Readonly<{
    kind: 'add_foreign_key'
    target: MigrationColumnTarget
    references: MigrationColumnReference
  }>[]
  steps: MigrationStep[]
  reserveUniqueConstraint: (owner: CanonicalRelationIdentity, column: string) => void
}

type DesiredIndexReconciliation = {
  index: IndexReconciliation['desired'][number]
  liveIndexes: ReadonlyMap<string, CatalogIndex>
  identities: CanonicalRelationIdentityModule
  issues: PlanningIssue[]
  identity: CanonicalRelationIdentity
  physicalNames: PhysicalNameRegistry
  steps: MigrationStep[]
  claimedLiveIndexNames: Set<string>
  unsupportedLiveIndexNames: Set<string>
}

type IndexDefinitionValidation = {
  current: CatalogIndex
  unsupportedLiveIndexNames: Set<string>
  currentKey: string
  issues: PlanningIssue[]
  identity: CanonicalRelationIdentity
  identities: CanonicalRelationIdentityModule
  index: {
    name: CanonicalIdentifier
    columns: CanonicalIdentifier[]
    unique: boolean
    origin: 'explicit' | 'generated'
  }
}

type MigrationPlanningState = DesiredTableReconciliation & {
  planningCatalog: PlanningCatalog
  sortedCatalogTables: CatalogTable[]
}

/**
 * Resolves desired schema, catalog evidence, ownership, and shared planning accumulators.
 *
 * @param schemas - Registered table handles defining the desired schema.
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 * @param planning - Selected identity, naming, and schema semantics for Migration Plan
 *   construction.
 * @param registrationDefault - Explicit namespace default used before the session's
 *   writable default.
 * @param ownershipDeclarations - Authored declarations of relation and namespace
 *   migration authority.
 *
 * @returns Desired schema, catalog evidence, ownership, and shared planning accumulators.
 */
function createPlanningState(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  planning: MigrationPlanningContext,
  registrationDefault?: readonly NamespaceIdentifierInput[],
  ownershipDeclarations: readonly MigrationOwnershipDeclaration[] = [],
): MigrationPlanningState {
  const { lowered, ...desiredState } = initializeDesiredPlanning(
    schemas,
    catalog,
    planning,
    registrationDefault,
  )

  const { identities, desiredTables, issues, naming, steps } = desiredState
  const catalogState = resolvePlanningCatalog(
    schemas,
    ownershipDeclarations,
    identities,
    catalog,
    desiredTables,
    lowered,
    issues,
    desiredState.names.identitiesFor,
  )

  const { planningCatalog, ownership, sortedCatalogTables } = catalogState
  validateCatalogNames(sortedCatalogTables, desiredState.names)
  const reservations = createPlanningReservations(
    planningCatalog,
    naming,
    identities,
    ownership,
    sortedCatalogTables,
    steps,
    desiredState.names,
  )

  return { ...desiredState, ...catalogState, ...reservations, planning }
}

/** Validates catalog members even when reconciliation does not address them. */
function validateCatalogNames(
  sortedCatalogTables: readonly CatalogTable[],
  names: RankedNames,
) {
  for (const table of sortedCatalogTables) {
    const scoped = names.identitiesFor(table.identity)

    validateCanonicalRelationNames(table.identity, names.namingFor(table.identity))

    for (const column of table.columns) scoped.member('column', column.name)

    for (const index of table.indexes) {
      scoped.member('index', index.name)
      index.columns.forEach((column) => scoped.member('column', column))
    }

    for (const key of [
      table.primaryKey,
      ...table.uniqueConstraints,
      ...table.foreignKeys,
    ]) {
      key?.columns.forEach((column) => scoped.member('column', column))
    }
  }
}

/**
 * Validates catalog coverage and ownership before schema comparisons start.
 *
 * @param schemas - Registered table handles defining the desired schema.
 * @param ownershipDeclarations - Authored declarations of relation and namespace
 *   migration authority.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 * @param desiredTables - Desired tables indexed by canonical relation identity.
 * @param lowered - Desired schema after dialect-specific storage resolution.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 *
 * @returns Validated planning catalog and resolved migration ownership.
 */
function resolvePlanningCatalog(
  schemas: readonly TableHandle[],
  ownershipDeclarations: readonly MigrationOwnershipDeclaration[],
  identities: CanonicalRelationIdentityModule,
  catalog: CatalogSnapshot,
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>,
  lowered: LoweredDesiredSchema,
  issues: PlanningIssue[],
  forRelation: (identity: CanonicalRelationIdentity) => CanonicalRelationIdentityModule,
) {
  const ownership = resolveMigrationOwnership(schemas, ownershipDeclarations, identities)
  const planningCatalog = catalogForPlanning(
    catalog,
    identities,
    desiredTables,
    lowered.tables.map(({ identity }) => identity),
    ownership,
    forRelation,
  )

  const sortedCatalogTables = [...planningCatalog.tables].sort((left, right) =>
    compareCatalogTables(left, right, identities),
  )

  const existing = catalogTableMap(sortedCatalogTables, issues, identities)
  return { planningCatalog, ownership, sortedCatalogTables, existing }
}

/**
 * Validates one desired relation and plans its creation or reconciliation.
 *
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param input - Desired table reconciliation inputs and shared accumulators.
 */
function reconcileDesiredTable(
  handle: TableHandle,
  input: DesiredTableReconciliation,
): void {
  const identityForNames = input.identities.resolve(handle.getTableMetadata().relation)
  input = {
    ...input,
    identities: input.names.identitiesFor(identityForNames),
    naming: input.names.namingFor(identityForNames),
  }
  const { issues, identities, ensuredSchemas, steps, planning } = input
  const prepared = prepareDesiredTable({ ...input, handle })

  if (!prepared) return

  const { info, identity, live, desired: createAst, indexes, shape } = prepared

  if (!live) {
    appendCreatedTable({
      ...input,
      name: info.name,
      desired: createAst,
      indexes,
      identity,
      ensuredNamespaces: ensuredSchemas,
    })

    return
  }

  const relationStepStart = steps.length
  collectManagedPropertyIssues(live, createAst, shape, planning, issues, identities)
  reconcileExistingColumns({ ...input, live, desired: createAst, identity, shape })

  reconcileIndexes({
    ...input,
    live,
    desired: indexes,
    identity,
    shape,
    relationStepStart,
  })
}

type DesiredUniqueConstraintMatching = {
  expected: LoweredDesiredColumn[]
  live: CatalogTable
  identities: CanonicalRelationIdentityModule
  issues: PlanningIssue[]
  identity: CanonicalRelationIdentity
  matched: Set<CatalogKeyConstraint>
}

type CreatedConstraintPlanning = {
  desired: LoweredDesiredTable
  reserveUniqueConstraint: (owner: CanonicalRelationIdentity, column: string) => void
  identity: CanonicalRelationIdentity
  indexes: readonly {
    name: CanonicalIdentifier
    columns: CanonicalIdentifier[]
    unique: boolean
    origin: 'explicit' | 'generated'
  }[]
  physicalNames: PhysicalNameRegistry
  identities: CanonicalRelationIdentityModule
  steps: MigrationStep[]
  reserveForeignKey: (
    owner: CanonicalRelationIdentity,
    column: string,
    reference: NonNullable<LoweredDesiredColumn['reference']>,
  ) => void
  deferredForeignKeys: Readonly<{
    kind: 'add_foreign_key'
    target: MigrationColumnTarget
    references: MigrationColumnReference
  }>[]
}

/**
 * Requires observed type and nullability facts before planning a column change.
 *
 * @param current - Existing definition or resolved properties being compared with desired
 *   metadata.
 * @param columnLabel - Formatted column identity used in diagnostics.
 *
 * @returns Observed physical type and nullability facts; incomplete evidence throws.
 */
function requireColumnProperties(
  current: CatalogColumn,
  columnLabel: string,
): { dataType: string; isNullable: boolean } {
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

  return { dataType: current.dataType, isNullable: current.isNullable }
}

/**
 * Adds supported physical-type and nullability changes for an existing column.
 *
 * @param input - Desired column reconciliation inputs and shared accumulators.
 * @param desiredColumn - Lowered desired storage and reference metadata for one column.
 * @param current - Existing definition or resolved properties being compared with desired
 *   metadata.
 */
function appendColumnAlterations(
  input: DesiredColumnReconciliation,
  desiredColumn: LoweredDesiredColumn,
  current: { dataType: string; isNullable: boolean },
): void {
  const { planning, steps, identity } = input
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

/**
 * Adds a missing column or compares its observed type and nullability.
 *
 * @param input - Desired column reconciliation inputs and shared accumulators.
 * @param desiredColumn - Lowered desired storage and reference metadata for one column.
 */
function reconcileDesiredColumn(
  input: DesiredColumnReconciliation,
  desiredColumn: LoweredDesiredColumn,
): void {
  const { liveColumns, appendMissingColumn, identities, identity } = input
  const current = liveColumns.get(desiredColumn.identifier.comparisonKey)

  if (!current) {
    appendMissingColumn(desiredColumn)
    return
  }

  const columnLabel = identities.format(identity, {
    role: 'column',
    spelling: desiredColumn.identifier.spelling,
  })

  const properties = requireColumnProperties(current, columnLabel)
  appendColumnAlterations(input, desiredColumn, properties)
}

/**
 * Finds an index by authored name or unambiguous generated-index semantics.
 *
 * @param input - Desired index reconciliation inputs and shared accumulators.
 *
 * @returns The unique matching observed index, or undefined when no index matches.
 */
function findDesiredIndex(input: DesiredIndexReconciliation) {
  const { index, liveIndexes, identities, issues, identity } = input
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

      return { ambiguous: true as const }
    }

    current = semanticMatches.at(0)

    if (!current) current = liveIndexes.get(index.name.comparisonKey)
  } else {
    current = liveIndexes.get(index.name.comparisonKey)
  }

  return { ambiguous: false as const, current }
}

/**
 * Reserves and defers a new column's foreign key until its target relation exists.
 *
 * @param input - Missing column planning inputs and shared accumulators.
 */
function appendMissingForeignKey(input: MissingColumnPlanning) {
  const { desiredColumn, reserveForeignKey, identity, deferredForeignKeys } = input

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
}

type CatalogIndexRegistration = {
  ordered: {
    liveIndex: CatalogIndex
    identifier: Readonly<{ spelling: string; comparisonKey: string }>
  }[]
  indexes: Map<string, CatalogIndex>
  issues: PlanningIssue[]
  identity: CanonicalRelationIdentity
  identities: CanonicalRelationIdentityModule
  shape: string
  unsupportedNames: Set<string>
}

/**
 * Adds desired foreign keys that have no equivalent observed constraint.
 *
 * @param input - Column constraint reconciliation inputs and shared accumulators.
 */
function appendMissingForeignKeys(input: ColumnConstraintReconciliation) {
  const {
    live,
    desired,
    identity,
    deferredForeignKeys,
    identities,
    reserveForeignKey,
    liveColumns,
  } = input

  const foreignKeyColumns = desired.columns
  for (const desiredColumn of foreignKeyColumns) {
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

/**
 * Initializes physical-name reservations and namespace steps before desired relations are
 * planned.
 *
 * @param planningCatalog - Validated catalog fields used by Migration Plan construction.
 * @param naming - Physical-name generation, validation, and uniqueness rules.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param ownership - Resolved migration authority for relations, absences, and complete
 *   namespaces.
 * @param sortedCatalogTables - Catalog relations in the expected canonical fixture order.
 * @param steps - Mutable Migration Plan steps accumulated before canonical ordering.
 *
 * @returns Physical-name reservations and namespace steps before desired relations are
 *   planned.
 */
function createPlanningReservations(
  planningCatalog: PlanningCatalog,
  naming: DialectNaming,
  identities: CanonicalRelationIdentityModule,
  ownership: ResolvedMigrationOwnership,
  sortedCatalogTables: CatalogTable[],
  steps: MigrationStep[],
  names: RankedNames,
) {
  const ensuredSchemas = [...planningCatalog.namespaces]
  const registered = identities.createRegistry<TableHandle>()
  const physicalNames = naming.createRegistry()

  for (const identity of [...ownership.explicitRelations, ...ownership.absentRelations]) {
    validateCanonicalRelationNames(identity, names.namingFor(identity))
  }

  for (const namespace of ownership.completeNamespaces) {
    const identity = { namespace, relation: { spelling: '', comparisonKey: '' } }
    validateCanonicalNamespaceNames(namespace, names.namingFor(identity))
  }

  reservePlanningCatalogNames(
    planningCatalog,
    sortedCatalogTables,
    identities,
    physicalNames,
    names,
  )

  appendOwnedNamespaces(ownership, ensuredSchemas, steps)
  const { reserveForeignKey, reserveUniqueConstraint } = createDesiredNameReservations(
    naming,
    physicalNames,
    identities,
  )

  return {
    ensuredSchemas,
    registered,
    physicalNames,
    reserveForeignKey,
    reserveUniqueConstraint,
  }
}

/**
 * Resolves canonical identities and orders the authored schema for deterministic
 * planning.
 *
 * @param schemas - Registered table handles defining the desired schema.
 * @param catalog - Observed catalog evidence used for desired-schema comparison.
 * @param planning - Selected identity, naming, and schema semantics for Migration Plan
 *   construction.
 * @param registrationDefault - Explicit namespace default used before the session's
 *   writable default.
 *
 * @returns Canonical identities and orders the authored schema for deterministic
 *   planning.
 */
function initializeDesiredPlanning(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  planning: MigrationPlanningContext,
  registrationDefault: readonly NamespaceIdentifierInput[] | undefined,
) {
  const originalIdentities = planning.identity.create({
    context: catalog.namespaceContext,
    ...(registrationDefault === undefined ? {} : { registrationDefault }),
  })

  const steps: MigrationStep[] = []
  const deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[] = []
  const issues: PlanningIssue[] = []
  const names = new RankedNames(
    originalIdentities,
    planning.naming,
    issues,
    registrationDefault ?? catalog.namespaceContext.writableDefault,
  )

  const identities = names.identities
  const sortedSchemas = [...schemas].sort((left, right) =>
    compareTableHandles(left, right, identities),
  )

  for (const handle of sortedSchemas) {
    const identity = identities.resolve(handle.getTableMetadata().relation)
    validateDesiredNames(
      [handle],
      names.identitiesFor(identity),
      names.namingFor(identity),
    )
  }

  const { desiredTables, lowered } = registerLoweredTables(
    sortedSchemas,
    identities,
    planning,
    names.identitiesFor,
    issues,
  )

  return {
    names,
    identities,
    steps,
    deferredForeignKeys,
    issues,
    sortedSchemas,
    naming: names.naming,
    desiredTables,
    lowered,
  }
}

/**
 * Registers a relation and records duplicate handles or missing lowered schema evidence.
 *
 * @param registered - Registered table handles indexed by canonical relation identity.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param handle - Table handle whose schema and relation metadata are required.
 * @param desiredTables - Desired tables indexed by canonical relation identity.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 *
 * @returns The registered lowered desired table, or undefined after recording missing
 *   evidence.
 */
function requireRegisteredDesiredTable(
  registered: CanonicalRelationRegistry<TableHandle>,
  identity: CanonicalRelationIdentity,
  handle: TableHandle,
  desiredTables: CanonicalRelationRegistry<LoweredDesiredTable>,
  identities: CanonicalRelationIdentityModule,
  issues: PlanningIssue[],
) {
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

  return desired
}
