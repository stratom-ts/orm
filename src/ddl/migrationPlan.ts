import type {
  CatalogColumn,
  CatalogIndex,
  CatalogSnapshot,
  CatalogTable,
  CreateTableColumnAst,
  Dialect,
} from '@/dialects/types'
import type {
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import { normalizeIndex } from '@/schemas/utils/normalizeIndex'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'

import { buildCreateTableAst } from './createTable'

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
  add_foreign_key: 7,
  drop_index: 8,
  drop_column: 9,
  drop_table: 10,
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

/**
 * Compares namespace roles and comparison keys while ignoring the relation segment.
 *
 * @param left - First canonical identity.
 * @param right - Second canonical identity.
 */
function sameNamespace(
  left: CanonicalRelationIdentity,
  right: CanonicalRelationIdentity,
): boolean {
  return (
    left.namespace.length === right.namespace.length &&
    left.namespace.every((segment, index) => {
      const other = right.namespace[index]
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
 * Collects namespaces known to exist from the writable default and catalog relations.
 * Placeholder relation names carry namespaces because identities are relation-shaped.
 *
 * @param catalog - Introspected catalog and writable namespace context.
 * @param identities - Identity module used to resolve catalog namespaces.
 */
function schemasPresentInCatalog(
  catalog: CatalogSnapshot,
  identities: CanonicalRelationIdentityModule,
): CanonicalRelationIdentity[] {
  const schemas = [
    identities.resolve({
      namespace: catalog.namespaceContext.writableDefault,
      relation: '__namespace_default__',
    }),
  ]
  for (const table of catalog.tables) {
    const identity = identities.resolve(catalogRelationInput(table.schema, table.name))
    if (!schemas.some((existing) => sameNamespace(existing, identity))) {
      schemas.push(identity)
    }
  }
  return schemas
}

/**
 * Derives the conventional index name used when the desired index omits one.
 *
 * @param table - Relation spelling used as the name prefix.
 * @param columns - Ordered indexed column spellings.
 */
function defaultIndexName(table: string, columns: string[]): string {
  return `${table}_${columns.join('_')}_idx`
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
    desired.defaultValue === undefined
      ? null
      : dialect.normalizeDefaultValue?.(desired.defaultValue)
  if (desired.defaultValue !== undefined && expected === undefined) {
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

/**
 * Tests canonically sorted foreign-key collections for positional semantic equality.
 *
 * @param left - First canonically sorted foreign-key collection.
 * @param right - Second canonically sorted foreign-key collection.
 * @param identities - Identity module used to compare referenced relations.
 */
function foreignKeyArraysEqual(
  left: readonly CanonicalForeignKey[],
  right: readonly CanonicalForeignKey[],
  identities: CanonicalRelationIdentityModule,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (foreignKey, index) =>
        compareForeignKeys(foreignKey, right[index]!, identities) === 0,
    )
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
  desired: ReturnType<typeof buildCreateTableAst>,
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
    if (!arraysEqual(current, desired.primaryKey)) {
      issues.push({
        identity,
        target: '',
        property: 'primary_key',
        message: `Unsupported primary key change for '${tableName}'`,
      })
    }
  }

  if (live.uniqueConstraints !== undefined) {
    const current = live.uniqueConstraints
      .map((constraint) => constraint.columns.join('\0'))
      .sort()
    const expected = desired.columns
      .filter((column) => column.unique)
      .map((column) => column.name)
      .sort()
    if (!arraysEqual(current, expected)) {
      issues.push({
        identity,
        target: '',
        property: 'unique_constraint',
        message: `Unsupported unique constraint change for '${tableName}'`,
      })
    }
  }

  if (live.foreignKeys !== undefined) {
    const current = live.foreignKeys
      .map(
        (foreignKey): CanonicalForeignKey => ({
          columns: foreignKey.columns,
          referencedRelation: identities.resolve(
            catalogRelationInput(foreignKey.referencedSchema, foreignKey.referencedTable),
          ),
          referencedColumns: foreignKey.referencedColumns,
          onDelete: normalizeAction(foreignKey.onDelete),
          onUpdate: normalizeAction(foreignKey.onUpdate),
        }),
      )
      .sort((left, right) => compareForeignKeys(left, right, identities))
    const expected = desired.columns
      .filter((column) => column.references !== undefined)
      .map((column): CanonicalForeignKey => {
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
      })
      .sort((left, right) => compareForeignKeys(left, right, identities))
    if (!foreignKeyArraysEqual(current, expected, identities)) {
      issues.push({
        identity,
        target: '',
        property: 'foreign_key',
        message: `Unsupported foreign key change for '${tableName}'`,
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
): Array<{ name: string; columns: string[]; unique: boolean }> {
  return (info.indexes ?? []).map((raw) => {
    const index = normalizeIndex(raw)
    return {
      name: index.name ?? defaultIndexName(info.name, index.columns),
      columns: [...index.columns],
      unique: index.unique ?? false,
    }
  })
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
function buildMigrationPlan(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  dialect: Dialect,
  registrationDefault?: readonly NamespaceIdentifierInput[],
): MigrationPlan {
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
  const sortedCatalogTables = [...catalog.tables].sort((left, right) =>
    compareCatalogTables(left, right, identities),
  )
  const existing = catalogTableMap(sortedCatalogTables, issues, identities)
  const ensuredSchemas = schemasPresentInCatalog(catalog, identities)
  const registered = identities.createRegistry<TableHandle>()
  const ownedSchemas: CanonicalRelationIdentity[] = []

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
    if (!ownedSchemas.some((owned) => sameNamespace(owned, identity))) {
      ownedSchemas.push(identity)
    }
    const live = existing.get(identity)
    let createAst: ReturnType<typeof buildCreateTableAst>
    try {
      createAst = buildCreateTableAst(handle, dialect)
    } catch (cause) {
      issues.push({
        identity,
        target: '',
        property: 'invalid_desired_table',
        message:
          cause instanceof Error
            ? cause.message
            : `Invalid desired table ${identities.format(identity)}`,
      })
      continue
    }
    const indexes = desiredIndexes(info)

    if (!live) {
      if (!ensuredSchemas.some((existing) => sameNamespace(existing, identity))) {
        steps.push({ kind: 'create_schema', schema: schemaFromIdentity(identity) })
        ensuredSchemas.push(identity)
      }

      steps.push({
        kind: 'create_table',
        ...schemaField(identity),
        table: info.name,
      })

      for (const index of indexes) {
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

    collectManagedPropertyIssues(live, createAst, dialect, issues, identities)

    const liveColumns = new Map(
      (live.columns ?? []).map((column) => [column.name, column]),
    )
    const desiredColumnNames = new Set(createAst.columns.map((column) => column.name))

    for (const desired of createAst.columns) {
      const current = liveColumns.get(desired.name)
      if (!current) {
        if (desired.references) {
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
          ...(desired.generated ? { generated: desired.generated } : {}),
          ...(desired.autoIncrement ? { autoIncrement: true } : {}),
        })
        continue
      }

      const desiredType = dialect.normalizeDataType(desired.dataType)
      const currentType = dialect.normalizeDataType(current.dataType)
      if (desiredType !== currentType) {
        steps.push({
          kind: 'alter_column_type',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
          dataType: desired.dataType,
        })
      }

      if (desired.notNull && current.isNullable) {
        steps.push({
          kind: 'set_not_null',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
        })
      } else if (!desired.notNull && !current.isNullable) {
        steps.push({
          kind: 'drop_not_null',
          ...schemaField(identity),
          table: info.name,
          column: desired.name,
        })
      }
    }

    for (const liveColumn of live.columns ?? []) {
      if (desiredColumnNames.has(liveColumn.name)) continue
      steps.push({
        kind: 'drop_column',
        ...schemaField(identity),
        table: info.name,
        column: liveColumn.name,
      })
    }

    const desiredIndexNames = new Set(indexes.map((index) => index.name))
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
    }
    for (const index of indexes) {
      const current = liveIndexes.get(index.name)
      if (!current) {
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
      if (
        current.unique !== index.unique ||
        !arraysEqual(current.columns, index.columns)
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

    for (const liveIndex of live.indexes ?? []) {
      if (desiredIndexNames.has(liveIndex.name)) continue
      steps.push({
        kind: 'drop_index',
        ...schemaField(identity),
        table: info.name,
        index: liveIndex.name,
      })
    }
  }

  steps.push(...deferredForeignKeys)

  for (const live of sortedCatalogTables) {
    const identity = identities.resolve(catalogRelationInput(live.schema, live.name))
    if (!ownedSchemas.some((owned) => sameNamespace(owned, identity))) continue
    if (registered.has(identity)) continue
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
    steps: steps.sort((left, right) => compareMigrationSteps(left, right, identities)),
  }
}

/**
 * Constructs a Migration Plan from registered tables and a catalog snapshot.
 * This interface is synchronous and performs no database operations.
 *
 * @example
 *   const plan = planMigration(
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
  } = {},
): MigrationPlan {
  try {
    return buildMigrationPlan(schemas, catalog, dialect, options.registrationDefault)
  } catch (cause) {
    if (cause instanceof MigrationError) throw cause
    throw new MigrationError({
      message: cause instanceof Error ? cause.message : 'Migration planning failed',
      ...(cause !== undefined ? { cause } : {}),
    })
  }
}
