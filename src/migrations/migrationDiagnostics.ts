import type {
  MigrationCleanupFailure,
  MigrationExecutionOutcome,
  MigrationExecutionStage,
} from '@/utils/error'
import { MigrationError } from '@/utils/error'

type Enrichment = Readonly<{
  message?: string
  stage?: MigrationExecutionStage
  outcome?: MigrationExecutionOutcome
  retryable?: boolean
  cleanupFailures?: readonly MigrationCleanupFailure[]
}>

/** Adds phase or release diagnostics without changing the primary failure. */
export function enrichMigrationError(
  error: MigrationError,
  changes: Enrichment,
): MigrationError {
  const message = changes.message ?? error.message
  const cause = Object.hasOwn(error, 'cause') ? { cause: error.cause } : {}
  const defect = error.defect === undefined ? {} : { defect: error.defect }

  const stage =
    (changes.stage ?? error.stage) ? { stage: changes.stage ?? error.stage } : {}

  const outcome =
    (changes.outcome ?? error.outcome)
      ? { outcome: changes.outcome ?? error.outcome }
      : {}

  const retryable =
    changes.retryable !== undefined || error.retryable !== undefined
      ? { retryable: changes.retryable ?? error.retryable }
      : {}

  const actionIndex =
    error.actionIndex !== undefined ? { actionIndex: error.actionIndex } : {}

  const sourceStepIndexes = error.sourceStepIndexes
    ? { sourceStepIndexes: error.sourceStepIndexes }
    : {}

  const capabilityIssues = error.capabilityIssues
    ? { capabilityIssues: error.capabilityIssues }
    : {}

  const maybeCleanupFailures = changes.cleanupFailures?.length
    ? [...(error.cleanupFailures ?? []), ...changes.cleanupFailures]
    : error.cleanupFailures

  const cleanupFailures = maybeCleanupFailures
    ? { cleanupFailures: maybeCleanupFailures }
    : {}

  return new MigrationError({
    message: message,
    ...cause,
    ...defect,
    ...stage,
    ...outcome,
    ...retryable,
    ...actionIndex,
    ...sourceStepIndexes,
    ...capabilityIssues,
    ...cleanupFailures,
  })
}

type ExecutionFacts = Readonly<{
  stage: MigrationExecutionStage
  outcome: MigrationExecutionOutcome
  retryable: boolean
  defect: boolean
  message: (actionIndex: number | undefined) => string
  actionIndex?: number
  sourceStepIndexes?: readonly number[]
  capabilityIssues?: MigrationError['capabilityIssues']
  cleanupFailures?: readonly MigrationCleanupFailure[]
}>

/** Retains explicitly supplied undefined optional diagnostics. */
function includeOptionalDiagnostic(
  value: unknown,
  facts: ExecutionFacts,
  key: 'actionIndex' | 'sourceStepIndexes' | 'capabilityIssues' | 'cleanupFailures',
): boolean {
  return value !== undefined || Object.hasOwn(facts, key)
}

/** Resolves provenance and ordered cleanup from a structured failure. */
function retainedExecutionDiagnostics(
  structured: MigrationError | undefined,
  facts: ExecutionFacts,
) {
  const actionIndex = facts.actionIndex ?? structured?.actionIndex
  const sourceStepIndexes = facts.sourceStepIndexes ?? structured?.sourceStepIndexes
  const capabilityIssues = facts.capabilityIssues ?? structured?.capabilityIssues
  const cleanupFailures = [
    ...(structured?.cleanupFailures ?? []),
    ...(facts.cleanupFailures ?? []),
  ]

  const optionalCleanupFailures = cleanupFailures.length ? cleanupFailures : undefined

  return {
    actionIndex,
    fields: {
      ...(includeOptionalDiagnostic(actionIndex, facts, 'actionIndex')
        ? { actionIndex }
        : {}),
      ...(includeOptionalDiagnostic(sourceStepIndexes, facts, 'sourceStepIndexes')
        ? { sourceStepIndexes }
        : {}),
      ...(includeOptionalDiagnostic(capabilityIssues, facts, 'capabilityIssues')
        ? { capabilityIssues }
        : {}),
      ...(includeOptionalDiagnostic(optionalCleanupFailures, facts, 'cleanupFailures')
        ? { cleanupFailures: optionalCleanupFailures }
        : {}),
    },
  }
}

/** Constructs an execution failure from adapter facts and any existing diagnostics. */
export function migrationExecutionError(
  cause: unknown,
  facts: ExecutionFacts,
): MigrationError {
  const structured = cause instanceof MigrationError ? cause : undefined
  const defect = structured ? structured.defect === true : facts.defect
  const diagnostics = retainedExecutionDiagnostics(structured, facts)

  return new MigrationError({
    message: facts.message(diagnostics.actionIndex),
    cause: structured && Object.hasOwn(structured, 'cause') ? structured.cause : cause,
    ...(defect ? { defect: true as const } : {}),
    stage: facts.stage,
    outcome: facts.outcome,
    retryable:
      facts.outcome === 'unknown' ? false : (structured?.retryable ?? facts.retryable),
    ...diagnostics.fields,
  })
}
