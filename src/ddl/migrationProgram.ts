import type { CatalogIntrospector } from '@/dialects/catalog'
import type { CompiledQuery } from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { Executor } from '@/query'

import type {
  MigrationPlanningContext,
  MigrationSemanticProfile,
  PlannedMigration,
} from './migrationPlan'

/** Transaction guarantee provided by a complete lowered migration program. */
export type MigrationAtomicity = 'plan-atomic' | 'statement-atomic' | 'non-atomic'

/** Transaction context required by one physical migration action. */
export type MigrationActionTransaction = 'required' | 'allowed' | 'forbidden'

/** Semantic assertion that must hold in the authoritative execution snapshot. */
export type MigrationPrecondition = Readonly<{
  kind: 'column_has_no_nulls'
  relation: CanonicalRelationIdentity
  column: string
  sourceStepIndexes: readonly number[]
}>

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

/** Deterministic reason a complete plan cannot be lowered by a dialect. */
export type MigrationCapabilityIssue = Readonly<{
  code:
    | 'profile_mismatch'
    | 'missing_desired_table'
    | 'invalid_target'
    | 'compile_failure'
    | 'unsupported_dependency_cycle'
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

  /** Builds and lowers the plan inside the authoritative execution snapshot. */
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
   */
  lower(
    planned: PlannedMigration,
    expectedProfile: MigrationSemanticProfile,
  ): MigrationLoweringResult

  /**
   * Coordinates and executes one lowered migration program.
   *
   * @param options - Runtime session capabilities and migration preparation callback.
   */
  execute(options: MigrationRuntimeOptions): Promise<MigrationRuntimeSuccess>
}>
