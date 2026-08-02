import type {
  CatalogSnapshot,
  CreateTableAst,
  CreateTableColumnAst,
  Dialect,
  LoweredDatabaseDefault,
} from '@/dialects/types'
import type {
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationRegistry,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import { resolveMigrationOwnership } from '@/migrations/migrationOwnership'
import {
  createPhysicalNameRegistry,
  generatedForeignKeyName,
  generatedIndexName,
  generatedPrimaryKeyName,
  generatedUniqueName,
  physicalNamingProfile,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import type { PhysicalNamingProfile } from '@/migrations/physicalNaming'
import { getReferenceMetadata } from '@/schemas/actions/reference'
import { normalizeIndex } from '@/schemas/utils/normalizeIndex'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'

import { lowerDesiredSchema } from './desiredSchema'
import type {
  PlanningCatalogColumn as CatalogColumn,
  PlanningCatalogForeignKey as CatalogForeignKey,
  PlanningCatalogIndex as CatalogIndex,
  PlanningCatalogKeyConstraint as CatalogKeyConstraint,
  PlanningCatalogTable as CatalogTable,
} from './planningCatalog'
import { catalogForPlanning } from './planningCatalog'

/** Structured desired-state Migration Plan step (stable kinds + targets). */
export type MigrationStep =
  | {
      kind: 'create_schema'
      schema: string
    }
  | {
      kind: 'create_table'
      schema?: string
      table: string
    }
  | {
      kind: 'add_column'
      schema?: string
      table: string
      column: string
      dataType: string
      notNull: boolean
      unique?: boolean
      defaultValue?: string | number | boolean | null
      databaseDefault?: LoweredDatabaseDefault
      generated?: 'always' | 'byDefault'
      autoIncrement?: boolean
      references?: {
        table: string
        column: string
        schema?: string
        onDelete?: string
        onUpdate?: string
      }
    }
  | {
      kind: 'alter_column_type'
      schema?: string
      table: string
      column: string
      dataType: string
    }
  | {
      kind: 'add_foreign_key'
      schema?: string
      table: string
      column: string
      references: {
        table: string
        column: string
        schema?: string
        onDelete?: string
        onUpdate?: string
      }
    }
  | {
      kind: 'add_unique_constraint'
      schema?: string
      table: string
      column: string
    }
  | {
      kind: 'set_not_null'
      schema?: string
      table: string
      column: string
    }
  | {
      kind: 'drop_not_null'
      schema?: string
      table: string
      column: string
    }
  | {
      kind: 'create_index'
      schema?: string
      table: string
      index: string
      columns: string[]
      unique: boolean
    }
  | {
      kind: 'drop_column'
      schema?: string
      table: string
      column: string
    }
  | {
      kind: 'drop_table'
      schema?: string
      table: string
    }
  | {
      kind: 'drop_index'
      schema?: string
      table: string
      index: string
    }

export type MigrationPlan = {
  steps: MigrationStep[]
}

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
  create_schema: 0,
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
 * Builds an identity input whose omitted schema is resolved by the identity module.
 *
 * @param schema - Explicit schema spelling, or undefined to use namespace resolution.
 * @param relation - Relation spelling.
 */
function relationInput(schema: string | undefined, relation: string) {
  return {
    ...(schema === undefined
      ? {}
      : { namespace: [{ role: 'schema' as const, spelling: schema }] }),
    relation,
  }
}

/**
 * Builds an identity input for an introspected relation, which must always include its
 * catalog-provided schema.
 *
 * @param schema - Schema spelling supplied by catalog introspection.
 * @param relation - Relation spelling supplied by catalog introspection.
 */
function catalogRelationInput(schema: string | undefined, relation: string) {
  if (schema === undefined) {
    throw new TypeError(
      `Catalog relation ${JSON.stringify(relation)} is missing its namespace`,
    )
  }
  return relationInput(schema, relation)
}

/**
 * Projects the schema spelling required by the current Migration Plan step format.
 *
 * @param identity - Canonical relation identity to project.
 *
 * @throws {MigrationError} When the canonical identity has no schema segment.
 */
function schemaFromIdentity(identity: CanonicalRelationIdentity): string {
  const schema = identity.namespace.find((segment) => segment.role === 'schema')
  if (!schema) {
    throw new MigrationError({
      message: 'The current Migration Plan projection requires a schema namespace',
    })
  }
  return schema.identifier.spelling
}

function schemaFromNamespace(namespace: CanonicalRelationIdentity['namespace']): string {
  const schema = namespace.find((segment) => segment.role === 'schema')
  if (!schema) {
    throw new MigrationError({
      message: 'The current Migration Plan projection requires a schema namespace',
    })
  }
  return schema.identifier.spelling
}

function validateCanonicalNamespaceNames(
  namespace: CanonicalRelationIdentity['namespace'],
  profile: PhysicalNamingProfile,
): void {
  for (const segment of namespace) {
    validatePhysicalName(
      segment.identifier.spelling,
      `${segment.role} identifier`,
      profile,
    )
  }
}

function validateCanonicalRelationNames(
  identity: CanonicalRelationIdentity,
  profile: PhysicalNamingProfile,
): void {
  validateCanonicalNamespaceNames(identity.namespace, profile)
  validatePhysicalName(identity.relation.spelling, 'relation identifier', profile)
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

/**
 * Orders plan steps by migration phase, canonical relation identity, then member name.
 *
 * @param left - First Migration Plan step.
 * @param right - Second Migration Plan step.
 * @param identities - Identity module used to resolve and compare step targets.
 */
function compareMigrationSteps(
  left: MigrationStep,
  right: MigrationStep,
  identities: CanonicalRelationIdentityModule,
): number {
  const phase = MIGRATION_PHASE[left.kind] - MIGRATION_PHASE[right.kind]
  if (phase !== 0) return phase

  if (left.kind === 'create_schema' || right.kind === 'create_schema') {
    return left.kind === 'create_schema' && right.kind === 'create_schema'
      ? compareCodeUnits(left.schema, right.schema)
      : 0
  }

  const relation = identities.compare(
    identities.resolve(relationInput(left.schema, left.table)),
    identities.resolve(relationInput(right.schema, right.table)),
  )
  if (relation !== 0) return relation

  const leftMember = 'column' in left ? left.column : 'index' in left ? left.index : ''
  const rightMember =
    'column' in right ? right.column : 'index' in right ? right.index : ''
  return compareCodeUnits(leftMember, rightMember)
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
    identities.resolve(relationInput(leftInfo.schema, leftInfo.name)),
    identities.resolve(relationInput(rightInfo.schema, rightInfo.name)),
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
  return identities.compare(
    identities.resolve(catalogRelationInput(left.schema, left.name)),
    identities.resolve(catalogRelationInput(right.schema, right.name)),
  )
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
    const identity = identities.resolve(catalogRelationInput(table.schema, table.name))
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
 * @param dialect - Dialect used to normalize desired default values.
 */
function defaultMismatch(
  target: string,
  live: CatalogColumn,
  desired: CreateTableColumnAst,
  dialect: Dialect,
): string | undefined {
  if (live.defaultExpression === undefined) return
  const expected =
    desired.databaseDefault?.normalized ??
    (desired.defaultValue === undefined
      ? null
      : dialect.normalizeDefaultValue?.(desired.defaultValue))
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
  desired: CreateTableColumnAst,
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

function hasSupportedCatalogSemantics(
  object: CatalogIndex | CatalogKeyConstraint | CatalogForeignKey,
): boolean {
  return object.semanticCompleteness === 'supportedSimple' && object.isValid === true
}

function canonicalCatalogForeignKey(
  foreignKey: CatalogForeignKey,
  identities: CanonicalRelationIdentityModule,
): CanonicalForeignKey {
  return {
    columns: foreignKey.columns,
    referencedRelation: identities.resolve(
      catalogRelationInput(foreignKey.referencedSchema, foreignKey.referencedTable),
    ),
    referencedColumns: foreignKey.referencedColumns,
    onDelete: normalizeAction(foreignKey.onDelete),
    onUpdate: normalizeAction(foreignKey.onUpdate),
  }
}

function canonicalDesiredForeignKey(
  column: CreateTableColumnAst,
  identities: CanonicalRelationIdentityModule,
): CanonicalForeignKey {
  const reference = column.references!
  return {
    columns: [column.name],
    referencedRelation: identities.resolve(
      relationInput(reference.schema, reference.table),
    ),
    referencedColumns: [reference.column],
    onDelete: normalizeAction(reference.onDelete),
    onUpdate: normalizeAction(reference.onUpdate),
  }
}

function matchUniqueConstraints(
  constraints: readonly CatalogKeyConstraint[],
  column: string,
): CatalogKeyConstraint[] {
  return constraints.filter((constraint) => arraysEqual(constraint.columns, [column]))
}

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

/**
 * Adds deterministic issues for managed properties that cannot yet be migrated safely.
 * Undefined catalog properties are treated as unavailable rather than as drift.
 *
 * @param live - Introspected table definition.
 * @param desired - Dialect-lowered desired table definition.
 * @param dialect - Dialect used to normalize managed values.
 * @param issues - Mutable collection that receives unsupported-drift issues.
 * @param identities - Identity module used for comparison and diagnostics.
 */
function collectManagedPropertyIssues(
  live: CatalogTable,
  desired: CreateTableAst,
  shape: 'complete' | 'additive',
  dialect: Dialect,
  issues: PlanningIssue[],
  identities: CanonicalRelationIdentityModule,
): void {
  const identity = identities.resolve(catalogRelationInput(live.schema, live.name))
  const tableName = identities.format(identity)
  const liveColumns = new Map<string, CatalogColumn>()

  for (const column of live.columns) {
    if (liveColumns.has(column.name)) {
      issues.push({
        identity,
        target: column.name,
        property: 'duplicate_catalog_column',
        message: `Duplicate catalog column ${identities.format(identity, {
          role: 'column',
          spelling: column.name,
        })}`,
      })
      continue
    }
    liveColumns.set(column.name, column)
  }

  for (const column of desired.columns) {
    const current = liveColumns.get(column.name)
    if (!current) continue
    const columnTarget = identities.format(identity, {
      role: 'column',
      spelling: column.name,
    })
    const defaultMessage = defaultMismatch(columnTarget, current, column, dialect)
    if (defaultMessage) {
      issues.push({
        identity,
        target: column.name,
        property: 'default',
        message: defaultMessage,
      })
    }
    const identityMessage = identityMismatch(columnTarget, current, column)
    if (identityMessage) {
      issues.push({
        identity,
        target: column.name,
        property: 'identity',
        message: identityMessage,
      })
    }
  }

  if (live.primaryKey !== undefined) {
    const current = live.primaryKey?.columns ?? []
    if (
      (live.primaryKey && !hasSupportedCatalogSemantics(live.primaryKey)) ||
      !arraysEqual(current, desired.primaryKey)
    ) {
      issues.push({
        identity,
        target: '',
        property: 'primary_key',
        message: `Unsupported primary key change for '${tableName}'`,
      })
    }
  }

  if (live.uniqueConstraints !== undefined) {
    const expected = desired.columns.filter(
      (column) => column.unique && liveColumns.has(column.name),
    )
    const matched = new Set<CatalogKeyConstraint>()
    for (const column of expected) {
      const matches = matchUniqueConstraints(live.uniqueConstraints, column.name)
      if (matches.length > 1) {
        issues.push({
          identity,
          target: column.name,
          property: 'ambiguous_semantic_match',
          message: `Ambiguous unique constraint semantic match for ${identities.format(
            identity,
            { role: 'column', spelling: column.name },
          )}`,
        })
      }
      for (const match of matches) matched.add(match)
      const match = matches[0]
      if (!match) continue
      if (!hasSupportedCatalogSemantics(match)) {
        issues.push({
          identity,
          target: column.name,
          property: 'unsupported_catalog_semantics',
          message: `Unsupported unique constraint catalog semantics for ${identities.format(
            identity,
            { role: 'column', spelling: column.name },
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
        message: `Unsupported removal of extra unique constraints for '${tableName}'`,
      })
    }
  }

  if (live.foreignKeys !== undefined) {
    const expected = desired.columns
      .filter((column) => column.references !== undefined && liveColumns.has(column.name))
      .map((column) => canonicalDesiredForeignKey(column, identities))
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
}

/**
 * Projects a canonical relation identity into the schema field used by plan steps.
 *
 * @param identity - Canonical relation identity to project.
 */
function schemaField(identity: CanonicalRelationIdentity): { schema: string } {
  return { schema: schemaFromIdentity(identity) }
}

/**
 * Resolves a desired foreign-key reference and projects its canonical schema.
 *
 * @param reference - Desired foreign-key reference to resolve.
 * @param identities - Identity module used to resolve the referenced relation.
 */
function projectedReference(
  reference: NonNullable<CreateTableColumnAst['references']>,
  identities: CanonicalRelationIdentityModule,
) {
  const identity = identities.resolve(relationInput(reference.schema, reference.table))
  return {
    ...reference,
    schema: schemaFromIdentity(identity),
  }
}

/**
 * Normalizes desired indexes and fills omitted names and uniqueness flags.
 *
 * @param info - Desired table metadata containing index declarations.
 */
function desiredIndexes(
  info: ReturnType<TableHandle['getTableMetadata']>,
  identity: CanonicalRelationIdentity,
  dialect: Dialect,
): Array<{
  name: string
  columns: string[]
  unique: boolean
  origin: 'explicit' | 'generated'
}> {
  const profile = physicalNamingProfile(dialect.relationIdentity)
  return (info.indexes ?? [])
    .map((raw) => {
      const index = normalizeIndex(raw)
      const unique = index.unique ?? false
      return {
        name: index.name ?? generatedIndexName(identity, index.columns, unique, profile),
        columns: [...index.columns],
        unique,
        origin: index.name === undefined ? ('generated' as const) : ('explicit' as const),
      }
    })
    .sort(
      (left, right) =>
        compareCodeUnits(left.name, right.name) ||
        compareStringArrays(left.columns, right.columns) ||
        Number(left.unique) - Number(right.unique),
    )
}

/**
 * Reconciles desired tables with an introspected catalog into one canonically ordered
 * Migration Plan. Unsupported or ambiguous drift is collected before the first
 * deterministic planning issue is thrown.
 *
 * @param schemas - Registered desired table handles.
 * @param catalog - Introspected catalog snapshot and namespace context.
 * @param dialect - Dialect used for identity, lowering, and value normalization.
 * @param registrationDefault - Optional namespace for registrations that omit one.
 */
export type PlannedMigration = {
  plan: MigrationPlan
  identities: CanonicalRelationIdentityModule
  desiredTables: CanonicalRelationRegistry<CreateTableAst>
}

function buildMigrationPlan(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  dialect: Dialect,
  registrationDefault?: readonly NamespaceIdentifierInput[],
  ownershipDeclarations: readonly MigrationOwnershipDeclaration[] = [],
): PlannedMigration {
  const identities = createCanonicalRelationIdentityModule({
    adapter: dialect.relationIdentity,
    context: catalog.namespaceContext,
    ...(registrationDefault === undefined ? {} : { registrationDefault }),
  })
  const steps: MigrationStep[] = []
  const deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[] = []
  const issues: PlanningIssue[] = []
  const sortedSchemas = [...schemas].sort((left, right) =>
    compareTableHandles(left, right, identities),
  )
  const namingProfile = physicalNamingProfile(dialect.relationIdentity)
  for (const handle of sortedSchemas) {
    const metadata = handle.getTableMetadata()
    validateCanonicalRelationNames(
      identities.resolve(relationInput(metadata.schema, metadata.name)),
      namingProfile,
    )
    for (const value of Object.values(handle.getSchema().entries)) {
      if (!value || value.kind !== 'schema') continue
      const reference = getReferenceMetadata(value)
      if (!reference) continue
      validateCanonicalRelationNames(
        identities.resolve(reference.target.relation),
        namingProfile,
      )
      validatePhysicalName(
        reference.target.column,
        'referenced column name',
        namingProfile,
      )
    }
  }
  const lowered = lowerDesiredSchema(sortedSchemas, identities, dialect)
  const desiredTables = identities.createRegistry<CreateTableAst>()
  for (const table of lowered.tables) desiredTables.set(table.identity, table.ast)
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
  const physicalNames = createPhysicalNameRegistry(namingProfile)
  const representedCatalogNames = new Set<string>()

  for (const identity of [...ownership.explicitRelations, ...ownership.absentRelations]) {
    validateCanonicalRelationNames(identity, namingProfile)
  }
  for (const namespace of ownership.completeNamespaces) {
    validateCanonicalNamespaceNames(namespace, namingProfile)
  }

  for (const table of sortedCatalogTables) {
    const identity = identities.resolve(catalogRelationInput(table.schema, table.name))
    const relationToken = `relation:${identities.format(identity)}`
    physicalNames.reserve({
      kind: 'relation',
      owner: identity,
      name: table.name,
      token: relationToken,
      description: `catalog relation ${identities.format(identity)}`,
    })
    representedCatalogNames.add(`${table.schema}\0${table.name}`)
    for (const index of table.indexes ?? []) {
      physicalNames.reserve({
        kind: 'index',
        owner: identity,
        name: index.name,
        token: `catalog:${table.schema}:${index.name}`,
        description: `catalog index ${JSON.stringify(index.name)}`,
      })
      representedCatalogNames.add(`${table.schema}\0${index.name}`)
    }
    if (table.primaryKey) {
      const backingToken = `catalog:${table.schema}:${table.primaryKey.name}`
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
      representedCatalogNames.add(`${table.schema}\0${table.primaryKey.name}`)
    }
    for (const constraint of table.uniqueConstraints ?? []) {
      const backingToken = `catalog:${table.schema}:${constraint.name}`
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
      representedCatalogNames.add(`${table.schema}\0${constraint.name}`)
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
    if (representedCatalogNames.has(`${reservation.schema}\0${reservation.name}`)) {
      continue
    }
    const owner = identities.resolve(
      catalogRelationInput(reservation.schema, reservation.name),
    )
    physicalNames.reserve({
      kind: 'relation',
      owner,
      name: reservation.name,
      token: `catalog:${reservation.schema}:${reservation.name}`,
      description: `catalog object ${JSON.stringify(reservation.name)}`,
    })
  }

  for (const reservation of planningCatalog.constraintNameReservations) {
    const owner = identities.resolve(
      catalogRelationInput(reservation.schema, reservation.table),
    )
    physicalNames.reserve({
      kind: 'check',
      owner,
      name: reservation.name,
      token: `catalog-constraint:${identities.format(owner)}:${reservation.name}`,
      description: `catalog constraint ${JSON.stringify(reservation.name)}`,
    })
  }

  for (const namespace of ownership.completeNamespaces) {
    if (!ensuredSchemas.some((existing) => sameNamespace(existing, namespace))) {
      steps.push({ kind: 'create_schema', schema: schemaFromNamespace(namespace) })
      ensuredSchemas.push(namespace)
    }
  }

  const reserveForeignKey = (
    owner: CanonicalRelationIdentity,
    column: string,
    reference: NonNullable<CreateTableColumnAst['references']>,
  ) => {
    const referenced = identities.resolve(
      relationInput(reference.schema, reference.table),
    )
    const name = generatedForeignKeyName(
      owner,
      column,
      referenced,
      reference.column,
      reference.onDelete,
      reference.onUpdate,
      namingProfile,
    )
    physicalNames.reserve({
      kind: 'foreignKey',
      owner,
      name,
      token: `generated-foreign-key:${identities.format(owner)}:${column}:${identities.format(referenced)}:${reference.column}:${normalizeAction(reference.onDelete)}:${normalizeAction(reference.onUpdate)}`,
      description: `generated foreign key on ${identities.format(owner, {
        role: 'column',
        spelling: column,
      })}`,
    })
  }

  const reserveUniqueConstraint = (owner: CanonicalRelationIdentity, column: string) => {
    const name = generatedUniqueName(owner, column, namingProfile)
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
    const info = handle.getTableMetadata()
    const identity = identities.resolve(relationInput(info.schema, info.name))
    if (registered.has(identity)) {
      issues.push({
        identity,
        target: '',
        property: 'duplicate_registered_table',
        message: `Duplicate registered table ${identities.format(identity)}`,
      })
    }
    registered.set(identity, handle)
    const live = existing.get(identity)
    const createAst = desiredTables.get(identity)
    if (!createAst) {
      issues.push({
        identity,
        target: '',
        property: 'invalid_desired_table',
        message: `Invalid desired table ${identities.format(identity)}`,
      })
      continue
    }
    validateCanonicalRelationNames(identity, namingProfile)
    for (const column of createAst.columns) {
      validatePhysicalName(column.name, 'column name', namingProfile)
      if (column.references) {
        validateCanonicalRelationNames(
          identities.resolve(
            relationInput(column.references.schema, column.references.table),
          ),
          namingProfile,
        )
        validatePhysicalName(
          column.references.column,
          'referenced column name',
          namingProfile,
        )
      }
    }
    const indexes = desiredIndexes(info, identity, dialect)
    for (const index of indexes) {
      if (index.origin === 'explicit') {
        validatePhysicalName(index.name, 'explicit index name', namingProfile)
      }
    }
    const shape = ownership.relationShape(identity) ?? 'complete'

    if (!live) {
      if (
        !ensuredSchemas.some((existing) => sameNamespace(existing, identity.namespace))
      ) {
        steps.push({ kind: 'create_schema', schema: schemaFromIdentity(identity) })
        ensuredSchemas.push(identity.namespace)
      }

      steps.push({
        kind: 'create_table',
        ...schemaField(identity),
        table: info.name,
      })

      physicalNames.reserve({
        kind: 'relation',
        owner: identity,
        name: info.name,
        token: `relation:${identities.format(identity)}`,
        description: `desired relation ${identities.format(identity)}`,
      })

      const primaryKeyName = generatedPrimaryKeyName(
        identity,
        createAst.primaryKey,
        namingProfile,
      )
      physicalNames.reserve({
        kind: 'primaryKey',
        owner: identity,
        name: primaryKeyName,
        token: `generated-primary-key:${identities.format(identity)}:${JSON.stringify(createAst.primaryKey)}`,
        description: `generated primary key on ${identities.format(identity)}`,
      })
      physicalNames.reserve({
        kind: 'check',
        owner: identity,
        name: primaryKeyName,
        token: `generated-primary-key:${identities.format(identity)}:${JSON.stringify(createAst.primaryKey)}`,
        description: `generated primary key on ${identities.format(identity)}`,
      })
      for (const column of createAst.columns.filter((column) => column.unique)) {
        reserveUniqueConstraint(identity, column.name)
      }

      for (const index of indexes) {
        physicalNames.reserve({
          kind: 'index',
          owner: identity,
          name: index.name,
          token: `${index.origin}-index:${identities.format(identity)}:${JSON.stringify(index.columns)}:${index.unique}`,
          description: `${index.origin} index ${JSON.stringify(index.name)}`,
        })
        steps.push({
          kind: 'create_index',
          ...schemaField(identity),
          table: info.name,
          index: index.name,
          columns: index.columns,
          unique: index.unique,
        })
      }

      for (const column of createAst.columns) {
        if (!column.references) continue
        reserveForeignKey(identity, column.name, column.references)
        deferredForeignKeys.push({
          kind: 'add_foreign_key',
          ...schemaField(identity),
          table: info.name,
          column: column.name,
          references: projectedReference(column.references, identities),
        })
      }
      continue
    }

    const relationStepStart = steps.length
    collectManagedPropertyIssues(live, createAst, shape, dialect, issues, identities)

    const liveColumns = new Map(
      (live.columns ?? []).map((column) => [column.name, column]),
    )
    const desiredColumnNames = new Set(createAst.columns.map((column) => column.name))

    for (const desired of createAst.columns) {
      const current = liveColumns.get(desired.name)
      if (!current) {
        if (desired.references) {
          reserveForeignKey(identity, desired.name, desired.references)
          deferredForeignKeys.push({
            kind: 'add_foreign_key',
            ...schemaField(identity),
            table: info.name,
            column: desired.name,
            references: projectedReference(desired.references, identities),
          })
        }
        steps.push({
          kind: 'add_column',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
          dataType: desired.dataType,
          notNull: desired.notNull,
          ...(desired.unique ? { unique: true } : {}),
          ...(desired.defaultValue !== undefined
            ? { defaultValue: desired.defaultValue }
            : {}),
          ...(desired.databaseDefault !== undefined
            ? { databaseDefault: desired.databaseDefault }
            : {}),
          ...(desired.generated ? { generated: desired.generated } : {}),
          ...(desired.autoIncrement ? { autoIncrement: true } : {}),
        })
        if (desired.unique) {
          reserveUniqueConstraint(identity, desired.name)
        }
        continue
      }

      const desiredType = dialect.normalizeDataType(desired.dataType)
      const currentType = dialect.normalizeDataType(current.dataType!)
      if (desiredType !== currentType) {
        steps.push({
          kind: 'alter_column_type',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
          dataType: desired.dataType,
        })
      }

      if (desired.notNull && current.isNullable!) {
        steps.push({
          kind: 'set_not_null',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
        })
      } else if (!desired.notNull && !current.isNullable!) {
        steps.push({
          kind: 'drop_not_null',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
        })
      }
    }

    if (shape === 'complete') {
      for (const liveColumn of live.columns ?? []) {
        if (desiredColumnNames.has(liveColumn.name)) continue
        steps.push({
          kind: 'drop_column',
          ...schemaField(identity),
          table: info.name,
          column: liveColumn.name,
        })
      }
    }

    if (live.uniqueConstraints !== undefined) {
      for (const desired of createAst.columns) {
        if (!desired.unique || !liveColumns.has(desired.name)) continue
        const matches = matchUniqueConstraints(live.uniqueConstraints, desired.name)
        if (matches.length !== 0) continue
        reserveUniqueConstraint(identity, desired.name)
        steps.push({
          kind: 'add_unique_constraint',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
        })
      }
    }

    if (live.foreignKeys !== undefined) {
      for (const desired of createAst.columns) {
        if (!desired.references || !liveColumns.has(desired.name)) continue
        const expected = canonicalDesiredForeignKey(desired, identities)
        const matches = matchForeignKeys(live.foreignKeys, expected, identities)
        if (matches.length !== 0) continue
        reserveForeignKey(identity, desired.name, desired.references)
        deferredForeignKeys.push({
          kind: 'add_foreign_key',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
          references: projectedReference(desired.references, identities),
        })
      }
    }

    const claimedLiveIndexNames = new Set<string>()
    const unsupportedLiveIndexNames = new Set<string>()
    const liveIndexes = new Map<string, CatalogIndex>()
    for (const liveIndex of live.indexes ?? []) {
      if (liveIndexes.has(liveIndex.name)) {
        issues.push({
          identity,
          target: liveIndex.name,
          property: 'duplicate_catalog_index',
          message: `Duplicate catalog index ${identities.format(identity, {
            role: 'index',
            spelling: liveIndex.name,
          })}`,
        })
        continue
      }
      liveIndexes.set(liveIndex.name, liveIndex)
      if (shape === 'complete' && !hasSupportedCatalogSemantics(liveIndex)) {
        unsupportedLiveIndexNames.add(liveIndex.name)
        issues.push({
          identity,
          target: liveIndex.name,
          property: 'unsupported_catalog_semantics',
          message: `Unsupported index catalog semantics for ${identities.format(
            identity,
            {
              role: 'index',
              spelling: liveIndex.name,
            },
          )}`,
        })
      }
    }
    for (const index of indexes) {
      let current: CatalogIndex | undefined
      if (index.origin === 'generated') {
        const semanticMatches = [...liveIndexes.values()].filter(
          (candidate) =>
            candidate.unique === index.unique &&
            arraysEqual(candidate.columns, index.columns),
        )
        if (semanticMatches.length > 1) {
          issues.push({
            identity,
            target: index.name,
            property: 'ambiguous_semantic_match',
            message: `Ambiguous index semantic match for ${identities.format(identity, {
              role: 'index',
              spelling: index.name,
            })}`,
          })
          continue
        }
        current = semanticMatches[0]
        if (!current) current = liveIndexes.get(index.name)
      } else {
        current = liveIndexes.get(index.name)
      }
      if (!current) {
        physicalNames.reserve({
          kind: 'index',
          owner: identity,
          name: index.name,
          token: `${index.origin}-index:${identities.format(identity)}:${JSON.stringify(index.columns)}:${index.unique}`,
          description: `${index.origin} index ${JSON.stringify(index.name)}`,
        })
        steps.push({
          kind: 'create_index',
          ...schemaField(identity),
          table: info.name,
          index: index.name,
          columns: index.columns,
          unique: index.unique,
        })
        continue
      }
      claimedLiveIndexNames.add(current.name)
      if (
        !hasSupportedCatalogSemantics(current) &&
        !unsupportedLiveIndexNames.has(current.name)
      ) {
        unsupportedLiveIndexNames.add(current.name)
        issues.push({
          identity,
          target: current.name,
          property: 'unsupported_catalog_semantics',
          message: `Unsupported index catalog semantics for ${identities.format(
            identity,
            {
              role: 'index',
              spelling: current.name,
            },
          )}`,
        })
      }
      if (
        hasSupportedCatalogSemantics(current) &&
        (current.unique !== index.unique || !arraysEqual(current.columns, index.columns))
      ) {
        issues.push({
          identity,
          target: index.name,
          property: 'index_definition',
          message: `Unsupported index definition change for ${identities.format(
            identity,
            {
              role: 'index',
              spelling: index.name,
            },
          )}`,
        })
      }
    }

    if (shape === 'complete') {
      for (const liveIndex of live.indexes ?? []) {
        if (claimedLiveIndexNames.has(liveIndex.name)) continue
        steps.push({
          kind: 'drop_index',
          ...schemaField(identity),
          table: info.name,
          index: liveIndex.name,
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

  steps.push(...deferredForeignKeys)

  for (const live of sortedCatalogTables) {
    const identity = identities.resolve(catalogRelationInput(live.schema, live.name))
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
    steps.push({
      kind: 'drop_table',
      ...schemaField(identity),
      table: live.name,
    })
  }

  const issue = issues.sort((left, right) =>
    comparePlanningIssues(left, right, identities),
  )[0]
  if (issue) throw new MigrationError({ message: issue.message })

  return {
    plan: {
      steps: steps.sort((left, right) => compareMigrationSteps(left, right, identities)),
    },
    identities,
    desiredTables,
  }
}

/**
 * Constructs a Migration Plan from registered tables and a catalog snapshot.
 * This interface is synchronous and performs no database operations.
 *
 * @example
 *   const { plan } = planMigration(
 *     [Users],
 *     {
 *       tables: [],
 *       namespaceContext: {
 *         writableDefault: [
 *           { role: 'database', spelling: 'app' },
 *           { role: 'schema', spelling: 'public' },
 *         ],
 *       },
 *     },
 *     postgresDialect,
 *   )
 *
 * @param schemas - Registered desired table handles.
 * @param catalog - Introspected catalog snapshot and namespace context.
 * @param dialect - Dialect used for identity, lowering, and value normalization.
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
  dialect: Dialect,
  options: {
    registrationDefault?: readonly NamespaceIdentifierInput[]
    migrationOwnership?: readonly MigrationOwnershipDeclaration[]
  } = {},
): PlannedMigration {
  try {
    return buildMigrationPlan(
      schemas,
      catalog,
      dialect,
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
