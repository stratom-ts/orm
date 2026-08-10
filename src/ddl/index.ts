export {
  type ColumnDefAst,
  type ColumnReferenceAst,
  type CreateTableAst,
} from './createTable'
export { lowerDesiredSchema, registerDesiredSchema } from './desiredSchema'
export {
  createMigrateBuilder,
  MIGRATE_ADVISORY_LOCK_CLASS,
  MIGRATE_ADVISORY_LOCK_ID,
  type MigrateBuilder,
  type MigrationAllow,
} from './migrate'
export type {
  MigrationColumnReference,
  MigrationColumnTarget,
  MigrationIndexTarget,
  MigrationNamespaceTarget,
  MigrationPlan,
  MigrationRelationTarget,
  MigrationStep,
  MigrationTarget,
} from './migrationPlan'
