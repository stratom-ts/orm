import type {
  DialectMigrationAdapter,
  MigrationLoweringPolicy,
  MigrationProgram,
} from '@/ddl/migrationProgram'
import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import { enrichMigrationError } from '@/migrations/migrationDiagnostics'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import { operationCleanupFailures, operationPrimaryFailure } from '@/operations/cleanup'
import type { Executor } from '@/query'
import { withQuerySource } from '@/query/executor'
import type { TableHandle } from '@/types'
import type { MigrationExecutionStage } from '@/utils/error'
import { MigrationError, attempt, attemptSync, isErrorTag } from '@/utils/error'

import type {
  MigrationPlan,
  MigrationSemanticProfile,
  MigrationStep,
} from './migrationPlan'
import { planMigration } from './migrationPlan'
import type { MigrationColumnRename } from './renameColumn'

/** Destructive migrate operations that require explicit execution permission. */
type MigrationAllow = 'dangerouslyDropColumn' | 'dropTable' | 'dropIndex'

/** Optional cancellation and finite coordination deadline for migration execution. */
type MigrationExecuteOptions = Readonly<{
  signal?: AbortSignal
  lockTimeoutMs?: number
}>

/** Non-executable statement preview; every bound parameter is redacted. */
type MigrationDryRunStatement = Readonly<{
  sql: string
  /** One `[REDACTED]` marker per bound parameter, preserving count and order. */
  params: readonly '[REDACTED]'[]
}>

/** Non-executable physical action projected from dialect whole-plan lowering. */
type MigrationDryRunAction = Readonly<{
  sourceStepIndexes: readonly number[]
  transaction: 'required' | 'allowed' | 'forbidden'
  statements: readonly MigrationDryRunStatement[]
}>

/** Ordered, non-executable physical preview of a complete Migration Plan. */
type MigrationDryRun = Readonly<{
  atomicity: 'plan-atomic' | 'statement-atomic' | 'non-atomic'
  preconditions: MigrationProgram['preconditions']
  actions: readonly MigrationDryRunAction[]
}>

type MigrateBuilder = {
  /** Declares an explicit mapping between physical column identifiers. */
  renameColumn(intent: MigrationColumnRename): MigrateBuilder
  /**
   * Grants execution permission for destructive migration operations.
   *
   * @param ops - Destructive operations to permit.
   */
  allow(...ops: MigrationAllow[]): MigrateBuilder

  /**
   * Builds a semantic Migration Plan without lowering or executing it.
   *
   * @throws {SchemaError} Authored schema or registration is invalid.
   * @throws {MigrationError} Planning or catalog introspection fails; driver causes
   *   retain their origin.
   */
  plan(): Promise<MigrationPlan>

  /**
   * Lowers the complete plan and returns ordered SQL with all bound values redacted.
   *
   * @throws {SchemaError} Authored schema or registration is invalid.
   * @throws {MigrationError} Planning, catalog introspection, or lowering is blocked;
   *   driver causes retain their origin.
   */
  dryRun(): Promise<MigrationDryRun>

  /**
   * Plans and executes the migration through the selected dialect.
   *
   * @param options - Optional cancellation signal and lock deadline.
   *
   * @throws {SchemaError} Authored schema or registration is invalid.
   * @throws {MigrationError} Migration is blocked or fails during execution; `defect:
   *   true` identifies a wrapped defect.
   * @throws {QueryError} Execution is attempted from an invalid client or transaction
   *   scope.
   */
  execute(options?: MigrationExecuteOptions): Promise<void>
}

/**
 * Adds an execution phase without replacing an already structured migration failure.
 *
 * @param cause - Failure to structure.
 * @param stage - Migration stage that observed the failure.
 */
function phaseError(
  cause: unknown,
  stage: MigrationExecutionStage,
  mode: 'preview' | 'execution' = 'execution',
): unknown {
  if (isErrorTag(cause, 'SchemaError')) return cause

  if (
    !isErrorTag(cause, 'MigrationError') &&
    !isErrorTag(cause, 'QueryError') &&
    !isErrorTag(cause, 'DriverError')
  ) {
    if (mode === 'preview') return cause

    return new MigrationError({
      message: `Migration ${stage} failed`,
      cause,
      defect: true,
      stage,
      outcome: 'unchanged',
      retryable: false,
    })
  }

  if (isErrorTag(cause, 'QueryError') || isErrorTag(cause, 'DriverError'))
    return new MigrationError({
      message: `Migration ${stage} failed${isErrorTag(cause, 'QueryError') ? `: ${cause.message}` : ''}`,
      cause,
      stage,
      outcome: 'unchanged',
      retryable: false,
    })

  if (cause.stage !== undefined) return cause

  return enrichMigrationError(cause, {
    message: `Migration ${stage} failed: ${cause.message}`,
    stage,
    outcome: cause.outcome ?? 'unchanged',
    retryable: cause.retryable ?? false,
  })
}

/**
 * Resolves and validates the finite migration lock deadline.
 *
 * @param options - Migration execution options containing an optional lock timeout.
 */
function lockTimeout(options: MigrationExecuteOptions | undefined): number | undefined {
  const value = options?.lockTimeoutMs

  if (value === undefined) return undefined

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new MigrationError({
      message: 'Migration lockTimeoutMs must be a finite non-negative number',
      stage: 'lock',
      outcome: 'unchanged',
      retryable: false,
    })
  }

  return value
}

/**
 * Maps a destructive semantic step to its required permission.
 *
 * @param step - Migration step to classify.
 */
function allowForStep(step: MigrationStep): MigrationAllow | undefined {
  switch (step.kind) {
    case 'drop_column':
      return undefined
    case 'drop_table':
      return 'dropTable'
    case 'drop_index':
      return 'dropIndex'
    case 'ensure_namespace':
    case 'create_table':
    case 'rename_column':
    case 'add_column':
    case 'alter_column_type':
    case 'add_foreign_key':
    case 'add_unique_constraint':
    case 'set_not_null':
    case 'drop_not_null':
    case 'create_index':
      return undefined
  }
}

/** Runs the shared, all-or-nothing whole-plan lowering boundary. */
function lowerPlan(
  migration: DialectMigrationAdapter,
  planned: Parameters<DialectMigrationAdapter['lower']>[0],
  expected: Parameters<DialectMigrationAdapter['lower']>[1],
  mode: 'preview' | 'execution' = 'execution',
  policy: MigrationLoweringPolicy = { columnDrop: 'guarded' },
): MigrationProgram {
  const lowering = attemptSync(() => migration.lower(planned, expected, policy))

  if (!lowering.ok) throw phaseError(lowering.error, 'lowering', mode)

  const lowered = lowering.value

  if (lowered.issues) {
    const sourceStepIndexes = [
      ...new Set(lowered.issues.flatMap((issue) => issue.sourceStepIndexes)),
    ].sort((left, right) => left - right)

    throw new MigrationError({
      message: lowered.issues.map((issue) => issue.message).join('\n'),
      stage: 'lowering',
      outcome: 'unchanged',
      retryable: false,
      sourceStepIndexes,
      capabilityIssues: lowered.issues,
    })
  }

  return lowered.program
}

/** Copies the physical program into a review-only shape without executable callbacks. */
function dryRunProgram(program: MigrationProgram): MigrationDryRun {
  return {
    atomicity: program.atomicity,
    preconditions: program.preconditions.map((precondition) => ({
      ...precondition,
      sourceStepIndexes: [...precondition.sourceStepIndexes],
      ...(precondition.kind === 'column_has_no_nulls'
        ? {
            relation: {
              namespace: precondition.relation.namespace.map((segment) => ({
                ...segment,
                identifier: { ...segment.identifier },
              })),
              relation: { ...precondition.relation.relation },
            },
          }
        : {
            target: {
              ...precondition.target,
              relation: {
                namespace: precondition.target.relation.namespace.map((segment) => ({
                  ...segment,
                  identifier: { ...segment.identifier },
                })),
                relation: { ...precondition.target.relation.relation },
              },
              column: { ...precondition.target.column },
            },
          }),
    })),
    actions: program.actions.map((action) => ({
      sourceStepIndexes: [...action.sourceStepIndexes],
      transaction: action.transaction,
      statements: action.statements.map((statement) => ({
        sql: statement.sql,
        params: statement.params.map(() => '[REDACTED]' as const),
      })),
    })),
  }
}

/**
 * Introspects the operation session and creates its canonical semantic plan.
 *
 * @param executor - Executor bound to the operation session.
 */
async function observeMigrationPlan(
  executor: Executor,
  options: Pick<
    Parameters<typeof createMigrateBuilder>[0],
    'schemas' | 'migration' | 'migrationOwnership' | 'defaultNamespace' | 'renames'
  >,
  mode: 'preview' | 'execution' = 'execution',
) {
  const { schemas, migration, migrationOwnership, defaultNamespace } = options
  let request

  try {
    request = {
      ...createCatalogRequest(schemas, migrationOwnership ?? [], defaultNamespace),
      ...(options.renames?.length ? { observeRenameDependencies: true } : {}),
    }
  } catch (cause) {
    throw phaseError(cause, 'planning', mode)
  }

  let catalog

  try {
    catalog = await migration.catalog.introspectCatalog(
      withQuerySource(executor, 'catalog'),
      request,
    )
  } catch (cause) {
    throw phaseError(cause, 'introspection', mode)
  }

  let planned

  try {
    planned = planMigration(schemas, catalog, migration.planning, {
      renames: options.renames,
      ...(defaultNamespace === undefined
        ? {}
        : { registrationDefault: defaultNamespace }),
      ...(migrationOwnership === undefined ? {} : { migrationOwnership }),
    })
  } catch (cause) {
    throw phaseError(cause, 'planning', mode)
  }

  const expected: MigrationSemanticProfile = {
    identityAdapter: migration.planning.identity.id,
    namespaceContext: catalog.namespaceContext,
    ...(defaultNamespace === undefined ? {} : { registrationDefault: defaultNamespace }),
  }

  return { planned, expected }
}

/** Checks permissions before lowering the authoritative Migration Plan. */
async function prepareMigration(
  executor: Executor,
  planningOptions: Parameters<typeof observeMigrationPlan>[1],
  allowed: ReadonlySet<MigrationAllow>,
) {
  const { planned, expected } = await observeMigrationPlan(executor, planningOptions)

  for (const step of planned.plan.steps) {
    const permission = allowForStep(step)

    if (permission && !allowed.has(permission)) {
      throw new MigrationError({
        message: `Destructive migration step '${step.kind}' requires allow('${permission}')`,
        stage: 'permission',
        outcome: 'unchanged',
        retryable: false,
      })
    }
  }

  return lowerPlan(planningOptions.migration, planned, expected, 'execution', {
    columnDrop: allowed.has('dangerouslyDropColumn') ? 'dangerous' : 'guarded',
  })
}

type MigrateBuilderOptions = {
  renames?: readonly MigrationColumnRename[]
  schemas: readonly TableHandle[]
  migration: DialectMigrationAdapter
  /**
   * Runs migration work on one pinned operation session.
   *
   * @param operation - Work receiving the session executor and lifecycle capabilities.
   */
  runOperation: <T>(
    /**
     * Performs migration work on one pinned operation session.
     *
     * @param executor - Executor bound to the operation session.
     * @param databaseIdentity - Stable identity of the session database.
     * @param discard - Marks the physical session for disposal.
     * @param cancel - Cancels work running on the physical session.
     */
    operation: (
      executor: Executor,
      databaseIdentity: string,
      discard: () => void,
      cancel: () => Promise<void>,
    ) => Promise<T>,
  ) => Promise<T>
  applicationId?: string
  defaultNamespace?: readonly NamespaceIdentifierInput[]
  migrationOwnership?: readonly MigrationOwnershipDeclaration[]

  /** Verifies that the current client context permits migration execution. */
  assertCanExecute?: () => void
}

/**
 * Desired-state migration orchestration. Planning and permissions remain generic;
 * lowering and all execution mechanics belong to the selected dialect migration facet.
 *
 * @example
 *   const migrate = createMigrateBuilder({ schemas, migration, runOperation })
 *   await migrate.allow('dangerouslyDropColumn').execute()
 *
 * @param options - Migration schemas, selected member, operation runner, and policy.
 *
 * @returns A migration builder separating generic planning and permissions from dialect
 *   execution.
 */
function createMigrateBuilder(options: MigrateBuilderOptions): MigrateBuilder {
  const { migration, runOperation, applicationId, assertCanExecute } = options
  const { schemas, defaultNamespace, migrationOwnership, renames } = options
  const planningOptions = {
    schemas,
    migration,
    defaultNamespace,
    migrationOwnership,
    renames,
  }

  const allowed = new Set<MigrationAllow>()

  const intents: MigrationColumnRename[] = []
  const snapshot = () => ({
    ...planningOptions,
    runOperation,
    applicationId,
    assertCanExecute,
    renames: intents.map((intent) => ({ ...intent })),
  })

  const builder: MigrateBuilder = {
    renameColumn(intent) {
      intents.push({ table: intent.table, from: intent.from, to: intent.to })
      return builder
    },
    allow(...ops) {
      for (const op of ops) allowed.add(op)
      return builder
    },
    plan: () => createMigrationPreview(snapshot(), new Set(allowed)).plan(),
    dryRun: () => createMigrationPreview(snapshot(), new Set(allowed)).dryRun(),
    execute: (executeOptions) =>
      executeMigration(snapshot(), new Set(allowed), executeOptions),
  }

  return builder
}

/**
 * Runs an authoritative migration and preserves its outcome through session cleanup
 * failures.
 *
 * @param options - Configuration and dependencies for this operation.
 * @param allowed - Destructive operations explicitly permitted for this migration
 *   execution.
 * @param executeOptions - Lock deadline and cancellation controls supplied by the caller.
 */
async function executeMigration(
  options: MigrateBuilderOptions,
  allowed: Set<MigrationAllow>,
  executeOptions: Parameters<MigrateBuilder['execute']>[0],
): Promise<void> {
  const { migration, runOperation, applicationId, assertCanExecute } = options
  const { schemas, defaultNamespace, migrationOwnership, renames } = options
  const planningOptions = {
    schemas,
    migration,
    defaultNamespace,
    migrationOwnership,
    renames,
  }

  const lockTimeoutMs = lockTimeout(executeOptions)

  assertMigrationPermission(assertCanExecute)

  const runtime = {
    success: undefined as { outcome: 'applied' | 'unchanged' } | undefined,
  }

  try {
    await runOperation(async (executor, databaseIdentity, discard, cancel) => {
      const execution = await attempt(() =>
        migration.execute({
          executor,
          databaseIdentity,
          discard,
          cancel,
          ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
          ...(applicationId === undefined ? {} : { applicationId }),
          ...(executeOptions?.signal === undefined
            ? {}
            : { signal: executeOptions.signal }),
          /** Builds, validates, and lowers the plan inside the execution snapshot. */
          prepare: () => prepareMigration(executor, planningOptions, allowed),
          /** Checks the same desired schema against the final authoritative catalog. */
          validate: () => validateMigrationResult(executor, planningOptions, allowed),
        }),
      )

      if (!execution.ok) throwAdapterExecutionError(execution.error, discard)

      runtime.success = execution.value
      return runtime.success
    })
  } catch (cause) {
    throwExecutionCleanup(cause, runtime.success)
  }
}

/** Reports final observation and reconciliation failures at the validation stage. */
async function validateMigrationResult(
  executor: Executor,
  planningOptions: Parameters<typeof observeMigrationPlan>[1],
  allowed: ReadonlySet<MigrationAllow>,
): Promise<void> {
  try {
    await validateMigrationConvergence(executor, planningOptions, allowed)
  } catch (cause) {
    if (isErrorTag(cause, 'MigrationError'))
      throw enrichMigrationError(cause, { stage: 'validation' })

    throw cause
  }
}

/** Checks the desired schema against the final authoritative catalog. */
async function validateMigrationConvergence(
  executor: Executor,
  planningOptions: Parameters<typeof observeMigrationPlan>[1],
  allowed: ReadonlySet<MigrationAllow>,
): Promise<void> {
  const { planned, expected } = await observeMigrationPlan(executor, planningOptions)
  const final = lowerPlan(planningOptions.migration, planned, expected, 'execution', {
    columnDrop: allowed.has('dangerouslyDropColumn') ? 'dangerous' : 'guarded',
  })

  if (planned.plan.steps.length || final.actions.length)
    throw new MigrationError({
      message: 'Migration did not converge to the desired schema',
    })
}

/**
 * Reports session cleanup while preserving the acknowledged database outcome and primary
 * failure.
 *
 * @param cause - Original rejection whose identity and failure details must be preserved.
 * @param success - Acknowledged database outcome, if execution completed before cleanup
 *   failed.
 */
function throwExecutionCleanup(
  cause: unknown,
  success: { outcome: 'applied' | 'unchanged' } | undefined,
): never {
  if (isErrorTag(cause, 'MigrationError')) throw cause

  const cleanupFailures = operationCleanupFailures(cause)
  cause = operationPrimaryFailure(cause)

  if (
    isErrorTag(cause, 'SchemaError') &&
    success === undefined &&
    cleanupFailures.length === 0
  )
    throw cause

  if (success) {
    throw new MigrationError({
      message: `Migration session cleanup failed${isErrorTag(cause, 'SchemaError') ? `: ${cause.message}` : ''}`,
      cause,
      ...(isDefect(cause) ? { defect: true as const } : {}),
      stage: 'sessionCleanup',
      outcome: success.outcome,
      retryable: false,
      cleanupFailures: [{ stage: 'sessionCleanup', cause }, ...cleanupFailures],
    })
  }

  throw new MigrationError({
    message: `Migration operation session failed${isErrorTag(cause, 'SchemaError') ? `: ${cause.message}` : ''}`,
    cause,
    ...(isDefect(cause) ? { defect: true as const } : {}),
    stage: 'sessionCleanup',
    outcome: 'unchanged',
    retryable: false,
    ...(cleanupFailures.length ? { cleanupFailures } : {}),
  })
}

/** Checks execution permission and preserves the permission failure's migration stage. */
function assertMigrationPermission(assertCanExecute: (() => void) | undefined): void {
  try {
    assertCanExecute?.()
  } catch (cause) {
    throw phaseError(cause, 'permission')
  }
}

/**
 * Builds planning and SQL-preview entry points without executing migration actions.
 *
 * @param options - Configuration and dependencies for this operation.
 *
 * @returns Planning and SQL-preview entry points without executing migration actions.
 */
function createMigrationPreview(
  options: MigrateBuilderOptions,
  allowed: ReadonlySet<MigrationAllow>,
): Pick<MigrateBuilder, 'plan' | 'dryRun'> {
  const { migration, runOperation } = options
  const planningOptions = options
  return {
    /** Builds a semantic Migration Plan without lowering or executing it. */
    async plan() {
      return runMigrationPreview(() =>
        runOperation(
          async (executor) =>
            (await observeMigrationPlan(executor, planningOptions, 'preview')).planned
              .plan,
        ),
      )
    },

    /** Builds and lowers the plan without executing physical actions. */
    async dryRun() {
      const policy: MigrationLoweringPolicy = {
        columnDrop: allowed.has('dangerouslyDropColumn') ? 'dangerous' : 'guarded',
      }

      return runMigrationPreview(() =>
        runOperation(async (executor) => {
          const { planned, expected } = await observeMigrationPlan(
            executor,
            planningOptions,
            'preview',
          )

          return dryRunProgram(lowerPlan(migration, planned, expected, 'preview', policy))
        }),
      )
    },
  }
}

/**
 * Preserves expected preview errors and leaves defects unchanged.
 *
 * @param operation - Work to run within the current session or error boundary.
 *
 * @returns The preview result after successful session cleanup.
 */
async function runMigrationPreview<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const cleanupFailures = operationCleanupFailures(error)
    const cause = operationPrimaryFailure(error)

    if (isErrorTag(cause, 'MigrationError')) throw cause

    if (
      isErrorTag(cause, 'QueryError') ||
      isErrorTag(cause, 'DriverError') ||
      cleanupFailures.length
    ) {
      throw new MigrationError({
        message: `Migration ${cleanupFailures.length ? 'session cleanup' : 'introspection'} failed${isErrorTag(cause, 'QueryError') ? `: ${cause.message}` : ''}`,
        cause,
        ...(isDefect(cause) ? { defect: true as const } : {}),
        stage: cleanupFailures.length ? 'sessionCleanup' : 'introspection',
        outcome: 'unchanged',
        retryable: false,
        ...(cleanupFailures.length ? { cleanupFailures } : {}),
      })
    }

    throw cause
  }
}

/**
 * Discards uncertain sessions when an adapter throws an unstructured execution failure.
 *
 * @param cause - Original rejection whose identity and failure details must be preserved.
 * @param discard - Callback that prevents reuse of the current physical session.
 */
function throwAdapterExecutionError(cause: unknown, discard: () => void): never {
  if (isErrorTag(cause, 'MigrationError')) throw cause
  if (isErrorTag(cause, 'SchemaError')) throw cause

  discard()
  throw new MigrationError({
    message: 'Migration DDL execution failed',
    cause: cause,
    ...(isDefect(cause) ? { defect: true as const } : {}),
    stage: 'ddl',
    outcome: 'unknown',
    retryable: false,
  })
}

/** Marks only invariant or unrecognized failures as defects. */
function isDefect(cause: unknown): boolean {
  return (
    !isErrorTag(cause, 'MigrationError') &&
    !isErrorTag(cause, 'QueryError') &&
    !isErrorTag(cause, 'DriverError') &&
    !isErrorTag(cause, 'SchemaError')
  )
}

export type {
  MigrationAllow,
  MigrationExecuteOptions,
  MigrationDryRunStatement,
  MigrationDryRunAction,
  MigrationDryRun,
  MigrateBuilder,
}

export { createMigrateBuilder }
