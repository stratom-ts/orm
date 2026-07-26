import type {
  CatalogColumn,
  CatalogIndex,
  CatalogSnapshot,
  CatalogTable,
  CreateSchemaAst,
  CreateTableColumnAst,
  Dialect,
  SqlAst,
} from '@/dialects'
import type { Executor } from '@/query'
import { normalizeIndex } from '@/schemas'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'
import { DEFAULT_PG_SCHEMA, effectiveSchema, tableKey } from '@/utils/tableKey'

import { buildCreateTableAst } from './createTable'

/** Destructive migrate operations that require an explicit allowlist. */
export type MigrationAllow = 'dropColumn' | 'dropTable' | 'dropIndex'

/**
 * Stable Postgres session advisory lock keys for Stratom migrate execute.
 * Two-int form so values stay within safe 32-bit integers in JS.
 */
export const MIGRATE_ADVISORY_LOCK_CLASS = 0x7363_686d // 'schm'
export const MIGRATE_ADVISORY_LOCK_ID = 0x6f72_6d00 // 'orm\0'

/** Structured desired-state migration plan step (stable kinds + targets). */
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

export type MigrateBuilder = {
  allow(...ops: MigrationAllow[]): MigrateBuilder
  dryRun(): Promise<MigrationPlan>
  execute(): Promise<void>
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

/**
 * Generates a default index name from table and column names.
 *
 * @example
 *   defaultIndexName('users', ['email']) // 'users_email_idx'
 *
 * @param table - Table name.
 * @param columns - Column names in the index.
 *
 * @returns Default index name in the form `table_columns_idx`
 */
function defaultIndexName(table: string, columns: string[]): string {
  return `${table}_${columns.join('_')}_idx`
}

/**
 * Checks whether two string arrays are equal element-by-element.
 *
 * @example
 *   arraysEqual(['a', 'b'], ['a', 'b']) // true
 *   arraysEqual(['a'], ['b']) // false
 *
 * @param left - First array.
 * @param right - Second array.
 *
 * @returns `true` when both arrays have the same length and elements
 */
function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

/**
 * Finds an index by name in a catalog index array.
 *
 * @example
 *   const idx = findIndex(catalogTable.indexes, 'users_email_idx')
 *
 * @param live - Array of catalog indexes, or `undefined`.
 * @param name - Index name to find.
 *
 * @returns Matching catalog index, or `undefined` when not found
 */
function findIndex(
  live: CatalogIndex[] | undefined,
  name: string,
): CatalogIndex | undefined {
  return live?.find((index) => index.name === name)
}

function normalizeAction(action: string | undefined): string {
  return action?.toLowerCase() ?? 'no action'
}

/**
 * Asserts that a column's default value matches between live and desired states.
 *
 * @example
 *   assertDefaultMatch('public.users', 'status', liveCol, desiredCol, dialect)
 *
 * @param tableName - Fully qualified table name for error context.
 * @param columnName - Column name for error context.
 * @param live - Live catalog column.
 * @param desired - Desired column AST.
 * @param dialect - SQL dialect for default normalization.
 *
 * @throws MigrationError - When the default value cannot be compared or has changed
 */
function assertDefaultMatch(
  tableName: string,
  columnName: string,
  live: CatalogColumn,
  desired: CreateTableColumnAst,
  dialect: Dialect,
): void {
  if (live.defaultExpression === undefined) return
  const expected =
    desired.defaultValue === undefined
      ? null
      : dialect.normalizeDefaultValue?.(desired.defaultValue)
  if (desired.defaultValue !== undefined && expected === undefined) {
    throw new MigrationError({
      message: `Cannot compare default for '${tableName}.${columnName}': dialect does not normalize defaults`,
    })
  }
  if (live.defaultExpression !== expected) {
    throw new MigrationError({
      message: `Unsupported default change for '${tableName}.${columnName}'`,
    })
  }
}

/**
 * Asserts that a column's identity generation matches between live and desired states.
 *
 * @example
 *   assertIdentityMatch('public.users', 'id', liveCol, desiredCol)
 *
 * @param tableName - Fully qualified table name for error context.
 * @param columnName - Column name for error context.
 * @param live - Live catalog column.
 * @param desired - Desired column AST.
 *
 * @throws MigrationError - When the identity generation has changed
 */
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

/**
 * Asserts that managed table properties (defaults, identity, PK, unique, FKs) match.
 *
 * @example
 *   assertManagedPropertiesMatch(catalogTable, desiredAst, dialect)
 *
 * @param live - Live catalog table.
 * @param desired - Desired create-table AST.
 * @param dialect - SQL dialect for default normalization.
 *
 * @throws MigrationError - When any managed property has changed
 */
function assertManagedPropertiesMatch(
  live: CatalogTable,
  desired: ReturnType<typeof buildCreateTableAst>,
  dialect: Dialect,
): void {
  const tableName = `${effectiveSchema(live.schema)}.${live.name}`
  const liveColumns = new Map(live.columns.map((column) => [column.name, column]))

  for (const column of desired.columns) {
    const current = liveColumns.get(column.name)
    if (!current) continue
    assertDefaultMatch(tableName, column.name, current, column, dialect)
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

function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`
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
 * Refuse SET NOT NULL when the column already has NULL rows.
 * dryRun may still list the step; execute must check before applying.
 */
async function assertColumnHasNoNulls(
  executor: Executor,
  step: Extract<MigrationStep, { kind: 'set_not_null' }>,
): Promise<void> {
  const schemaName = effectiveSchema(step.schema)
  const tableSql = `${quoteIdent(schemaName)}.${quoteIdent(step.table)}`
  const columnSql = quoteIdent(step.column)
  const rows = await executor.execute({
    sql: `select count(*)::int as count from ${tableSql} where ${columnSql} is null`,
    params: [],
  })
  const raw = rows[0] as { count?: unknown } | undefined
  const count = Number(raw?.count ?? 0)
  if (count > 0) {
    throw new MigrationError({
      message: `Cannot set column '${schemaName}.${step.table}.${step.column}' as NOT NULL - column has NULL values`,
    })
  }
}

/**
 * Refuse DROP COLUMN when the column has any non-null data unless allowed.
 * When allow('dropColumn') is set, skip this check.
 */
async function assertColumnHasNoData(
  executor: Executor,
  step: Extract<MigrationStep, { kind: 'drop_column' }>,
): Promise<void> {
  const schemaName = effectiveSchema(step.schema)
  const tableSql = `${quoteIdent(schemaName)}.${quoteIdent(step.table)}`
  const columnSql = quoteIdent(step.column)
  const rows = await executor.execute({
    sql: `select count(*)::int as count from ${tableSql} where ${columnSql} is not null`,
    params: [],
  })
  const raw = rows[0] as { count?: unknown } | undefined
  const count = Number(raw?.count ?? 0)
  if (count > 0) {
    throw new MigrationError({
      message: `Cannot drop column '${schemaName}.${step.table}.${step.column}' - column has non-null data. Use allow('dropColumn') or migrate data first.`,
    })
  }
}

function allowForStep(step: MigrationStep): MigrationAllow | null {
  switch (step.kind) {
    case 'drop_column':
      return 'dropColumn'
    case 'drop_table':
      return 'dropTable'
    case 'drop_index':
      return 'dropIndex'
    default:
      return null
  }
}

/**
 * Diff registered handles against a catalog snapshot into structured plan steps.
 * Destructive drops are included only when the corresponding allow flag is set.
 * Without allow, drop_column with data is refused at execute; orphan tables/indexes
 * are never planned unless allow('dropTable'|'dropIndex').
 *
 * @example
 *   const plan = planMigration([User, Post], catalog, dialect)
 *   console.log(plan.steps) // MigrationStep[]
 *
 * @param schemas - Registered table handles to diff against the catalog.
 * @param catalog - Live catalog snapshot from introspection.
 * @param dialect - SQL dialect for type comparison.
 * @param allowed - Set of allowed destructive operations.
 *
 * @returns Migration plan with ordered steps
 */
export function planMigration(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  dialect: Dialect,
  allowed: ReadonlySet<MigrationAllow> = new Set(),
): MigrationPlan {
  const steps: MigrationStep[] = []
  const deferredForeignKeys: Extract<MigrationStep, { kind: 'add_foreign_key' }>[] = []
  const existing = catalogTableMap(catalog)
  const ensuredSchemas = schemasPresentInCatalog(catalog)
  const registeredKeys = new Set<string>()
  // Schemas owned by registered handles — dropTable must not touch other apps' schemas.
  const ownedSchemas = new Set<string>()

  for (const handle of schemas) {
    const info = handle.getTableMetadata()
    const key = tableKey(info.schema, info.name)
    registeredKeys.add(key)
    const schemaName = effectiveSchema(info.schema)
    ownedSchemas.add(schemaName)
    const live = existing.get(key)
    const createAst = buildCreateTableAst(handle, dialect)

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

    assertManagedPropertiesMatch(live, createAst, dialect)

    const liveColumns = new Map(
      (live.columns ?? []).map((column) => [column.name, column]),
    )
    const desiredColumnNames = new Set(createAst.columns.map((c) => c.name))

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

      const desiredType = dialect.normalizeDataType(desired.dataType)
      const currentType = dialect.normalizeDataType(current.dataType)
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

    // Columns present live but not in desired schema → drop_column (if allowed)
    for (const liveCol of live.columns ?? []) {
      if (desiredColumnNames.has(liveCol.name)) continue
      if (allowed.has('dropColumn')) {
        steps.push({
          kind: 'drop_column',
          ...schemaField(info.schema),
          table: info.name,
          column: liveCol.name,
        })
      }
      // Without allow: omit from plan. execute of a forced drop is gated separately.
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

    // Live indexes not in metadata → drop_index (if allowed)
    if (allowed.has('dropIndex')) {
      for (const liveIdx of live.indexes ?? []) {
        if (desiredIndexes.has(liveIdx.name)) continue
        steps.push({
          kind: 'drop_index',
          ...schemaField(info.schema),
          table: info.name,
          index: liveIdx.name,
        })
      }
    }
  }

  steps.push(...deferredForeignKeys)

  // Orphan tables in owned schemas only — never drop tables in schemas no
  // registered handle uses (shared DBs may hold unrelated apps/tools).
  if (allowed.has('dropTable')) {
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
  }

  return { steps }
}

/**
 * When drop_column is needed but not allowed, surface MigrationError on execute
 * if the column still has data. Empty columns could be dropped safely without
 * allow per design ("Only if data-safe"), so we plan those only at execute time
 * after data check — for dryRun without allow we omit destructive steps.
 *
 * For execute without allow: after building the safe plan, scan live columns
 * removed from registry and either drop if empty or throw MigrationError.
 *
 * @example
 *   const extraDrops = await planUnsafeDropColumns(schemas, catalog, dialect, executor, allowed)
 *
 * @param schemas - Registered table handles.
 * @param catalog - Live catalog snapshot.
 * @param dialect - SQL dialect for AST generation.
 * @param executor - Database executor for data checks.
 * @param allowed - Set of allowed destructive operations.
 *
 * @returns Additional drop_column steps for empty columns
 */
async function planUnsafeDropColumns(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  dialect: Dialect,
  executor: Executor,
  allowed: ReadonlySet<MigrationAllow>,
): Promise<MigrationStep[]> {
  if (allowed.has('dropColumn')) return []

  const existing = catalogTableMap(catalog)
  const extra: MigrationStep[] = []

  for (const handle of schemas) {
    const info = handle.getTableMetadata()
    const key = tableKey(info.schema, info.name)
    const live = existing.get(key)
    if (!live) continue
    const createAst = buildCreateTableAst(handle, dialect)
    const desiredColumnNames = new Set(createAst.columns.map((c) => c.name))

    for (const liveCol of live.columns ?? []) {
      if (desiredColumnNames.has(liveCol.name)) continue
      const step: Extract<MigrationStep, { kind: 'drop_column' }> = {
        kind: 'drop_column',
        ...schemaField(info.schema),
        table: info.name,
        column: liveCol.name,
      }
      // Data-safe empty column: allow drop without allowlist
      // Non-null data: refuse with MigrationError
      try {
        await assertColumnHasNoData(executor, step)
        extra.push(step)
      } catch (error) {
        if (error instanceof MigrationError) throw error
        throw error
      }
    }
  }

  return extra
}

/**
 * Converts a migration step to a SQL AST node for compilation.
 *
 * @example
 *   const ast = stepToAst({ kind: 'create_table', table: 'users' }, handles, dialect)
 *
 * @param step - Migration step to convert.
 * @param handles - Map of table key to table handle.
 * @param dialect - SQL dialect for type inference.
 *
 * @returns SQL AST node ready for compilation
 *
 * @throws MigrationError - When the step references an unregistered handle
 */
function stepToAst(
  step: MigrationStep,
  handles: Map<string, TableHandle>,
  dialect: Dialect,
): SqlAst {
  switch (step.kind) {
    case 'create_schema': {
      const ast: CreateSchemaAst = {
        kind: 'create_schema',
        schema: step.schema,
      }
      return ast
    }
    case 'create_table': {
      const key = tableKey(step.schema, step.table)
      const handle = handles.get(key)
      if (!handle) {
        throw new MigrationError({
          message: `cannot create table "${key}": handle not registered`,
        })
      }
      const ast = buildCreateTableAst(handle, dialect)
      return {
        ...ast,
        columns: ast.columns.map((column) => ({ ...column, references: undefined })),
      }
    }
    case 'add_column':
      return {
        kind: 'add_column',
        ...schemaField(step.schema),
        table: step.table,
        column: {
          name: step.column,
          dataType: step.dataType,
          notNull: step.notNull,
          unique: step.unique ?? false,
          autoIncrement: step.autoIncrement ?? false,
          ...(step.defaultValue !== undefined ? { defaultValue: step.defaultValue } : {}),
          ...(step.generated ? { generated: step.generated } : {}),
          ...(step.references ? { references: step.references } : {}),
        },
      }
    case 'alter_column_type':
      return {
        kind: 'alter_column_type',
        ...schemaField(step.schema),
        table: step.table,
        column: step.column,
        dataType: step.dataType,
      }
    case 'add_foreign_key':
      return {
        kind: 'add_foreign_key',
        ...schemaField(step.schema),
        table: step.table,
        column: step.column,
        references: step.references,
      }
    case 'set_not_null':
      return {
        kind: 'set_not_null',
        ...schemaField(step.schema),
        table: step.table,
        column: step.column,
      }
    case 'drop_not_null':
      return {
        kind: 'drop_not_null',
        ...schemaField(step.schema),
        table: step.table,
        column: step.column,
      }
    case 'create_index':
      return {
        kind: 'create_index',
        ...schemaField(step.schema),
        table: step.table,
        name: step.index,
        columns: step.columns,
        unique: step.unique,
      }
    case 'drop_column':
      return {
        kind: 'drop_column',
        ...schemaField(step.schema),
        table: step.table,
        column: step.column,
      }
    case 'drop_table':
      return {
        kind: 'drop_table',
        ...schemaField(step.schema),
        table: step.table,
      }
    case 'drop_index':
      return {
        kind: 'drop_index',
        ...schemaField(step.schema),
        table: step.table,
        index: step.index,
      }
  }
}

async function acquireMigrateLock(executor: Executor): Promise<void> {
  try {
    await executor.run({
      sql: `select pg_advisory_lock(${MIGRATE_ADVISORY_LOCK_CLASS}, ${MIGRATE_ADVISORY_LOCK_ID})`,
      params: [],
    })
  } catch (cause) {
    throw new MigrationError({
      message:
        cause instanceof Error
          ? `Failed to acquire migrate advisory lock: ${cause.message}`
          : 'Failed to acquire migrate advisory lock',
      ...(cause !== undefined ? { cause } : {}),
    })
  }
}

async function releaseMigrateLock(executor: Executor): Promise<void> {
  try {
    await executor.run({
      sql: `select pg_advisory_unlock(${MIGRATE_ADVISORY_LOCK_CLASS}, ${MIGRATE_ADVISORY_LOCK_ID})`,
      params: [],
    })
  } catch {
    // best-effort unlock
  }
}

/**
 * Desired-state migrate: dry-run plan + execute converge with safe defaults,
 * explicit destructive allowlist, and Postgres advisory lock on execute.
 *
 * @example
 *   const migrate = createMigrateBuilder({ schemas: [User], dialect, executor })
 *   const plan = await migrate.allow('dropColumn').dryRun()
 *   await migrate.allow('dropColumn').execute()
 *
 * @param options - Builder configuration including schemas, dialect, executor, and
 *   optional assertCanExecute.
 *
 * @returns Migrate builder with `allow`, `dryRun`, and `execute` methods
 */
export function createMigrateBuilder(options: {
  schemas: readonly TableHandle[]
  dialect: Dialect
  executor: Executor
  assertCanExecute?: () => void
}): MigrateBuilder {
  const { schemas, dialect, executor, assertCanExecute } = options
  const handles = new Map<string, TableHandle>()
  for (const handle of schemas) {
    const info = handle.getTableMetadata()
    handles.set(tableKey(info.schema, info.name), handle)
  }

  const allowed = new Set<MigrationAllow>()

  const buildPlan = async (): Promise<MigrationPlan> => {
    const catalog = await dialect.introspect(executor)
    return planMigration(schemas, catalog, dialect, allowed)
  }

  const builder: MigrateBuilder = {
    allow(...ops: MigrationAllow[]) {
      for (const op of ops) {
        allowed.add(op)
      }
      return builder
    },

    async dryRun() {
      try {
        return await buildPlan()
      } catch (cause) {
        if (cause instanceof MigrationError) throw cause
        throw new MigrationError({
          message: cause instanceof Error ? cause.message : 'Migration dry-run failed',
          ...(cause !== undefined ? { cause } : {}),
        })
      }
    },

    async execute() {
      assertCanExecute?.()
      await acquireMigrateLock(executor)
      try {
        const catalog = await dialect.introspect(executor)
        const plan = planMigration(schemas, catalog, dialect, allowed)

        // Without allow('dropColumn'): data-safe empty drops may still apply;
        // columns with data throw MigrationError.
        let extraDrops: MigrationStep[] = []
        try {
          extraDrops = await planUnsafeDropColumns(
            schemas,
            catalog,
            dialect,
            executor,
            allowed,
          )
        } catch (cause) {
          if (cause instanceof MigrationError) throw cause
          throw new MigrationError({
            message: cause instanceof Error ? cause.message : 'Migration failed',
            ...(cause !== undefined ? { cause } : {}),
          })
        }

        const steps = [...plan.steps, ...extraDrops]
        if (steps.length === 0) return

        await executor.run({ sql: 'begin', params: [] })
        try {
          for (const step of steps) {
            if (step.kind === 'set_not_null') {
              await assertColumnHasNoNulls(executor, step)
            }
            // Guard: never apply destructive work absent from the dry-run allowlist.
            const need = allowForStep(step)
            if (need && !allowed.has(need)) {
              throw new MigrationError({
                message: `Destructive migration step '${step.kind}' requires allow('${need}')`,
              })
            }
            const ast = stepToAst(step, handles, dialect)
            await executor.run(dialect.compile(ast))
          }
          await executor.run({ sql: 'commit', params: [] })
        } catch (error) {
          try {
            await executor.run({ sql: 'rollback', params: [] })
          } catch {
            // ignore rollback failures
          }
          throw error
        }
      } catch (cause) {
        if (cause instanceof MigrationError) throw cause
        throw new MigrationError({
          message: cause instanceof Error ? cause.message : 'Migration failed',
          ...(cause !== undefined ? { cause } : {}),
        })
      } finally {
        await releaseMigrateLock(executor)
      }
    },
  }

  return builder
}
