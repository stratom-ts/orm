import type { CompiledQuery } from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { Executor } from '@/query'

import type { MigrationSemanticProfile, PlannedMigration } from './migrationPlan'

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
  lockTimeoutMs: number
  discard(): void
  cancel(): Promise<void>
  prepare(): Promise<MigrationProgram>
}>

/** Effect acknowledged by a dialect migration runtime after successful cleanup. */
export type MigrationRuntimeSuccess = Readonly<{
  outcome: 'applied' | 'unchanged'
}>

/** Migration-only dialect facet; ordinary query compilation remains single-query. */
export type DialectMigrationAdapter = Readonly<{
  lower(
    planned: PlannedMigration,
    expectedProfile: MigrationSemanticProfile,
  ): MigrationLoweringResult
  execute(options: MigrationRuntimeOptions): Promise<MigrationRuntimeSuccess>
}>
