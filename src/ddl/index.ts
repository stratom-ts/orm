export { lowerDesiredSchema, registerDesiredSchema } from './desiredSchema'
export {
  createMigrateBuilder,
  type MigrateBuilder,
  type MigrationAllow,
  type MigrationExecuteOptions,
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
