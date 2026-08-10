import type { MigrationSemanticProfile, PlannedMigration } from '@/ddl/migrationPlan'
import type {
  MigrationAction,
  MigrationCapabilityIssue,
  MigrationLoweringResult,
  MigrationPrecondition,
} from '@/ddl/migrationProgram'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
  NamespaceIdentifierInput,
} from '@/migrations/canonicalRelationIdentity'

import { compilePostgres } from '../compile'

import type { ActionDraft } from './orderActions'
import { orderActions } from './orderActions'
import { stepTargetIssues, stepToAst } from './targets'

/** Compares authored namespace inputs under canonical PostgreSQL identity rules. */
function sameNamespaceInput(
  left: readonly NamespaceIdentifierInput[] | undefined,
  right: readonly NamespaceIdentifierInput[] | undefined,
  identities: CanonicalRelationIdentityModule,
): boolean {
  function resolve(
    input: readonly NamespaceIdentifierInput[] | undefined,
  ): CanonicalRelationIdentity['namespace'] | null | undefined {
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

/** Collects every deterministic semantic-profile mismatch. */
function profileIssues(
  planned: PlannedMigration,
  expected: MigrationSemanticProfile,
): MigrationCapabilityIssue[] {
  const issues: MigrationCapabilityIssue[] = []
  function add(message: string): void {
    issues.push({ code: 'profile_mismatch', message, sourceStepIndexes: [] })
  }
  if (expected.identityAdapter !== 'postgresql') {
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

/** Resolves the executing database identifier from a PostgreSQL semantic profile. */
function expectedDatabaseIdentifier(
  planned: PlannedMigration,
  expectedProfile: MigrationSemanticProfile,
): CanonicalIdentifier | undefined {
  try {
    const namespace = planned.identities.resolveNamespace(
      expectedProfile.namespaceContext.writableDefault,
    )
    const database = namespace[0]
    if (namespace.length === 2 && database?.role === 'database') {
      return database.identifier
    }
  } catch {
    // Profile and target validation report malformed context.
  }
  return undefined
}

/** Orders capability issues by source step, capability code, and message. */
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

/** Purely lowers and compiles a complete PostgreSQL Migration Plan. */
export function lowerPostgresMigrationPlan(
  planned: PlannedMigration,
  expectedProfile: MigrationSemanticProfile,
): MigrationLoweringResult {
  const issues = profileIssues(planned, expectedProfile)
  const drafts: ActionDraft[] = []
  const preconditions: MigrationPrecondition[] = []
  const expectedDatabase = expectedDatabaseIdentifier(planned, expectedProfile)

  for (const [sourceStepIndex, step] of planned.plan.steps.entries()) {
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
        message: `Cannot create table ${planned.identities.format(step.target.relation)}: lowered CreateTableAst not found`,
        sourceStepIndexes: [sourceStepIndex],
      })
    }
    if (invalidTargets.length > 0 || missingDesiredTable) continue

    try {
      const ast = stepToAst(step, planned)
      if (!ast) {
        const relation =
          step.target.kind === 'namespace' ? undefined : step.target.relation
        issues.push({
          code: 'missing_desired_table',
          message: `Cannot create table ${relation ? planned.identities.format(relation) : 'unknown target'}: lowered CreateTableAst not found`,
          sourceStepIndexes: [sourceStepIndex],
        })
        continue
      }
      const statement = compilePostgres(ast)
      drafts.push({ step, sourceStepIndex, statement })
      if (step.kind === 'set_not_null') {
        preconditions.push({
          kind: 'column_has_no_nulls',
          relation: step.target.relation,
          column: step.target.column.spelling,
          sourceStepIndexes: [sourceStepIndex],
        })
      }
    } catch (cause) {
      issues.push({
        code: 'compile_failure',
        message:
          cause instanceof Error
            ? `Cannot compile migration step ${sourceStepIndex}: ${cause.message}`
            : `Cannot compile migration step ${sourceStepIndex}`,
        sourceStepIndexes: [sourceStepIndex],
      })
    }
  }

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
