import type {
  CatalogIndex,
  CatalogSnapshot,
  CatalogTable,
  CreateSchemaAst,
  Dialect,
  SqlAst,
} from '@/dialects'
import type { TableHandle } from '@/types'
import type { Executor } from '@/query'
import { normalizeIndex } from '@/schemas'
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

function defaultIndexName(table: string, columns: string[]): string {
  return `${table}_${columns.join('_')}_idx`
}

function indexExists(live: CatalogIndex[] | undefined, name: string): boolean {
  if (!live?.length) return false
  return live.some((idx) => idx.name === name)
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
  for (const raw of handle.metadata.indexes ?? []) {
    const index = normalizeIndex(raw)
    const name = index.name ?? defaultIndexName(handle.name, index.columns)
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
 */
export function planMigration(
  schemas: readonly TableHandle[],
  catalog: CatalogSnapshot,
  dialect: Dialect,
  allowed: ReadonlySet<MigrationAllow> = new Set(),
): MigrationPlan {
  const steps: MigrationStep[] = []
  const existing = catalogTableMap(catalog)
  const ensuredSchemas = schemasPresentInCatalog(catalog)
  const registeredKeys = new Set<string>()
  // Schemas owned by registered handles — dropTable must not touch other apps' schemas.
  const ownedSchemas = new Set<string>()

  for (const handle of schemas) {
    const key = tableKey(handle.schema, handle.name)
    registeredKeys.add(key)
    const schemaName = effectiveSchema(handle.schema)
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
        ...schemaField(handle.schema),
        table: handle.name,
      })

      for (const raw of handle.metadata.indexes ?? []) {
        const index = normalizeIndex(raw)
        const name = index.name ?? defaultIndexName(handle.name, index.columns)
        steps.push({
          kind: 'create_index',
          ...schemaField(handle.schema),
          table: handle.name,
          index: name,
          columns: [...index.columns],
          unique: index.unique ?? false,
        })
      }
      continue
    }

    const liveColumns = new Map(
      (live.columns ?? []).map((column) => [column.name, column]),
    )
    const desiredColumnNames = new Set(createAst.columns.map((c) => c.name))

    for (const desired of createAst.columns) {
      const current = liveColumns.get(desired.name)
      if (!current) {
        steps.push({
          kind: 'add_column',
          ...schemaField(handle.schema),
          table: handle.name,
          column: desired.name,
          dataType: desired.dataType,
          notNull: desired.notNull,
          ...(desired.unique ? { unique: true } : {}),
          ...(desired.defaultValue !== undefined
            ? { defaultValue: desired.defaultValue }
            : {}),
          ...(desired.generated ? { generated: desired.generated } : {}),
          ...(desired.autoIncrement ? { autoIncrement: true } : {}),
          ...(desired.references
            ? {
                references: {
                  table: desired.references.table,
                  column: desired.references.column,
                  ...(desired.references.schema !== undefined
                    ? { schema: desired.references.schema }
                    : {}),
                  ...(desired.references.onDelete
                    ? { onDelete: desired.references.onDelete }
                    : {}),
                  ...(desired.references.onUpdate
                    ? { onUpdate: desired.references.onUpdate }
                    : {}),
                },
              }
            : {}),
        })
        continue
      }

      const desiredType = dialect.normalizeDataType(desired.dataType)
      const currentType = dialect.normalizeDataType(current.dataType)
      if (desiredType !== currentType) {
        steps.push({
          kind: 'alter_column_type',
          ...schemaField(handle.schema),
          table: handle.name,
          column: desired.name,
          dataType: desired.dataType,
        })
      }

      if (desired.notNull && current.isNullable) {
        steps.push({
          kind: 'set_not_null',
          ...schemaField(handle.schema),
          table: handle.name,
          column: desired.name,
        })
      } else if (!desired.notNull && !current.isNullable) {
        steps.push({
          kind: 'drop_not_null',
          ...schemaField(handle.schema),
          table: handle.name,
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
          ...schemaField(handle.schema),
          table: handle.name,
          column: liveCol.name,
        })
      }
      // Without allow: omit from plan. execute of a forced drop is gated separately.
    }

    const desiredIndexes = desiredIndexNames(handle)
    for (const raw of handle.metadata.indexes ?? []) {
      const index = normalizeIndex(raw)
      const name = index.name ?? defaultIndexName(handle.name, index.columns)
      if (indexExists(live.indexes, name)) continue
      steps.push({
        kind: 'create_index',
        ...schemaField(handle.schema),
        table: handle.name,
        index: name,
        columns: [...index.columns],
        unique: index.unique ?? false,
      })
    }

    // Live indexes not in metadata → drop_index (if allowed)
    if (allowed.has('dropIndex')) {
      for (const liveIdx of live.indexes ?? []) {
        if (desiredIndexes.has(liveIdx.name)) continue
        steps.push({
          kind: 'drop_index',
          ...schemaField(handle.schema),
          table: handle.name,
          index: liveIdx.name,
        })
      }
    }
  }

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
    const key = tableKey(handle.schema, handle.name)
    const live = existing.get(key)
    if (!live) continue
    const createAst = buildCreateTableAst(handle, dialect)
    const desiredColumnNames = new Set(createAst.columns.map((c) => c.name))

    for (const liveCol of live.columns ?? []) {
      if (desiredColumnNames.has(liveCol.name)) continue
      const step: Extract<MigrationStep, { kind: 'drop_column' }> = {
        kind: 'drop_column',
        ...schemaField(handle.schema),
        table: handle.name,
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
      return buildCreateTableAst(handle, dialect)
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
          ...(step.defaultValue !== undefined
            ? { defaultValue: step.defaultValue }
            : {}),
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
 */
export function createMigrateBuilder(options: {
  schemas: readonly TableHandle[]
  dialect: Dialect
  executor: Executor
}): MigrateBuilder {
  const { schemas, dialect, executor } = options
  const handles = new Map<string, TableHandle>()
  for (const handle of schemas) {
    handles.set(tableKey(handle.schema, handle.name), handle)
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
          message:
            cause instanceof Error ? cause.message : 'Migration dry-run failed',
          ...(cause !== undefined ? { cause } : {}),
        })
      }
    },

    async execute() {
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
            message:
              cause instanceof Error ? cause.message : 'Migration failed',
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
            if (step.kind === 'drop_column' && allowed.has('dropColumn')) {
              // allowed: skip data check
            } else if (step.kind === 'drop_column') {
              await assertColumnHasNoData(executor, step)
            }
            // Guard: never apply destructive without allow except data-safe drop_column
            const need = allowForStep(step)
            if (need && !allowed.has(need) && !(step.kind === 'drop_column')) {
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
