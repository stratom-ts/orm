import { normalizePostgresDataType } from '@/dialects/postgres/normalize'
import {
  formatPostgresDefault,
  normalizePostgresDefaultExpression,
} from '@/dialects/postgres/validate'
import type {
  CatalogColumn,
  CatalogIndex,
  CatalogSnapshot,
  CatalogTable,
  CreateTableColumnAst,
} from '@/dialects/types'
import { normalizeIndex } from '@/schemas/utils/normalizeIndex'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'
import { DEFAULT_PG_SCHEMA, effectiveSchema, tableKey } from '@/utils/tableKey'

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
  schema: string
  table: string
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

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function stepTarget(step: MigrationStep): readonly string[] {
  if (step.kind === 'create_schema') return [step.schema]

  const identity = 'column' in step ? step.column : 'index' in step ? step.index : ''
  return [effectiveSchema(step.schema), step.table, identity]
}

function compareMigrationSteps(left: MigrationStep, right: MigrationStep): number {
  const phase = MIGRATION_PHASE[left.kind] - MIGRATION_PHASE[right.kind]
  if (phase !== 0) return phase

  const leftTarget = stepTarget(left)
  const rightTarget = stepTarget(right)
  for (let index = 0; index < leftTarget.length; index++) {
    const target = compareCodeUnits(leftTarget[index]!, rightTarget[index]!)
    if (target !== 0) return target
  }
  return 0
}

function comparePlanningIssues(left: PlanningIssue, right: PlanningIssue): number {
  for (const [leftPart, rightPart] of [
    [left.schema, right.schema],
    [left.table, right.table],
    [left.target, right.target],
  ] as const) {
    const target = compareCodeUnits(leftPart, rightPart)
    if (target !== 0) return target
  }
  return (
    ISSUE_PROPERTY_ORDER[left.property] - ISSUE_PROPERTY_ORDER[right.property] ||
    compareCodeUnits(left.message, right.message)
  )
}

function compareTableHandles(left: TableHandle, right: TableHandle): number {
  const leftInfo = left.getTableMetadata()
  const rightInfo = right.getTableMetadata()
  return (
    compareCodeUnits(
      effectiveSchema(leftInfo.schema),
      effectiveSchema(rightInfo.schema),
    ) || compareCodeUnits(leftInfo.name, rightInfo.name)
  )
}

function compareCatalogTables(left: CatalogTable, right: CatalogTable): number {
  return (
    compareCodeUnits(effectiveSchema(left.schema), effectiveSchema(right.schema)) ||
    compareCodeUnits(left.name, right.name)
  )
}

function catalogTableMap(
  tables: readonly CatalogTable[],
  issues: PlanningIssue[],
): Map<string, CatalogTable> {
  const map = new Map<string, CatalogTable>()
  for (const table of tables) {
    const key = tableKey(table.schema, table.name)
    if (map.has(key)) {
      issues.push({
        schema: effectiveSchema(table.schema),
        table: table.name,
        target: '',
        property: 'duplicate_catalog_table',
        message: `Duplicate catalog table '${key}'`,
      })
      continue
    }
    map.set(key, table)
  }
  return map
}

function schemasPresentInCatalog(catalog: CatalogSnapshot): Set<string> {
  const schemas = new Set<string>([DEFAULT_PG_SCHEMA])
  for (const table of catalog.tables) {
    schemas.add(effectiveSchema(table.schema))
  }
  return schemas
}

function defaultIndexName(table: string, columns: string[]): string {
  return `${table}_${columns.join('_')}_idx`
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

function normalizeAction(action: string | undefined): string {
  return action?.toLowerCase() ?? 'no action'
}

function defaultMismatch(
  tableName: string,
  columnName: string,
  live: CatalogColumn,
  desired: CreateTableColumnAst,
): string | undefined {
  if (live.defaultExpression === undefined) return
  const expected =
    desired.defaultValue === undefined
      ? null
      : normalizePostgresDefaultExpression(formatPostgresDefault(desired.defaultValue))
  if (live.defaultExpression !== expected) {
    return `Unsupported default change for '${tableName}.${columnName}'`
  }
}

function identityMismatch(
  tableName: string,
  columnName: string,
  live: CatalogColumn,
  desired: CreateTableColumnAst,
): string | undefined {
  if (live.identityGeneration === undefined) return
  const expected = desired.generated ?? (desired.autoIncrement ? 'byDefault' : null)
  if (live.identityGeneration !== expected) {
    return `Unsupported identity change for '${tableName}.${columnName}'`
  }
}

function collectManagedPropertyIssues(
  live: CatalogTable,
  desired: ReturnType<typeof buildCreateTableAst>,
  issues: PlanningIssue[],
): void {
  const schema = effectiveSchema(live.schema)
  const tableName = `${schema}.${live.name}`
  const liveColumns = new Map<string, CatalogColumn>()

  for (const column of live.columns) {
    if (liveColumns.has(column.name)) {
      issues.push({
        schema,
        table: live.name,
        target: column.name,
        property: 'duplicate_catalog_column',
        message: `Duplicate catalog column '${tableName}.${column.name}'`,
      })
      continue
    }
    liveColumns.set(column.name, column)
  }

  for (const column of desired.columns) {
    const current = liveColumns.get(column.name)
    if (!current) continue
    const defaultMessage = defaultMismatch(tableName, column.name, current, column)
    if (defaultMessage) {
      issues.push({
        schema,
        table: live.name,
        target: column.name,
        property: 'default',
        message: defaultMessage,
      })
    }
    const identityMessage = identityMismatch(tableName, column.name, current, column)
    if (identityMessage) {
      issues.push({
        schema,
        table: live.name,
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
        schema,
        table: live.name,
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
        schema,
        table: live.name,
        target: '',
        property: 'unique_constraint',
        message: `Unsupported unique constraint change for '${tableName}'`,
      })
    }
  }

  if (live.foreignKeys !== undefined) {
    const current = live.foreignKeys
      .map((foreignKey) =>
        [
          foreignKey.columns.join(','),
          effectiveSchema(foreignKey.referencedSchema),
          foreignKey.referencedTable,
          foreignKey.referencedColumns.join(','),
          normalizeAction(foreignKey.onDelete),
          normalizeAction(foreignKey.onUpdate),
        ].join('\0'),
      )
      .sort()
    const expected = desired.columns
      .filter((column) => column.references !== undefined)
      .map((column) => {
        const reference = column.references!
        return [
          column.name,
          effectiveSchema(reference.schema),
          reference.table,
          reference.column,
          normalizeAction(reference.onDelete),
          normalizeAction(reference.onUpdate),
        ].join('\0')
      })
      .sort()
    if (!arraysEqual(current, expected)) {
      issues.push({
        schema,
        table: live.name,
        target: '',
        property: 'foreign_key',
        message: `Unsupported foreign key change for '${tableName}'`,
      })
    }
  }
}

function schemaField(
  schema: string | undefined,
): { schema: string } | Record<string, never> {
  return schema !== undefined ? { schema } : {}
}

function desiredIndexNames(handle: TableHandle): Set<string> {
  const names = new Set<string>()
  const info = handle.getTableMetadata()
  for (const raw of info.indexes ?? []) {
    const index = normalizeIndex(raw)
    const name = index.name ?? defaultIndexName(info.name, index.columns)
    names.add(name)
  }
  return names
}

function buildMigrationPlan(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
): MigrationPlan {
  const steps: MigrationStep[] = []
  const deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[] = []
  const issues: PlanningIssue[] = []
  const sortedSchemas = [...schemas].sort(compareTableHandles)
  const sortedCatalogTables = [...catalog.tables].sort(compareCatalogTables)
  const existing = catalogTableMap(sortedCatalogTables, issues)
  const ensuredSchemas = schemasPresentInCatalog(catalog)
  const registeredKeys = new Set<string>()
  const ownedSchemas = new Set<string>()

  for (const handle of sortedSchemas) {
    const info = handle.getTableMetadata()
    const key = tableKey(info.schema, info.name)
    if (registeredKeys.has(key)) {
      issues.push({
        schema: effectiveSchema(info.schema),
        table: info.name,
        target: '',
        property: 'duplicate_registered_table',
        message: `Duplicate registered table '${key}'`,
      })
    }
    registeredKeys.add(key)
    const schemaName = effectiveSchema(info.schema)
    ownedSchemas.add(schemaName)
    const live = existing.get(key)
    let createAst: ReturnType<typeof buildCreateTableAst>
    try {
      createAst = buildCreateTableAst(handle)
    } catch (cause) {
      issues.push({
        schema: schemaName,
        table: info.name,
        target: '',
        property: 'invalid_desired_table',
        message:
          cause instanceof Error ? cause.message : `Invalid desired table '${key}'`,
      })
      continue
    }

    if (!live) {
      if (schemaName !== DEFAULT_PG_SCHEMA && !ensuredSchemas.has(schemaName)) {
        steps.push({ kind: 'create_schema', schema: schemaName })
        ensuredSchemas.add(schemaName)
      }

      steps.push({
        kind: 'create_table',
        ...schemaField(info.schema),
        table: info.name,
      })

      for (const raw of info.indexes ?? []) {
        const index = normalizeIndex(raw)
        const name = index.name ?? defaultIndexName(info.name, index.columns)
        steps.push({
          kind: 'create_index',
          ...schemaField(info.schema),
          table: info.name,
          index: name,
          columns: [...index.columns],
          unique: index.unique ?? false,
        })
      }

      for (const column of createAst.columns) {
        if (!column.references) continue
        deferredForeignKeys.push({
          kind: 'add_foreign_key',
          ...schemaField(info.schema),
          table: info.name,
          column: column.name,
          references: { ...column.references },
        })
      }
      continue
    }

    collectManagedPropertyIssues(live, createAst, issues)

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
            ...schemaField(info.schema),
            table: info.name,
            column: desired.name,
            references: { ...desired.references },
          })
        }
        steps.push({
          kind: 'add_column',
          ...schemaField(info.schema),
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

      const desiredType = normalizePostgresDataType(desired.dataType)
      const currentType = normalizePostgresDataType(current.dataType)
      if (desiredType !== currentType) {
        steps.push({
          kind: 'alter_column_type',
          ...schemaField(info.schema),
          table: info.name,
          column: desired.name,
          dataType: desired.dataType,
        })
      }

      if (desired.notNull && current.isNullable) {
        steps.push({
          kind: 'set_not_null',
          ...schemaField(info.schema),
          table: info.name,
          column: desired.name,
        })
      } else if (!desired.notNull && !current.isNullable) {
        steps.push({
          kind: 'drop_not_null',
          ...schemaField(info.schema),
          table: info.name,
          column: desired.name,
        })
      }
    }

    for (const liveColumn of live.columns ?? []) {
      if (desiredColumnNames.has(liveColumn.name)) continue
      steps.push({
        kind: 'drop_column',
        ...schemaField(info.schema),
        table: info.name,
        column: liveColumn.name,
      })
    }

    const desiredIndexes = desiredIndexNames(handle)
    const liveIndexes = new Map<string, CatalogIndex>()
    for (const liveIndex of live.indexes ?? []) {
      if (liveIndexes.has(liveIndex.name)) {
        issues.push({
          schema: schemaName,
          table: info.name,
          target: liveIndex.name,
          property: 'duplicate_catalog_index',
          message: `Duplicate catalog index '${schemaName}.${liveIndex.name}'`,
        })
        continue
      }
      liveIndexes.set(liveIndex.name, liveIndex)
    }
    for (const raw of info.indexes ?? []) {
      const index = normalizeIndex(raw)
      const name = index.name ?? defaultIndexName(info.name, index.columns)
      const current = liveIndexes.get(name)
      if (!current) {
        steps.push({
          kind: 'create_index',
          ...schemaField(info.schema),
          table: info.name,
          index: name,
          columns: [...index.columns],
          unique: index.unique ?? false,
        })
        continue
      }
      if (
        current.unique !== (index.unique ?? false) ||
        !arraysEqual(current.columns, index.columns)
      ) {
        issues.push({
          schema: schemaName,
          table: info.name,
          target: name,
          property: 'index_definition',
          message: `Unsupported index definition change for '${schemaName}.${name}'`,
        })
      }
    }

    for (const liveIndex of live.indexes ?? []) {
      if (desiredIndexes.has(liveIndex.name)) continue
      steps.push({
        kind: 'drop_index',
        ...schemaField(info.schema),
        table: info.name,
        index: liveIndex.name,
      })
    }
  }

  steps.push(...deferredForeignKeys)

  for (const live of sortedCatalogTables) {
    const liveSchema = effectiveSchema(live.schema)
    if (!ownedSchemas.has(liveSchema)) continue
    const key = tableKey(live.schema, live.name)
    if (registeredKeys.has(key)) continue
    steps.push({
      kind: 'drop_table',
      ...schemaField(live.schema),
      table: live.name,
    })
  }

  const issue = issues.sort(comparePlanningIssues)[0]
  if (issue) throw new MigrationError({ message: issue.message })

  return { steps: steps.sort(compareMigrationSteps) }
}

/**
 * Constructs a Migration Plan from registered tables and a catalog snapshot.
 * This interface is synchronous and performs no database operations.
 */
export function planMigration(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
): MigrationPlan {
  try {
    return buildMigrationPlan(schemas, catalog)
  } catch (cause) {
    if (cause instanceof MigrationError) throw cause
    throw new MigrationError({
      message: cause instanceof Error ? cause.message : 'Migration planning failed',
      ...(cause !== undefined ? { cause } : {}),
    })
  }
}
