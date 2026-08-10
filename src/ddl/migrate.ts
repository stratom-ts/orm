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

import type {
  MigrationColumnReference,
  MigrationPlan,
  MigrationSemanticProfile,
  MigrationStep,
  PlannedMigration,
} from './migrationPlan'
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
 * Reads the schema spelling a PostgreSQL statement must name.
 *
 * @param namespace - Canonical namespace to project.
 *
 * @throws {MigrationError} When the namespace carries no schema segment.
 */
function schemaFromNamespace(namespace: CanonicalRelationIdentity['namespace']): string {
  const schema = namespace.find((segment) => segment.role === 'schema')
  if (!schema) {
    throw new MigrationError({
      message: 'PostgreSQL migration execution requires a schema namespace',
    })
  }
  return schema.identifier.spelling
}

/**
 * Projects a canonical relation identity into PostgreSQL AST relation fields.
 *
 * @param identity - Canonical relation identity to project.
 */
function relationFields(identity: CanonicalRelationIdentity): {
  schema: string
  table: string
} {
  return {
    schema: schemaFromNamespace(identity.namespace),
    table: identity.relation.spelling,
  }
}

/**
 * Projects a structured plan reference into PostgreSQL AST reference fields.
 *
 * @param reference - Structured foreign-key reference carried by a plan step.
 */
function referenceFields(reference: MigrationColumnReference) {
  return {
    ...relationFields(reference.relation),
    column: reference.column.spelling,
    ...(reference.onDelete === undefined ? {} : { onDelete: reference.onDelete }),
    ...(reference.onUpdate === undefined ? {} : { onUpdate: reference.onUpdate }),
  }
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
 */
async function assertColumnHasNoNulls(
  executor: Executor,
  step: Extract<MigrationStep, { kind: 'set_not_null' }>,
): Promise<void> {
  const { schema: schemaName, table } = relationFields(step.target.relation)
  const tableSql = `${quoteIdent(schemaName)}.${quoteIdent(table)}`
  const columnSql = quoteIdent(step.target.column.spelling)
  const rows = await executor.execute({
    sql: `select count(*)::int as count from ${tableSql} where ${columnSql} is null`,
    params: [],
  })
  const raw = rows[0] as { count?: unknown } | undefined
  const count = Number(raw?.count ?? 0)
  if (count > 0) {
    throw new MigrationError({
      message: `Cannot set column '${schemaName}.${table}.${step.target.column.spelling}' as NOT NULL - column has NULL values`,
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
 * Converts one semantic migration step into a SQL AST node for compilation.
 *
 * @example
 *   const ast = stepToAst(step, desiredTables, dialect, identities)
 *
 * @param step - Migration step to convert.
 * @param desiredTables - Canonical registry of lowered desired tables.
 * @param dialect - SQL dialect supplying naming rules.
 * @param identities - Identity module used for target diagnostics.
 *
 * @returns SQL AST node ready for compilation
 *
 * @throws {MigrationError} When a target-only create step has no registered desired
 *   table.
 */
function stepToAst(
  step: MigrationStep,
  desiredTables: CanonicalRelationRegistry<CreateTableAst>,
  dialect: Dialect,
  identities: CanonicalRelationIdentityModule,
): SqlAst {
  const profile = physicalNamingProfile(dialect.relationIdentity)
  switch (step.kind) {
    case 'ensure_namespace': {
      const ast: CreateSchemaAst = {
        kind: 'create_schema',
        schema: schemaFromNamespace(step.target.namespace),
      }
      return ast
    }
    case 'create_table': {
      const identity = step.target.relation
      const ast = desiredTables.get(identity)
      if (!ast) {
        throw new MigrationError({
          message: `cannot create table ${identities.format(identity)}: lowered CreateTableAst not found`,
        })
      }
      return {
        ...ast,
        ...relationFields(identity),
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
      const identity = step.target.relation
      const column = step.target.column.spelling
      return {
        kind: 'add_column',
        ...relationFields(identity),
        column: {
          name: column,
          dataType: step.dataType,
          notNull: step.notNull,
          unique: step.unique ?? false,
          ...(step.unique
            ? { uniqueConstraintName: generatedUniqueName(identity, column, profile) }
            : {}),
          autoIncrement: step.autoIncrement ?? false,
          ...(step.defaultValue !== undefined ? { defaultValue: step.defaultValue } : {}),
          ...(step.databaseDefault !== undefined
            ? { databaseDefault: step.databaseDefault }
            : {}),
          ...(step.generated ? { generated: step.generated } : {}),
        },
      }
    }
    case 'alter_column_type':
      return {
        kind: 'alter_column_type',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        dataType: step.dataType,
      }
    case 'add_unique_constraint':
      return {
        kind: 'add_unique_constraint',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        name: generatedUniqueName(
          step.target.relation,
          step.target.column.spelling,
          profile,
        ),
      }
    case 'add_foreign_key':
      return {
        kind: 'add_foreign_key',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        name: generatedForeignKeyName(
          step.target.relation,
          step.target.column.spelling,
          step.references.relation,
          step.references.column.spelling,
          step.references.onDelete,
          step.references.onUpdate,
          profile,
        ),
        references: referenceFields(step.references),
      }
    case 'set_not_null':
      return {
        kind: 'set_not_null',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'drop_not_null':
      return {
        kind: 'drop_not_null',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'create_index':
      return {
        kind: 'create_index',
        ...relationFields(step.target.relation),
        name: step.target.index.spelling,
        columns: step.columns.map((column) => column.spelling),
        unique: step.unique,
      }
    case 'drop_column':
      return {
        kind: 'drop_column',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'drop_table':
      return { kind: 'drop_table', ...relationFields(step.target.relation) }
    case 'drop_index':
      return {
        kind: 'drop_index',
        ...relationFields(step.target.relation),
        index: step.target.index.spelling,
      }
  }
}

/**
 * Compares authored namespace inputs under the adapter's identifier rules, so a
 * case-folding dialect accepts the spellings it treats as one namespace.
 *
 * @param left - First namespace input, or undefined when none was configured.
 * @param right - Second namespace input, or undefined when none was configured.
 * @param identities - Identity module supplying comparison keys.
 */
function sameNamespaceInput(
  left: readonly NamespaceIdentifierInput[] | undefined,
  right: readonly NamespaceIdentifierInput[] | undefined,
  identities: CanonicalRelationIdentityModule,
): boolean {
  /**
   * Resolves one authored namespace the way registration does, so equivalent spellings
   * of the same namespace compare equal. Identity resolution treats an empty namespace
   * as none; an unresolvable namespace stays a mismatch.
   *
   * @param input - Authored namespace, or undefined when none was configured.
   */
  const resolve = (input: readonly NamespaceIdentifierInput[] | undefined) => {
    if (!input?.length) return undefined
    try {
      return identities.resolveNamespace(input)
    } catch {
      return null
    }
  }

  const selected = resolve(left)
  const other = resolve(right)
  if (selected == null || other == null) {
    return selected === undefined && other === undefined
  }
  return (
    selected.length === other.length &&
    selected.every(
      (segment, index) =>
        segment.role === other[index]?.role &&
        segment.identifier.comparisonKey === other[index]?.identifier.comparisonKey,
    )
  )
}

/**
 * Reports which semantic profile field the executing run disagrees with.
 *
 * @param profile - Profile the Migration Plan was built under.
 * @param expected - Profile the executing run resolves.
 * @param identities - Identity module supplying comparison keys.
 */
function profileMismatch(
  profile: MigrationSemanticProfile,
  expected: MigrationSemanticProfile,
  dialect: Dialect,
  identities: CanonicalRelationIdentityModule,
): string | undefined {
  if (expected.identityAdapter !== dialect.relationIdentity) {
    return `executing profile adapter '${expected.identityAdapter}' does not match dialect adapter '${dialect.relationIdentity}'`
  }
  if (profile.identityAdapter !== expected.identityAdapter) {
    return `identity adapter '${profile.identityAdapter}' does not match executing adapter '${expected.identityAdapter}'`
  }
  if (
    !sameNamespaceInput(
      profile.namespaceContext.writableDefault,
      expected.namespaceContext.writableDefault,
      identities,
    )
  ) {
    return 'writable namespace context does not match the executing session'
  }
  if (
    !sameNamespaceInput(
      profile.registrationDefault,
      expected.registrationDefault,
      identities,
    )
  ) {
    return 'registration default does not match the executing configuration'
  }
}

/**
 * Lowers a complete Migration Plan into SQL ASTs before any DDL runs, so missing
 * registrations or a mismatched semantic profile fail the whole operation first.
 *
 * This seam is internal: the migrate builder plans and lowers inside one operation, so
 * its profiles always agree. The guard exists for callers that lower a plan they did not
 * just build.
 *
 * @example
 *   const lowered = lowerMigrationPlan(planned, postgresDialect, expectedProfile)
 *
 * @param planned - Canonical Migration Plan with the registrations and profile it was
 *   built from.
 * @param dialect - Dialect executing the plan.
 * @param expected - Semantic profile the executing run resolves.
 *
 * @throws {MigrationError} When the profile does not match the executing run or a
 *   target-only step has no registered desired table.
 */
export function lowerMigrationPlan(
  planned: PlannedMigration,
  dialect: Dialect,
  expected: MigrationSemanticProfile,
): Array<{ step: MigrationStep; ast: SqlAst }> {
  const mismatch = profileMismatch(planned.profile, expected, dialect, planned.identities)
  if (mismatch) {
    throw new MigrationError({
      message: `Cannot lower this Migration Plan: ${mismatch}`,
    })
  }
  return planned.plan.steps.map((step) => ({
    step,
    ast: stepToAst(step, planned.desiredTables, dialect, planned.identities),
  }))
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
    const planned = planMigration(schemas, catalog, dialect, {
      ...(defaultNamespace === undefined
        ? {}
        : { registrationDefault: defaultNamespace }),
      ...(migrationOwnership === undefined ? {} : { migrationOwnership }),
    })
    // The executing run resolves this profile independently of the plan it received.
    const expected: MigrationSemanticProfile = {
      identityAdapter: dialect.relationIdentity,
      namespaceContext: catalog.namespaceContext,
      ...(defaultNamespace === undefined
        ? {}
        : { registrationDefault: defaultNamespace }),
    }
    return { planned, expected }
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
          return (await buildPlan(executor)).planned.plan
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
            const { planned, expected } = await buildPlan(executor)

            const steps = planned.plan.steps
            if (steps.length === 0) return

            for (const step of steps) {
              const need = allowForStep(step)
              if (need && !allowed.has(need)) {
                throw new MigrationError({
                  message: `Destructive migration step '${step.kind}' requires allow('${need}')`,
                })
              }
            }

            const lowered = lowerMigrationPlan(planned, dialect, expected)

            await executor.run({ sql: 'begin', params: [] })
            let commitAttempted = false
            try {
              for (const { step, ast } of lowered) {
                if (step.kind === 'set_not_null') {
                  await assertColumnHasNoNulls(executor, step)
                }
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
