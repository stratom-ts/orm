export * from './client'
export * from '@/schemas'
export * from '@/types'
export {
  DriverError,
  InvariantError,
  MigrationError,
  QueryError,
  SchemaError,
  ValidationError,
  isErrorTag,
  isStratomError,
} from '@/utils/error'
export type {
  DriverErrorClassification,
  DriverErrorClassifier,
  DriverErrorKind,
  MigrationCleanupFailure,
  MigrationExecutionOutcome,
  MigrationExecutionStage,
  StratomError,
  ValidationOperation,
} from '@/utils/error'
export type {
  MigrationCapabilityCode,
  MigrationCapabilityIssue,
} from '@/ddl/migrationProgram'
export * from '@/dialects'
export { defineTable, isTableHandle } from './defineTable'
export type {
  DeleteBuilder,
  ExcludedRef,
  ExpressionBuilder,
  InsertBuilder,
  InsertConflictBuilder,
  InsertValuesBuilder,
  QueryBuilder,
  SelectBuilder,
  UpdateBuilder,
  UpdateSetBuilder,
  WriteResult,
} from '@/query'
export {
  and,
  count,
  countAll,
  dateTrunc,
  eb,
  eq,
  gt,
  gte,
  length,
  lower,
  lt,
  lte,
  max,
  min,
  neq,
  not,
  now,
  or,
  sum,
  upper,
  excluded,
} from '@/query'
export type {
  DialectMigrationAdapter,
  MigrateBuilder,
  MigrationAllow,
  MigrationColumnReference,
  MigrationColumnTarget,
  MigrationExecuteOptions,
  MigrationIndexTarget,
  MigrationNamespaceTarget,
  MigrationPlan,
  MigrationPlanningContext,
  MigrationDryRun,
  MigrationDryRunAction,
  MigrationDryRunStatement,
  MigrationRelationTarget,
  MigrationStep,
  MigrationTarget,
} from '@/ddl'
export type {
  CanonicalIdentifier,
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  NamespaceContext,
} from '@/migrations/canonicalRelationIdentity'
export {
  type OperationSession,
  type OperationSessionDisposition,
  type OperationSessionIdentity,
  type OperationSessionProvider,
} from '@/operations'
export type {
  MigrationOwnershipDeclaration,
  MigrationOwnershipRelation,
  MigrationRelationShape,
} from '@/migrations/migrationOwnership'

export type { CompiledQuery as ExecutableQuery } from '@/query/compiled'
export type { SqlTag, SqlFragment } from './sql'
