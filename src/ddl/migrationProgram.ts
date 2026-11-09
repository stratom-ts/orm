import type { CatalogIntrospector } from '@/dialects/catalog'
import type { CompiledQuery } from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { Executor } from '@/query'

import type {
  MigrationPlanningContext,
  MigrationSemanticProfile,
  MigrationTarget,
  PlannedMigration,
} from './migrationPlan'

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

/** Policy for lowering destructive column drops. */
export type MigrationLoweringPolicy = Readonly<{
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
    return (
      left.namespace.length === right.namespace.length &&
      left.namespace.every(
        (segment, index) =>
          segment.role === right.namespace[index].role &&
          segment.identifier.comparisonKey ===
            right.namespace[index].identifier.comparisonKey,
      )
    )

  if (
    !leftRelation ||
    !rightRelation ||
    leftRelation.namespace.length !== rightRelation.namespace.length ||
    !leftRelation.namespace.every(
      (segment, index) =>
        segment.role === rightRelation.namespace[index].role &&
        segment.identifier.comparisonKey ===
          rightRelation.namespace[index].identifier.comparisonKey,
    ) ||
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
  sourceStepIndexes: readonly number[]
  transaction: MigrationActionTransaction
  statements: readonly [CompiledQuery, ...CompiledQuery[]]
}>

/** Fully compiled, dialect-owned executable representation of a Migration Plan. */
export type MigrationProgram = Readonly<{
  atomicity: MigrationAtomicity
  preconditions: readonly MigrationPrecondition[]
  actions: readonly MigrationAction[]
}>

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

  /** Marks the physical operation session for disposal. */
  discard(): void

  /** Cancels work currently running on the physical operation session. */
  cancel(): Promise<void>

  /**
   * Read-only, repeatable preparation; PostgreSQL calls this before and inside its
   * transaction.
   */
  prepare(): Promise<MigrationProgram>

  /** Verifies desired-state convergence inside the transaction before commit. */
  validate?(): Promise<void>
}>

/** Effect acknowledged by a dialect migration runtime after successful cleanup. */
export type MigrationRuntimeSuccess = Readonly<{
  outcome: 'applied' | 'unchanged'
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
