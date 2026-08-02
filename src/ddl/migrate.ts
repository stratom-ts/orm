import type { CreateSchemaAst, CreateTableAst, Dialect, SqlAst } from '@/dialects'
import type {
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  CanonicalRelationRegistry,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import {
  generatedForeignKeyName,
  generatedPrimaryKeyName,
  generatedUniqueName,
  physicalNamingProfile,
} from '@/migrations/physicalNaming'
import type { Executor } from '@/query'
import type { TableHandle } from '@/types'
import { MigrationError } from '@/utils/error'

import {
  MIGRATE_ADVISORY_LOCK_CLASS,
  MIGRATE_ADVISORY_LOCK_ID,
  createMigrationCoordinationScope,
} from '../migrations/coordinationScope'

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

/**
 * Projects an optional schema into a SQL AST field.
 *
 * @param schema - Schema spelling, or undefined when omitted.
 */
function schemaField(
  schema: string | undefined,
): { schema: string } | Record<string, never> {
  return schema !== undefined ? { schema } : {}
}

/**
 * Builds a canonical identity input with an optional schema namespace.
 *
 * @param schema - Explicit schema spelling, or undefined for default resolution.
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
 * Reads the schema spelling from a canonical relation identity.
 *
 * @param identity - Canonical relation identity to inspect.
 */
function schemaFromIdentity(identity: CanonicalRelationIdentity): string {
  const schema = identity.namespace.find((segment) => segment.role === 'schema')
  if (!schema) {
    throw new MigrationError({
      message: 'PostgreSQL migration execution requires a schema namespace',
    })
  }
  return schema.identifier.spelling
}

/**
 * Quotes a SQL identifier and escapes embedded quotes.
 *
 * @param ident - Identifier spelling to quote.
 */
function quoteIdent(ident: string): string {
  return `"${ident.replaceAll('"', '""')}"`
}

/**
 * Refuse SET NOT NULL when the column already has NULL rows.
 * dryRun may still list the step; execute must check before applying.
 *
 * @param executor - Database executor used to inspect existing rows.
 * @param step - SET NOT NULL step whose target is checked.
 * @param identities - Identity module used to resolve the target relation.
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

/**
 * Maps a destructive migration step to its required permission.
 *
 * @param step - Migration step to classify.
 */
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
 *   const ast = stepToAst(step, desiredTables, dialect, identities)
 *
 * @param step - Migration step to convert.
 * @param desiredTables - Canonical registry of lowered desired tables.
 * @param dialect - SQL dialect for desired-table lowering.
 * @param identities - Identity module used to resolve step targets.
 *
 * @returns SQL AST node ready for compilation
 *
 * @throws MigrationError - When the step references an unregistered handle
 */
function stepToAst(
  step: MigrationStep,
  desiredTables: CanonicalRelationRegistry<CreateTableAst>,
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
      const ast = desiredTables.get(identity)
      if (!ast) {
        throw new MigrationError({
          message: `cannot create table ${identities.format(identity)}: lowered CreateTableAst not found`,
        })
      }
      const profile = physicalNamingProfile(dialect.relationIdentity)
      return {
        ...ast,
        schema: schemaFromIdentity(identity),
        primaryKeyName: generatedPrimaryKeyName(identity, ast.primaryKey, profile),
        columns: ast.columns.map((column) => ({
          ...column,
          references: undefined,
          ...(column.unique
            ? {
                uniqueConstraintName: generatedUniqueName(identity, column.name, profile),
              }
            : {}),
        })),
      }
    }
    case 'add_column': {
      const identity = identities.resolve(relationInput(step.schema, step.table))
      return {
        kind: 'add_column',
        ...schemaField(step.schema),
        table: step.table,
        column: {
          name: step.column,
          dataType: step.dataType,
          notNull: step.notNull,
          unique: step.unique ?? false,
          ...(step.unique
            ? {
                uniqueConstraintName: generatedUniqueName(
                  identity,
                  step.column,
                  physicalNamingProfile(dialect.relationIdentity),
                ),
              }
            : {}),
          autoIncrement: step.autoIncrement ?? false,
          ...(step.defaultValue !== undefined ? { defaultValue: step.defaultValue } : {}),
          ...(step.databaseDefault !== undefined
            ? { databaseDefault: step.databaseDefault }
            : {}),
          ...(step.generated ? { generated: step.generated } : {}),
          ...(step.references ? { references: step.references } : {}),
        },
      }
    }
    case 'alter_column_type':
      return {
        kind: 'alter_column_type',
        ...schemaField(step.schema),
        table: step.table,
        column: step.column,
        dataType: step.dataType,
      }
    case 'add_unique_constraint': {
      const identity = identities.resolve(relationInput(step.schema, step.table))
      return {
        kind: 'add_unique_constraint',
        ...schemaField(step.schema),
        table: step.table,
        column: step.column,
        name: generatedUniqueName(
          identity,
          step.column,
          physicalNamingProfile(dialect.relationIdentity),
        ),
      }
    }
    case 'add_foreign_key': {
      const identity = identities.resolve(relationInput(step.schema, step.table))
      const referenced = identities.resolve(
        relationInput(step.references.schema, step.references.table),
      )
      return {
        kind: 'add_foreign_key',
        ...schemaField(step.schema),
        table: step.table,
        column: step.column,
        name: generatedForeignKeyName(
          identity,
          step.column,
          referenced,
          step.references.column,
          step.references.onDelete,
          step.references.onUpdate,
          physicalNamingProfile(dialect.relationIdentity),
        ),
        references: step.references,
      }
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

/**
 * Acquires the session advisory lock that serializes migration execution.
 *
 * @param executor - Executor bound to the migration session.
 */
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

/**
 * Releases the migration advisory lock, reporting whether it was held.
 *
 * @param executor - Executor bound to the migration session.
 */
async function releaseMigrateLock(executor: Executor): Promise<boolean> {
  try {
    const [result] = await executor.execute({
      sql: `select pg_advisory_unlock(${MIGRATE_ADVISORY_LOCK_CLASS}, ${MIGRATE_ADVISORY_LOCK_ID}) as "unlocked"`,
      params: [],
    })
    return (
      typeof result === 'object' &&
      result !== null &&
      'unlocked' in result &&
      result.unlocked === true
    )
  } catch {
    return false
  }
}

/**
 * Desired-state migrate: dry-run plan + execute converge with safe defaults,
 * explicit destructive allowlist, and Postgres advisory lock on execute.
 *
 * @example
 *   const migrate = createMigrateBuilder({ schemas: [Users], dialect, runOperation })
 *   const plan = await migrate.dryRun()
 *   await migrate.allow('dropColumn').execute()
 *
 * @param options - Builder configuration including schemas, dialect, runOperation, and
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
  migrationOwnership?: readonly MigrationOwnershipDeclaration[]
  assertCanExecute?: () => void
}): MigrateBuilder {
  const {
    schemas,
    dialect,
    runOperation,
    applicationId,
    defaultNamespace,
    migrationOwnership,
    assertCanExecute,
  } = options

  const allowed = new Set<MigrationAllow>()

  /**
   * Introspects the managed catalog and builds its Migration Plan.
   *
   * @param executor - Executor used for catalog introspection.
   */
  const buildPlan = async (executor: Executor) => {
    const request = createCatalogRequest(
      schemas,
      migrationOwnership ?? [],
      defaultNamespace,
    )
    const catalog = await dialect.catalog.introspectCatalog(executor, request)
    return planMigration(schemas, catalog, dialect, {
      ...(defaultNamespace === undefined
        ? {}
        : { registrationDefault: defaultNamespace }),
      ...(migrationOwnership === undefined ? {} : { migrationOwnership }),
    })
  }

  const builder: MigrateBuilder = {
    /**
     * Grants permission for selected destructive operations.
     *
     * @param ops - Destructive operations to permit.
     */
    allow(...ops: MigrationAllow[]) {
      for (const op of ops) {
        allowed.add(op)
      }
      return builder
    },

    /** Builds a Migration Plan without executing its steps. */
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

    /** Executes the permitted Migration Plan under an advisory lock. */
    async execute() {
      assertCanExecute?.()
      try {
        return await runOperation(async (executor, databaseIdentity, discard) => {
          createMigrationCoordinationScope(databaseIdentity, applicationId)
          let lockAcquired = false
          try {
            await acquireMigrateLock(executor)
            lockAcquired = true
            const { plan, identities, desiredTables } = await buildPlan(executor)

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
            let commitAttempted = false
            try {
              for (const step of steps) {
                if (step.kind === 'set_not_null') {
                  await assertColumnHasNoNulls(executor, step, identities)
                }
                const ast = stepToAst(step, desiredTables, dialect, identities)
                await executor.run(dialect.compile(ast))
              }
              commitAttempted = true
              await executor.run({ sql: 'commit', params: [] })
            } catch (error) {
              if (commitAttempted) discard()
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
            if (!lockAcquired || !(await releaseMigrateLock(executor))) discard()
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
