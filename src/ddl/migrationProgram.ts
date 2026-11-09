import type { CatalogIntrospector } from '@/dialects/catalog'
import type { CompiledQuery } from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { Executor } from '@/query'
import type { MigrationError } from '@/utils/error'

import type {
  MigrationPlanningContext,
  MigrationSemanticProfile,
  MigrationTarget,
  PlannedMigration,
} from './migrationPlan'

/** Requires a matching segment at every namespace position, including sparse slots. */
function namespacesEqual(
  left: CanonicalRelationIdentity['namespace'],
  right: CanonicalRelationIdentity['namespace'],
): boolean {
  if (left.length !== right.length) return false

  for (let index = 0; index < left.length; index++) {
    const leftSegment = left.at(index)
    const rightSegment = right.at(index)

    if (
      !leftSegment ||
      !rightSegment ||
      leftSegment.role !== rightSegment.role ||
      leftSegment.identifier.comparisonKey !== rightSegment.identifier.comparisonKey
    )
      return false
  }

  return true
}

/** Transaction guarantee provided by a complete lowered migration program. */
export type MigrationAtomicity = 'plan-atomic' | 'statement-atomic' | 'non-atomic'

/** Transaction context required by one physical migration action. */
export type MigrationActionTransaction = 'required' | 'allowed' | 'forbidden'

/** Semantic assertion that must hold in the authoritative execution snapshot. */
export type MigrationPrecondition =
  | Readonly<{
      kind: 'column_rename'
      target: Extract<MigrationTarget, { kind: 'column' }>
      from: string
      sourceStepIndexes: readonly number[]
    }>
  | Readonly<{
      kind: 'column_has_no_nulls'
      relation: CanonicalRelationIdentity
      column: string
      sourceStepIndexes: readonly number[]
    }>
  | Readonly<{
      kind: 'column_has_only_nulls'
      target: Extract<MigrationTarget, { kind: 'column' }>
      sourceStepIndexes: readonly number[]
    }>

/** Run-level physical policy, separate from semantic schema intent. */
export type MigrationLoweringPolicy = Readonly<{
  concurrentIndexes?: boolean
  columnDrop: 'guarded' | 'dangerous'
  dangerousColumnDropTargets?: readonly Extract<MigrationTarget, { kind: 'column' }>[]
}>

/** Compares canonical targets without using their authored display spellings. */
export function migrationTargetsEqual(
  left: MigrationTarget,
  right: MigrationTarget,
): boolean {
  if (left.kind !== right.kind) return false

  const leftRelation = left.kind === 'namespace' ? undefined : left.relation
  const rightRelation = right.kind === 'namespace' ? undefined : right.relation

  if (left.kind === 'namespace' && right.kind === 'namespace')
    return namespacesEqual(left.namespace, right.namespace)

  if (
    !leftRelation ||
    !rightRelation ||
    !namespacesEqual(leftRelation.namespace, rightRelation.namespace) ||
    leftRelation.relation.comparisonKey !== rightRelation.relation.comparisonKey
  )
    return false

  if (left.kind === 'column' && right.kind === 'column')
    return left.column.comparisonKey === right.column.comparisonKey

  if (left.kind === 'index' && right.kind === 'index')
    return left.index.comparisonKey === right.index.comparisonKey

  return left.kind === 'relation' && right.kind === 'relation'
}

/** Checks whether one canonical column target has an explicit dangerous grant. */
export function isDangerousColumnDrop(
  policy: MigrationLoweringPolicy,
  target: Extract<MigrationTarget, { kind: 'column' }>,
): boolean {
  if (policy.columnDrop === 'dangerous') return true

  return (
    policy.dangerousColumnDropTargets?.some((candidate) =>
      migrationTargetsEqual(candidate, target),
    ) ?? false
  )
}

/** One executable physical action with canonical semantic provenance. */
export type MigrationAction = Readonly<{
  target?: MigrationTarget
  repair?: 'drop' | 'create'
  sourceStepIndexes: readonly number[]
  transaction: MigrationActionTransaction
  statements: readonly [CompiledQuery, ...CompiledQuery[]]
}>

/** Fully compiled, dialect-owned executable representation of a Migration Plan. */
export type MigrationPhase = Readonly<{
  transaction: 'required' | 'forbidden'
  actionIndexes: readonly number[]
}>

export type MigrationProgram = Readonly<{
  phases?: readonly MigrationPhase[]
  atomicity: MigrationAtomicity
  preconditions: readonly MigrationPrecondition[]
  actions: readonly MigrationAction[]
}>

/** Groups adjacent transactional actions without moving actions across dependencies. */
export function migrationProgramPhases(
  actions: readonly MigrationAction[],
): MigrationPhase[] {
  const phases: { transaction: 'required' | 'forbidden'; actionIndexes: number[] }[] = []
  for (const [index, action] of actions.entries()) {
    const transaction = action.transaction === 'forbidden' ? 'forbidden' : 'required'
    const previous = phases.at(-1)

    if (transaction === 'required' && previous?.transaction === 'required')
      previous.actionIndexes.push(index)
    else phases.push({ transaction, actionIndexes: [index] })
  }

  return phases
}

/** Known reason a complete plan cannot be lowered by a dialect. */
export type MigrationCapabilityCode =
  | 'profile_mismatch'
  | 'missing_desired_table'
  | 'invalid_target'
  | 'compile_failure'
  | 'unsupported_dependency_cycle'

/** Deterministic reason a complete plan cannot be lowered by a dialect. */
export type MigrationCapabilityIssue = Readonly<{
  code: MigrationCapabilityCode
  message: string
  sourceStepIndexes: readonly number[]
}>

/** All-or-nothing result of pure whole-plan lowering. */
export type MigrationLoweringResult =
  | Readonly<{ program: MigrationProgram; issues?: never }>
  | Readonly<{ issues: readonly MigrationCapabilityIssue[]; program?: never }>

/** Inputs owned by a dialect runtime for one coordinated migration execution. */
export type MigrationRuntimeOptions = Readonly<{
  executor: Executor
  databaseIdentity: string
  applicationId?: string
  signal?: AbortSignal
  /** Optional coordination deadline; the selected member owns its physical default. */
  lockTimeoutMs?: number
  statementTimeoutMs?: number
  allowPartialApplication?: boolean

  /** Marks the physical operation session for disposal. */
  discard(): void

  /** Cancels work currently running on the physical operation session. */
  cancel(): Promise<void>

  /**
   * Read-only, repeatable preparation; PostgreSQL calls this before writes and at
   * physical phase boundaries, including authoritative transactional snapshots.
   */
  prepare(): Promise<MigrationProgram>

  /** Verifies final convergence, before atomic commit or after mixed committed phases. */
  validate?(): Promise<void>
}>

/** Effect acknowledged by a dialect migration runtime after successful cleanup. */
export type MigrationRuntimeSuccess = Readonly<{
  outcome: 'applied' | 'unchanged'
  completedActions?: MigrationError['completedActions']
}>

/**
 * Cohesive migration member selected with the connector. Generic orchestration reaches
 * database semantics only through this interface.
 */
export type DialectMigrationAdapter = Readonly<{
  /** Pure planning policies bound by this selected dialect member. */
  planning: MigrationPlanningContext

  /** Catalog observation used by both planning and authoritative execution. */
  catalog: CatalogIntrospector

  /**
   * Lowers a complete semantic plan into an executable dialect program.
   *
   * @param planned - Planned migration and its canonical registrations.
   * @param expectedProfile - Semantic profile resolved by the executing session.
   * @param policy - Lowering policy; defaults to guarded column drops.
   */
  lower(
    planned: PlannedMigration,
    expectedProfile: MigrationSemanticProfile,
    policy?: MigrationLoweringPolicy,
  ): MigrationLoweringResult

  /**
   * Coordinates and executes one lowered migration program.
   *
   * @param options - Runtime session capabilities and migration preparation callback.
   *
   * @throws {MigrationError} When execution fails, with stage, outcome, cleanup
   *   evidence, and a defect marker for unexpected runtime failures.
   * @throws {SchemaError} If the preparation callback rejects registered schema input.
   * @throws {Error} Unrecognized callback defects retain their original identity.
   */
  execute(options: MigrationRuntimeOptions): Promise<MigrationRuntimeSuccess>
}>
