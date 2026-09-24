export { lowerDesiredSchema, registerDesiredSchema } from './desiredSchema'
export {
  createMigrateBuilder,
  type MigrateBuilder,
  type MigrationAllow,
  type MigrationExecuteOptions,
  type MigrationPreview,
  type MigrationPreviewAction,
  type MigrationPreviewStatement,
} from './migrate'
export type {
  MigrationColumnReference,
  MigrationColumnTarget,
  MigrationIndexTarget,
  MigrationNamespaceTarget,
  MigrationPlan,
  MigrationPlanningContext,
  MigrationRelationTarget,
  MigrationStep,
  MigrationTarget,
} from './migrationPlan'
export type { DialectMigrationAdapter } from './migrationProgram'
