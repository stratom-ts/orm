import type { CreateSchemaAst, Dialect, SqlAst } from '@/dialects'
import type { Executor } from '@/query'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'
import { effectiveSchema, tableKey } from '@/utils/tableKey'

import { buildCreateTableAst } from './createTable'
import type { MigrationAllow, MigrationPlan, MigrationStep } from './migrationPlan'
import { planMigration } from './migrationPlan'

/**
 * Stable Postgres session advisory lock keys for Stratom migrate execute.
 * Two-int form so values stay within safe 32-bit integers in JS.
 */
export const MIGRATE_ADVISORY_LOCK_CLASS = 0x7363_686d // 'schm'
export const MIGRATE_ADVISORY_LOCK_ID = 0x6f72_6d00 // 'orm\0'

export type MigrateBuilder = {
  allow(...ops: MigrationAllow[]): MigrateBuilder
  dryRun(): Promise<MigrationPlan>
  execute(): Promise<void>
}

function schemaField(
  schema: string | undefined,
): { schema: string } | Record<string, never> {
  return schema !== undefined ? { schema } : {}
}

function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`
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
    return planMigration(schemas, catalog, allowed)
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
        const plan = planMigration(schemas, catalog, allowed)

        const steps = plan.steps
        if (steps.length === 0) return

        for (const step of steps) {
          const need = allowForStep(step)
          if (need && !allowed.has(need)) {
            throw new MigrationError({
              message: `Destructive migration step '${step.kind}' requires allow('${need}')`,
            })
          }
        }

        await executor.run({ sql: 'begin', params: [] })
        try {
          for (const step of steps) {
            if (step.kind === 'set_not_null') {
              await assertColumnHasNoNulls(executor, step)
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
