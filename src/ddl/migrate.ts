import type { Dialect } from '@/dialects'
import type { NamespaceIdentifierInput } from '@/migrations/canonicalRelationIdentity'
import type { MigrationOwnershipDeclaration } from '@/migrations/migrationOwnership'
import { createCatalogRequest } from '@/migrations/migrationOwnership'
import { getOperationReleaseCleanupFailures } from '@/operations/coordinator'
import type { Executor } from '@/query'
import type { TableHandle } from '@/types'
import type { MigrationExecutionStage } from '@/utils/error'
import { MigrationError } from '@/utils/error'

import type {
  MigrationPlan,
  MigrationSemanticProfile,
  MigrationStep,
} from './migrationPlan'
import { planMigration } from './migrationPlan'

export {
  MIGRATE_ADVISORY_LOCK_CLASS,
  MIGRATE_ADVISORY_LOCK_ID,
} from '@/migrations/coordinationScope'

/** Destructive migrate operations that require explicit execution permission. */
export type MigrationAllow = 'dropColumn' | 'dropTable' | 'dropIndex'

/** Optional cancellation and finite coordination deadline for migration execution. */
export type MigrationExecuteOptions = Readonly<{
  signal?: AbortSignal
  lockTimeoutMs?: number
}>

export type MigrateBuilder = {
  allow(...ops: MigrationAllow[]): MigrateBuilder
  dryRun(): Promise<MigrationPlan>
  execute(options?: MigrationExecuteOptions): Promise<void>
}

const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 30_000

/** Adds an execution phase without replacing an already structured migration failure. */
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

/** Appends provider-release cleanup without replacing a structured primary failure. */
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
    cleanupFailures: [
      ...(error.cleanupFailures ?? []),
      ...failures.map((cause) => ({ stage: 'sessionCleanup' as const, cause })),
    ],
  })
}

/** Resolves and validates the finite migration lock deadline. */
function lockTimeout(options: MigrationExecuteOptions | undefined): number {
  const value = options?.lockTimeoutMs ?? DEFAULT_MIGRATION_LOCK_TIMEOUT_MS
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

/** Maps a destructive semantic step to its required permission. */
function allowForStep(step: MigrationStep): MigrationAllow | undefined {
  switch (step.kind) {
    case 'drop_column':
      return 'dropColumn'
    case 'drop_table':
      return 'dropTable'
    case 'drop_index':
      return 'dropIndex'
    default:
      return undefined
  }
}

/**
 * Desired-state migration orchestration. Planning and permissions remain generic;
 * lowering and all execution mechanics belong to the selected dialect migration facet.
 */
export function createMigrateBuilder(options: {
  schemas: readonly TableHandle[]
  dialect: Dialect
  runOperation<T>(
    operation: (
      executor: Executor,
      databaseIdentity: string,
      discard: () => void,
      cancel: () => Promise<void>,
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

  /** Introspects the operation session and creates its canonical semantic plan. */
  const buildPlan = async (executor: Executor) => {
    let request
    try {
      request = createCatalogRequest(schemas, migrationOwnership ?? [], defaultNamespace)
    } catch (cause) {
      throw phaseError(cause, 'planning')
    }
    let catalog
    try {
      catalog = await dialect.catalog.introspectCatalog(executor, request)
    } catch (cause) {
      throw phaseError(cause, 'introspection')
    }
    let planned
    try {
      planned = planMigration(schemas, catalog, dialect, {
        ...(defaultNamespace === undefined
          ? {}
          : { registrationDefault: defaultNamespace }),
        ...(migrationOwnership === undefined ? {} : { migrationOwnership }),
      })
    } catch (cause) {
      throw phaseError(cause, 'planning')
    }
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
    allow(...ops) {
      for (const op of ops) allowed.add(op)
      return builder
    },

    async dryRun() {
      try {
        return await runOperation(
          async (executor) => (await buildPlan(executor)).planned.plan,
        )
      } catch (cause) {
        if (cause instanceof MigrationError) throw cause
        throw new MigrationError({
          message: cause instanceof Error ? cause.message : 'Migration dry-run failed',
          ...(cause !== undefined ? { cause } : {}),
        })
      }
    },

    async execute(executeOptions) {
      const lockTimeoutMs = lockTimeout(executeOptions)
      try {
        assertCanExecute?.()
      } catch (cause) {
        throw phaseError(cause, 'permission')
      }
      let runtimeSuccess: { outcome: 'applied' | 'unchanged' } | undefined
      let operationCallbackReturned = false
      try {
        const migration = dialect.migration
        if (!migration) {
          throw new MigrationError({
            message: `Dialect '${dialect.id}' does not support migration execution`,
            stage: 'lowering',
            outcome: 'unchanged',
            retryable: false,
          })
        }
        await runOperation(async (executor, databaseIdentity, discard, cancel) => {
          try {
            runtimeSuccess = await migration.execute({
              executor,
              databaseIdentity,
              discard,
              cancel,
              lockTimeoutMs,
              ...(applicationId === undefined ? {} : { applicationId }),
              ...(executeOptions?.signal === undefined
                ? {}
                : { signal: executeOptions.signal }),
              prepare: async () => {
                const { planned, expected } = await buildPlan(executor)
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
                let lowered
                try {
                  lowered = migration.lower(planned, expected)
                } catch (cause) {
                  throw phaseError(cause, 'lowering')
                }
                if (lowered.issues) {
                  const sourceStepIndexes = [
                    ...new Set(
                      lowered.issues.flatMap((issue) => issue.sourceStepIndexes),
                    ),
                  ].sort((left, right) => left - right)
                  throw new MigrationError({
                    message: lowered.issues.map((issue) => issue.message).join('\n'),
                    stage: 'lowering',
                    outcome: 'unchanged',
                    retryable: false,
                    sourceStepIndexes,
                  })
                }
                return lowered.program
              },
            })
          } catch (cause) {
            if (cause instanceof MigrationError) throw cause
            discard()
            throw new MigrationError({
              message:
                cause instanceof Error
                  ? cause.message
                  : 'Migration adapter execution failed',
              cause,
              stage: 'ddl',
              outcome: 'unknown',
              retryable: false,
            })
          }
          operationCallbackReturned = true
          return runtimeSuccess
        })
      } catch (cause) {
        if (cause instanceof MigrationError) throw withReleaseCleanup(cause)
        if (operationCallbackReturned && runtimeSuccess) {
          throw new MigrationError({
            message:
              cause instanceof Error ? cause.message : 'Migration session cleanup failed',
            cause,
            stage: 'sessionCleanup',
            outcome: runtimeSuccess.outcome,
            retryable: false,
            cleanupFailures: [{ stage: 'sessionCleanup', cause }],
          })
        }
        throw new MigrationError({
          message:
            cause instanceof Error ? cause.message : 'Migration operation session failed',
          cause,
          stage: 'sessionCleanup',
          outcome: 'unchanged',
          retryable: false,
          cleanupFailures: [{ stage: 'sessionCleanup', cause }],
        })
      }
    },
  }

  return builder
}
