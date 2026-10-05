import type { DialectMigrationAdapter, MigrationProgram } from '@/ddl/migrationProgram'
import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import { getOperationReleaseCleanupFailures } from '@/operations/coordinator'
import type { Executor } from '@/query'
import type { TableHandle } from '@/types'
import type { MigrationExecutionStage } from '@/utils/error'
import { MigrationError, attempt, attemptSync } from '@/utils/error'

import type {
  MigrationPlan,
  MigrationSemanticProfile,
  MigrationStep,
} from './migrationPlan'
import { planMigration } from './migrationPlan'

/** Destructive migrate operations that require explicit execution permission. */
export type MigrationAllow = 'dropColumn' | 'dropTable' | 'dropIndex'

/** Optional cancellation and finite coordination deadline for migration execution. */
export type MigrationExecuteOptions = Readonly<{
  signal?: AbortSignal
  lockTimeoutMs?: number
}>

/** Non-executable statement preview; every bound parameter is redacted. */
export type MigrationDryRunStatement = Readonly<{
  sql: string
  /** One `[REDACTED]` marker per bound parameter, preserving count and order. */
  params: readonly '[REDACTED]'[]
}>

/** Non-executable physical action projected from dialect whole-plan lowering. */
export type MigrationDryRunAction = Readonly<{
  sourceStepIndexes: readonly number[]
  transaction: 'required' | 'allowed' | 'forbidden'
  statements: readonly MigrationDryRunStatement[]
}>

/** Ordered, non-executable physical preview of a complete Migration Plan. */
export type MigrationDryRun = Readonly<{
  atomicity: 'plan-atomic' | 'statement-atomic' | 'non-atomic'
  preconditions: MigrationProgram['preconditions']
  actions: readonly MigrationDryRunAction[]
}>

export type MigrateBuilder = {
  /**
   * Grants execution permission for destructive migration operations.
   *
   * @param ops - Destructive operations to permit.
   */
  allow(...ops: MigrationAllow[]): MigrateBuilder

  /** Builds a semantic Migration Plan without lowering or executing it. */
  plan(): Promise<MigrationPlan>

  /** Lowers the complete plan and returns ordered SQL with all bound values redacted. */
  dryRun(): Promise<MigrationDryRun>

  /**
   * Plans and executes the migration through the selected dialect.
   *
   * @param options - Optional cancellation signal and lock deadline.
   */
  execute(options?: MigrationExecuteOptions): Promise<void>
}

/**
 * Adds an execution phase without replacing an already structured migration failure.
 *
 * @param cause - Failure to structure.
 * @param stage - Migration stage that observed the failure.
 */
function phaseError(cause: unknown, stage: MigrationExecutionStage): MigrationError {
  if (cause instanceof MigrationError && cause.stage !== undefined) return cause

  return new MigrationError({
    message: cause instanceof Error ? cause.message : 'Migration failed',
    cause:
      cause instanceof MigrationError && cause.cause !== undefined ? cause.cause : cause,
    stage,
    outcome: 'unchanged',
    retryable: false,
  })
}

/**
 * Appends provider-release cleanup without replacing a structured primary failure.
 *
 * @param error - Structured primary migration failure.
 */
function withReleaseCleanup(error: MigrationError): MigrationError {
  const failures = getOperationReleaseCleanupFailures(error)

  if (failures.length === 0) return error

  return new MigrationError({
    message: error.message,
    ...(error.cause === undefined ? {} : { cause: error.cause }),
    ...(error.stage === undefined ? {} : { stage: error.stage }),
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
    ...(error.actionIndex === undefined ? {} : { actionIndex: error.actionIndex }),
    ...(error.sourceStepIndexes === undefined
      ? {}
      : { sourceStepIndexes: error.sourceStepIndexes }),
    ...(error.capabilityIssues === undefined
      ? {}
      : { capabilityIssues: error.capabilityIssues }),
    cleanupFailures: [
      ...(error.cleanupFailures ?? []),
      ...failures.map((cause) => ({ stage: 'sessionCleanup' as const, cause })),
    ],
  })
}

/**
 * Maps retained coordinator release failures into observable migration cleanup evidence.
 *
 * @param cause - Primary rejection that may retain secondary release failures.
 */
function sessionCleanupFailures(
  cause: unknown,
): readonly Readonly<{ stage: 'sessionCleanup'; cause: unknown }>[] {
  return getOperationReleaseCleanupFailures(cause).map((failure) => ({
    stage: 'sessionCleanup' as const,
    cause: failure,
  }))
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
      return 'dropColumn'
    case 'drop_table':
      return 'dropTable'
    case 'drop_index':
      return 'dropIndex'
    case 'ensure_namespace':
    case 'create_table':
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
): MigrationProgram {
  const lowering = attemptSync(() => migration.lower(planned, expected))

  if (!lowering.ok) throw phaseError(lowering.error, 'lowering')

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
      relation: {
        namespace: precondition.relation.namespace.map((segment) => ({
          ...segment,
          identifier: { ...segment.identifier },
        })),
        relation: { ...precondition.relation.relation },
      },
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
    'schemas' | 'migration' | 'migrationOwnership' | 'defaultNamespace'
  >,
) {
  const { schemas, migration, migrationOwnership, defaultNamespace } = options
  let request

  try {
    request = createCatalogRequest(schemas, migrationOwnership ?? [], defaultNamespace)
  } catch (cause) {
    throw phaseError(cause, 'planning')
  }

  let catalog

  try {
    catalog = await migration.catalog.introspectCatalog(executor, request)
  } catch (cause) {
    throw phaseError(cause, 'introspection')
  }

  let planned

  try {
    planned = planMigration(schemas, catalog, migration.planning, {
      ...(defaultNamespace === undefined
        ? {}
        : { registrationDefault: defaultNamespace }),
      ...(migrationOwnership === undefined ? {} : { migrationOwnership }),
    })
  } catch (cause) {
    throw phaseError(cause, 'planning')
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

  return lowerPlan(planningOptions.migration, planned, expected)
}

type MigrateBuilderOptions = {
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
 *   await migrate.allow('dropColumn').execute()
 *
 * @param options - Migration schemas, selected member, operation runner, and policy.
 *
 * @returns A migration builder separating generic planning and permissions from dialect
 *   execution.
 */
export function createMigrateBuilder(options: MigrateBuilderOptions): MigrateBuilder {
  const { migration, runOperation, applicationId, assertCanExecute } = options
  const { schemas, defaultNamespace, migrationOwnership } = options
  const planningOptions = { schemas, migration, defaultNamespace, migrationOwnership }
  const allowed = new Set<MigrationAllow>()

  const builder: MigrateBuilder = {
    /**
     * Grants execution permission for destructive migration operations.
     *
     * @param ops - Destructive operations to permit.
     */
    allow(...ops) {
      for (const op of ops) allowed.add(op)
      return builder
    },
    ...createMigrationPreview({
      ...planningOptions,
      runOperation,
      applicationId,
      assertCanExecute,
    }),

    /**
     * Plans and executes the migration through the selected dialect.
     *
     * @param executeOptions - Optional cancellation signal and lock deadline.
     */
    execute: (executeOptions) =>
      executeMigration(
        { ...planningOptions, runOperation, applicationId, assertCanExecute },
        allowed,
        executeOptions,
      ),
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
  const { schemas, defaultNamespace, migrationOwnership } = options
  const planningOptions = { schemas, migration, defaultNamespace, migrationOwnership }
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
  if (cause instanceof MigrationError) throw withReleaseCleanup(cause)

  const cleanupFailures = sessionCleanupFailures(cause)

  if (success) {
    throw new MigrationError({
      message:
        cause instanceof Error ? cause.message : 'Migration session cleanup failed',
      cause,
      stage: 'sessionCleanup',
      outcome: success.outcome,
      retryable: false,
      cleanupFailures: [{ stage: 'sessionCleanup', cause }, ...cleanupFailures],
    })
  }

  throw new MigrationError({
    message:
      cause instanceof Error ? cause.message : 'Migration operation session failed',
    cause,
    stage: 'sessionCleanup',
    outcome: 'unchanged',
    retryable: false,
    cleanupFailures: [{ stage: 'sessionCleanup', cause }, ...cleanupFailures],
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
): Pick<MigrateBuilder, 'plan' | 'dryRun'> {
  const { migration, runOperation } = options
  const planningOptions = options
  return {
    /** Builds a semantic Migration Plan without lowering or executing it. */
    async plan() {
      return runMigrationPreview(
        () =>
          runOperation(
            async (executor) =>
              (await observeMigrationPlan(executor, planningOptions)).planned.plan,
          ),
        'Migration planning failed',
      )
    },

    /** Builds and lowers the plan without executing physical actions. */
    async dryRun() {
      return runMigrationPreview(
        () =>
          runOperation(async (executor) => {
            const { planned, expected } = await observeMigrationPlan(
              executor,
              planningOptions,
            )
            return dryRunProgram(lowerPlan(migration, planned, expected))
          }),
        'Migration dry-run failed',
      )
    },
  }
}

/**
 * Preserves structured preview errors and includes retained session cleanup failures.
 *
 * @param operation - Work to run within the current session or error boundary.
 * @param failureMessage - Fallback diagnostic when a rejection is not an Error instance.
 *
 * @returns The preview result after successful session cleanup.
 */
async function runMigrationPreview<T>(
  operation: () => Promise<T>,
  failureMessage: string,
): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    if (cause instanceof MigrationError) throw withReleaseCleanup(cause)

    const cleanupFailures = sessionCleanupFailures(cause)
    throw new MigrationError({
      message: cause instanceof Error ? cause.message : failureMessage,
      ...(cause !== undefined ? { cause } : {}),
      ...(cleanupFailures.length > 0 ? { cleanupFailures } : {}),
    })
  }
}

/**
 * Discards uncertain sessions when an adapter throws an unstructured execution failure.
 *
 * @param cause - Original rejection whose identity and failure details must be preserved.
 * @param discard - Callback that prevents reuse of the current physical session.
 */
function throwAdapterExecutionError(cause: unknown, discard: () => void): never {
  if (cause instanceof MigrationError) throw cause

  discard()
  throw new MigrationError({
    message:
      cause instanceof Error ? cause.message : 'Migration adapter execution failed',
    cause: cause,
    stage: 'ddl',
    outcome: 'unknown',
    retryable: false,
  })
}
