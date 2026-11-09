import type { MigrationSemanticProfile, PlannedMigration } from '@/ddl/migrationPlan'
import type {
  MigrationAction,
  MigrationCapabilityIssue,
  MigrationLoweringPolicy,
  MigrationLoweringResult,
  MigrationPrecondition,
} from '@/ddl/migrationProgram'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'
import { attemptSync, isErrorTag } from '@/utils/error'

import { postgresIdentity } from '../identity'

import type { ActionDraft } from './orderActions'
import { orderActions } from './orderActions'
import { compilePostgresDdl } from './sql'
import { stepTargetIssues, stepToAst } from './targets'

/**
 * Compares authored namespace inputs under canonical PostgreSQL identity rules.
 *
 * @param left - First authored namespace, or no configured namespace.
 * @param right - Second authored namespace, or no configured namespace.
 * @param identities - Canonical identity module used to resolve both inputs.
 */
function sameNamespaceInput(
  left: readonly NamespaceIdentifierInput[] | undefined,
  right: readonly NamespaceIdentifierInput[] | undefined,
  identities: CanonicalRelationIdentityModule,
): boolean {
  /**
   * Resolves one authored namespace, preserving invalid input as a mismatch sentinel.
   *
   * @param input - Authored namespace to resolve.
   */
  function resolve(
    input: readonly NamespaceIdentifierInput[] | undefined,
  ): CanonicalRelationIdentity['namespace'] | null | undefined {
    if (!input?.length) return undefined

    try {
      return identities.resolveNamespace(input)
    } catch (cause) {
      if (!isErrorTag(cause, 'SchemaError')) throw cause

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
 * Collects every deterministic semantic-profile mismatch.
 *
 * @param planned - Migration and semantic profile produced during planning.
 * @param expected - Semantic profile resolved by the executing session.
 */
function profileIssues(
  planned: PlannedMigration,
  expected: MigrationSemanticProfile,
): MigrationCapabilityIssue[] {
  const issues: MigrationCapabilityIssue[] = []

  /**
   * Appends one profile mismatch in canonical issue form.
   *
   * @param message - Profile mismatch description.
   */
  function add(message: string): void {
    issues.push({ code: 'profile_mismatch', message, sourceStepIndexes: [] })
  }

  if (expected.identityAdapter !== postgresIdentity.id) {
    add(
      `Executing profile adapter '${expected.identityAdapter}' does not match PostgreSQL`,
    )
  }

  if (planned.profile.identityAdapter !== expected.identityAdapter) {
    add(
      `Identity adapter '${planned.profile.identityAdapter}' does not match executing adapter '${expected.identityAdapter}'`,
    )
  }

  if (
    !sameNamespaceInput(
      planned.profile.namespaceContext.writableDefault,
      expected.namespaceContext.writableDefault,
      planned.identities,
    )
  ) {
    add('Writable namespace context does not match the executing session')
  }

  if (
    !sameNamespaceInput(
      planned.profile.registrationDefault,
      expected.registrationDefault,
      planned.identities,
    )
  ) {
    add('Registration default does not match the executing configuration')
  }

  return issues
}

const ISSUE_ORDER: Record<MigrationCapabilityIssue['code'], number> = {
  profile_mismatch: 0,
  missing_desired_table: 1,
  invalid_target: 2,
  compile_failure: 3,
  unsupported_dependency_cycle: 4,
}

/**
 * Resolves the executing database identifier from a PostgreSQL semantic profile.
 *
 * @param planned - Planned migration supplying canonical identity resolution.
 * @param expectedProfile - Semantic profile resolved by the executing session.
 */
function expectedDatabaseIdentifier(
  planned: PlannedMigration,
  expectedProfile: MigrationSemanticProfile,
): CanonicalIdentifier | undefined {
  try {
    const namespace = planned.identities.resolveNamespace(
      expectedProfile.namespaceContext.writableDefault,
    )

    const database = namespace.at(0)

    if (namespace.length === 2 && database?.role === 'database') {
      return database.identifier
    }
  } catch (cause) {
    if (!isErrorTag(cause, 'SchemaError')) throw cause
    // Profile and target validation report malformed context.
  }

  return undefined
}

/**
 * Orders capability issues by source step, capability code, and message.
 *
 * @param left - First capability issue.
 * @param right - Second capability issue.
 */
function compareCapabilityIssues(
  left: MigrationCapabilityIssue,
  right: MigrationCapabilityIssue,
): number {
  const sourceOrder =
    (left.sourceStepIndexes[0] ?? -1) - (right.sourceStepIndexes[0] ?? -1)

  if (sourceOrder !== 0) return sourceOrder

  const codeOrder = ISSUE_ORDER[left.code] - ISSUE_ORDER[right.code]

  if (codeOrder !== 0) return codeOrder

  if (left.message < right.message) return -1
  if (left.message > right.message) return 1

  return 0
}

/**
 * Purely lowers and compiles a complete PostgreSQL Migration Plan.
 *
 * @example
 *   const result = lowerPostgresMigrationPlan(planned, expectedProfile)
 *
 * @param planned - Complete semantic plan and its canonical registrations.
 * @param expectedProfile - Semantic profile resolved by the executing session.
 */
function lowerPostgresMigrationPlan(
  planned: PlannedMigration,
  expectedProfile: MigrationSemanticProfile,
  policy: MigrationLoweringPolicy = { columnDrop: 'guarded' },
): MigrationLoweringResult {
  const issues = profileIssues(planned, expectedProfile)

  if (issues.length > 0) {
    issues.sort(compareCapabilityIssues)
    return { issues }
  }

  const drafts: ActionDraft[] = []
  const preconditions: MigrationPrecondition[] = []
  const expectedDatabase = expectedDatabaseIdentifier(planned, expectedProfile)

  compileMigrationSteps(planned, expectedDatabase, issues, drafts, preconditions, policy)

  const ordered = orderActions(drafts, planned)
  issues.push(...ordered.issues)
  issues.sort(compareCapabilityIssues)

  if (issues.length > 0) return { issues }

  const actions: MigrationAction[] = ordered.ordered.map((draft) => ({
    sourceStepIndexes: [draft.sourceStepIndex],
    transaction: 'required',
    statements: [draft.statement],
  }))

  return {
    program: {
      atomicity: 'plan-atomic',
      preconditions,
      actions,
    },
  }
}

/** Compiles supported steps while collecting every deterministic issue and precondition. */
function compileMigrationSteps(
  planned: PlannedMigration,
  expectedDatabase: Readonly<{ spelling: string; comparisonKey: string }> | undefined,
  issues: MigrationCapabilityIssue[],
  drafts: ActionDraft[],
  preconditions: MigrationPrecondition[],
  policy: MigrationLoweringPolicy,
) {
  for (const [sourceStepIndex, step] of planned.plan.steps.entries()) {
    compileMigrationStep(
      { planned, expectedDatabase, issues, drafts, preconditions, policy },
      step,
      sourceStepIndex,
    )
  }
}

type MigrationStepCompilation = {
  planned: PlannedMigration
  expectedDatabase: Readonly<{ spelling: string; comparisonKey: string }> | undefined
  issues: Readonly<{
    code:
      | 'profile_mismatch'
      | 'missing_desired_table'
      | 'invalid_target'
      | 'compile_failure'
      | 'unsupported_dependency_cycle'
    message: string
    sourceStepIndexes: readonly number[]
  }>[]
  drafts: ActionDraft[]
  preconditions: MigrationPrecondition[]
  policy: MigrationLoweringPolicy
}

/**
 * Validates one Migration Target and records its physical statement or compilation issue.
 *
 * @param input - Migration step compilation inputs and shared accumulators.
 * @param step - Semantic Migration Plan step whose structured target must be preserved.
 * @param sourceStepIndex - Original semantic step index retained in physical actions and
 *   diagnostics.
 */
function compileMigrationStep(
  input: MigrationStepCompilation,
  step: PlannedMigration['plan']['steps'][number],
  sourceStepIndex: number,
) {
  const { planned, issues, drafts, preconditions } = input

  if (collectStepTargetIssues(input, step, sourceStepIndex)) return

  const compiled = attemptSync(() => {
    const ast = stepToAst(step, planned)

    if (!ast) return undefined

    return compilePostgresDdl(ast)
  })

  if (!compiled.ok) {
    appendMigrationCompilationIssue(compiled, issues, sourceStepIndex)

    return
  }

  if (!compiled.value) {
    const relation = step.target.kind === 'namespace' ? undefined : step.target.relation
    issues.push({
      code: 'missing_desired_table',
      message: `Cannot create table ${relation ? planned.identities.format(relation) : 'unknown target'}: lowered desired table not found`,
      sourceStepIndexes: [sourceStepIndex],
    })

    return
  }

  drafts.push({ step, sourceStepIndex, statement: compiled.value })

  if (step.kind === 'set_not_null') {
    preconditions.push({
      kind: 'column_has_no_nulls',
      relation: step.target.relation,
      column: step.target.column.spelling,
      sourceStepIndexes: [sourceStepIndex],
    })
  }

  if (step.kind === 'drop_column' && input.policy.columnDrop === 'guarded') {
    preconditions.push({
      kind: 'column_has_only_nulls',
      target: step.target,
      sourceStepIndexes: [sourceStepIndex],
    })
  }
}

/**
 * Adds a compilation failure with its original source-step index.
 *
 * @param compiled - Compiled SQL, bound parameters, and optional session preconditions.
 * @param issues - Mutable validation or capability issues collected before exposing a
 *   plan.
 * @param sourceStepIndex - Original semantic step index retained in physical actions and
 *   diagnostics.
 */
function appendMigrationCompilationIssue(
  compiled: Readonly<{ ok: false; error: unknown }>,
  issues: Readonly<{
    code:
      | 'profile_mismatch'
      | 'missing_desired_table'
      | 'invalid_target'
      | 'compile_failure'
      | 'unsupported_dependency_cycle'
    message: string
    sourceStepIndexes: readonly number[]
  }>[],
  sourceStepIndex: number,
) {
  const cause = compiled.error

  if (!isErrorTag(cause, 'SchemaError')) throw cause

  issues.push({
    code: 'compile_failure',
    message: `Cannot compile migration step ${sourceStepIndex}: ${cause.message}`,
    sourceStepIndexes: [sourceStepIndex],
  })
}

/**
 * Collects every target-validation issue before attempting physical statement
 * compilation.
 *
 * @param input - Migration step compilation inputs and shared accumulators.
 * @param step - Semantic Migration Plan step whose structured target must be preserved.
 * @param sourceStepIndex - Original semantic step index retained in physical actions and
 *   diagnostics.
 *
 * @returns True when collect step target issues applies to the supplied input.
 */
function collectStepTargetIssues(
  input: MigrationStepCompilation,
  step: PlannedMigration['plan']['steps'][number],
  sourceStepIndex: number,
) {
  const { planned, expectedDatabase, issues } = input
  const invalidTargets = stepTargetIssues(step, expectedDatabase)
  for (const message of invalidTargets) {
    issues.push({
      code: 'invalid_target',
      message,
      sourceStepIndexes: [sourceStepIndex],
    })
  }

  const missingDesiredTable =
    step.kind === 'create_table' && !planned.desiredTables.has(step.target.relation)

  if (missingDesiredTable) {
    issues.push({
      code: 'missing_desired_table',
      message: `Cannot create table ${planned.identities.format(step.target.relation)}: lowered desired table not found`,
      sourceStepIndexes: [sourceStepIndex],
    })
  }

  return invalidTargets.length > 0 || missingDesiredTable
}

export { lowerPostgresMigrationPlan }
