import type { CreateSchemaAst, Dialect, SqlAst } from '@/dialects'
import type {
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationRegistry,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { createCanonicalRelationIdentityModule } from '@/migrations/canonicalRelationIdentity'
import type { Executor } from '@/query'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'

import {
  MIGRATE_ADVISORY_LOCK_CLASS,
  MIGRATE_ADVISORY_LOCK_ID,
  createMigrationCoordinationScope,
  migrationLockAcquisitionOrder,
  migrationLockReleaseOrder,
} from '../migrations/coordinationScope'

import { buildCreateTableAst } from './createTable'
import type { MigrationPlan, MigrationStep } from './migrationPlan'
import { planMigration } from './migrationPlan'

/**
 * Stable Postgres session advisory lock keys for Stratom migrate execute.
 * Two-int form so values stay within safe 32-bit integers in JS.
 */
export { MIGRATE_ADVISORY_LOCK_CLASS, MIGRATE_ADVISORY_LOCK_ID }

/** Destructive migrate operations that require explicit execution permission. */
export type MigrationAllow = 'dropColumn' | 'dropTable' | 'dropIndex'

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

function relationInput(schema: string | undefined, relation: string) {
  return {
    ...(schema === undefined
      ? {}
      : { namespace: [{ role: 'schema' as const, spelling: schema }] }),
    relation,
  }
}

function schemaFromIdentity(identity: CanonicalRelationIdentity): string {
  const schema = identity.namespace.find((segment) => segment.role === 'schema')
  if (!schema) {
    throw new MigrationError({
      message: 'PostgreSQL migration execution requires a schema namespace',
    })
  }
  return schema.identifier.spelling
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
  identities: CanonicalRelationIdentityModule,
): Promise<void> {
  const schemaName = schemaFromIdentity(
    identities.resolve(relationInput(step.schema, step.table)),
  )
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
 * @param handles - Canonical relation registry of table handles.
 * @param dialect - SQL dialect for desired-table lowering.
 *
 * @returns SQL AST node ready for compilation
 *
 * @throws MigrationError - When the step references an unregistered handle
 */
function stepToAst(
  step: MigrationStep,
  handles: CanonicalRelationRegistry<TableHandle>,
  dialect: Dialect,
  identities: CanonicalRelationIdentityModule,
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
      const identity = identities.resolve(relationInput(step.schema, step.table))
      const handle = handles.get(identity)
      if (!handle) {
        throw new MigrationError({
          message: `cannot create table ${identities.format(identity)}: handle not registered`,
        })
      }
      const ast = buildCreateTableAst(handle, dialect)
      return {
        ...ast,
        schema: schemaFromIdentity(identity),
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

async function releaseMigrateLock(executor: Executor): Promise<boolean> {
  try {
    await executor.run({
      sql: `select pg_advisory_unlock(${MIGRATE_ADVISORY_LOCK_CLASS}, ${MIGRATE_ADVISORY_LOCK_ID})`,
      params: [],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Desired-state migrate: dry-run plan + execute converge with safe defaults,
 * explicit destructive allowlist, and Postgres advisory lock on execute.
 *
 * @example
 *   const migrate = createMigrateBuilder({ schemas: [User], dialect, executor })
 *   const plan = await migrate.dryRun()
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
  runOperation<T>(
    operation: (
      executor: Executor,
      databaseIdentity: string,
      discard: () => void,
    ) => Promise<T>,
  ): Promise<T>
  applicationId?: string
  defaultNamespace?: readonly NamespaceIdentifierInput[]
  assertCanExecute?: () => void
}): MigrateBuilder {
  const {
    schemas,
    dialect,
    runOperation,
    applicationId,
    defaultNamespace,
    assertCanExecute,
  } = options

  const allowed = new Set<MigrationAllow>()

  const buildPlan = async (executor: Executor) => {
    const catalog = await dialect.introspect(executor)
    const identities = createCanonicalRelationIdentityModule({
      adapter: dialect.relationIdentity,
      context: catalog.namespaceContext,
      ...(defaultNamespace === undefined
        ? {}
        : { registrationDefault: defaultNamespace }),
    })
    const handles = identities.createRegistry<TableHandle>()
    for (const handle of schemas) {
      const info = handle.getTableMetadata()
      handles.set(identities.resolve(relationInput(info.schema, info.name)), handle)
    }
    const plan = planMigration(schemas, catalog, dialect, {
      ...(defaultNamespace === undefined
        ? {}
        : { registrationDefault: defaultNamespace }),
    })
    return { plan, identities, handles }
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
        return await runOperation(async (executor) => {
          return (await buildPlan(executor)).plan
        })
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
      try {
        return await runOperation(async (executor, databaseIdentity, discard) => {
          const coordinationScope = createMigrationCoordinationScope(
            databaseIdentity,
            applicationId,
          )
          const firstLock = migrationLockAcquisitionOrder(coordinationScope)[0]
          if (firstLock?.kind !== 'legacy') {
            throw new MigrationError({
              message: 'Legacy migration lock must be acquired first',
            })
          }
          await acquireMigrateLock(executor)
          try {
            const { plan, identities, handles } = await buildPlan(executor)

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
                  await assertColumnHasNoNulls(executor, step, identities)
                }
                const ast = stepToAst(step, handles, dialect, identities)
                await executor.run(dialect.compile(ast))
              }
              await executor.run({ sql: 'commit', params: [] })
            } catch (error) {
              try {
                await executor.run({ sql: 'rollback', params: [] })
              } catch {
                discard()
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
            if (
              migrationLockReleaseOrder(coordinationScope).some(
                (identity) => identity.kind === 'legacy',
              )
            ) {
              if (!(await releaseMigrateLock(executor))) discard()
            }
          }
        })
      } catch (cause) {
        if (cause instanceof MigrationError) throw cause
        throw new MigrationError({
          message: cause instanceof Error ? cause.message : 'Migration failed',
          ...(cause !== undefined ? { cause } : {}),
        })
      }
    },
  }

  return builder
}
