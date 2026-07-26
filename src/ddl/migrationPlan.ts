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

function catalogTableMap(catalog: CatalogSnapshot): Map<string, CatalogTable> {
  const map = new Map<string, CatalogTable>()
  for (const table of catalog.tables) {
    map.set(tableKey(table.schema, table.name), table)
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

function findIndex(
  live: CatalogIndex[] | undefined,
  name: string,
): CatalogIndex | undefined {
  return live?.find((index) => index.name === name)
}

function normalizeAction(action: string | undefined): string {
  return action?.toLowerCase() ?? 'no action'
}

function assertDefaultMatch(
  tableName: string,
  columnName: string,
  live: CatalogColumn,
  desired: CreateTableColumnAst,
): void {
  if (live.defaultExpression === undefined) return
  const expected =
    desired.defaultValue === undefined
      ? null
      : normalizePostgresDefaultExpression(formatPostgresDefault(desired.defaultValue))
  if (live.defaultExpression !== expected) {
    throw new MigrationError({
      message: `Unsupported default change for '${tableName}.${columnName}'`,
    })
  }
}

function assertIdentityMatch(
  tableName: string,
  columnName: string,
  live: CatalogColumn,
  desired: CreateTableColumnAst,
): void {
  if (live.identityGeneration === undefined) return
  const expected = desired.generated ?? (desired.autoIncrement ? 'byDefault' : null)
  if (live.identityGeneration !== expected) {
    throw new MigrationError({
      message: `Unsupported identity change for '${tableName}.${columnName}'`,
    })
  }
}

function assertManagedPropertiesMatch(
  live: CatalogTable,
  desired: ReturnType<typeof buildCreateTableAst>,
): void {
  const tableName = `${effectiveSchema(live.schema)}.${live.name}`
  const liveColumns = new Map(live.columns.map((column) => [column.name, column]))

  for (const column of desired.columns) {
    const current = liveColumns.get(column.name)
    if (!current) continue
    assertDefaultMatch(tableName, column.name, current, column)
    assertIdentityMatch(tableName, column.name, current, column)
  }

  if (live.primaryKey !== undefined) {
    const current = live.primaryKey?.columns ?? []
    if (!arraysEqual(current, desired.primaryKey)) {
      throw new MigrationError({
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
      throw new MigrationError({
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
      throw new MigrationError({
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

/**
 * Constructs a Migration Plan from registered tables and a catalog snapshot.
 * This interface is synchronous and performs no database operations.
 */
export function planMigration(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
): MigrationPlan {
  const steps: MigrationStep[] = []
  const deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[] = []
  const existing = catalogTableMap(catalog)
  const ensuredSchemas = schemasPresentInCatalog(catalog)
  const registeredKeys = new Set<string>()
  const ownedSchemas = new Set<string>()

  for (const handle of schemas) {
    const info = handle.getTableMetadata()
    const key = tableKey(info.schema, info.name)
    registeredKeys.add(key)
    const schemaName = effectiveSchema(info.schema)
    ownedSchemas.add(schemaName)
    const live = existing.get(key)
    const createAst = buildCreateTableAst(handle)

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

    assertManagedPropertiesMatch(live, createAst)

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
    for (const raw of info.indexes ?? []) {
      const index = normalizeIndex(raw)
      const name = index.name ?? defaultIndexName(info.name, index.columns)
      const current = findIndex(live.indexes, name)
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
        throw new MigrationError({
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

  for (const live of catalog.tables) {
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

  return { steps }
}
