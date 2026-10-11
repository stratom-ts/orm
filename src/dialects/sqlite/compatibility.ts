import { sqliteCatalog as sqliteCatalogImplementation } from './catalog'
import {
  compileSqlite as compileSqliteImplementation,
  createSqliteQueryRelationResolver as createSqliteQueryRelationResolverImplementation,
  resolveSqliteQueryRelation as resolveSqliteQueryRelationImplementation,
} from './compile'
import {
  SQLITE_IDENTITY_POLICY as SQLITE_IDENTITY_POLICY_IMPLEMENTATION,
  asciiFoldSqliteIdentifier as asciiFoldSqliteIdentifierImplementation,
  sqliteIdentity as sqliteIdentityImplementation,
} from './identity'
import { inferSqliteColumnType as inferSqliteColumnTypeImplementation } from './infer'
import { lowerSqliteDesiredSchema as lowerSqliteDesiredSchemaImplementation } from './lowerDesiredSchema'
import {
  mapSqliteParamValue as mapSqliteParamValueImplementation,
  mapSqliteResultValue as mapSqliteResultValueImplementation,
} from './mapping'
import {
  executeSqliteMigration as executeSqliteMigrationImplementation,
  lowerSqliteMigrationPlan as lowerSqliteMigrationPlanImplementation,
} from './migration'
import {
  SQLITE_PHYSICAL_NAMING as SQLITE_PHYSICAL_NAMING_IMPLEMENTATION,
  sqliteNaming as sqliteNamingImplementation,
} from './naming'
import {
  normalizeSqliteDataType as normalizeSqliteDataTypeImplementation,
  normalizeSqliteDefaultExpression as normalizeSqliteDefaultExpressionImplementation,
} from './normalize'
import {
  compileSqliteOperationCommand as compileSqliteOperationCommandImplementation,
  sqliteOperations as sqliteOperationsImplementation,
} from './operations'
import { sqliteQuery as sqliteQueryImplementation } from './query'
import { resolveSqliteQuery as resolveSqliteQueryImplementation } from './queryAddressing'
import { sqliteSchema as sqliteSchemaImplementation } from './schema'
import {
  assertSafeSqliteDataType as assertSafeSqliteDataTypeImplementation,
  formatSqliteDefaultExpression as formatSqliteDefaultExpressionImplementation,
  formatSqliteLiteral as formatSqliteLiteralImplementation,
  normalizeSqliteDefaultValue as normalizeSqliteDefaultValueImplementation,
} from './validate'

/** @deprecated Prefer `sqliteDialect.identity`; this export is removed in 1.0. */
export const SQLITE_IDENTITY_POLICY = SQLITE_IDENTITY_POLICY_IMPLEMENTATION

/** @deprecated Prefer `sqliteDialect.identity`; this export is removed in 1.0. */
export const asciiFoldSqliteIdentifier = asciiFoldSqliteIdentifierImplementation

/** @deprecated Prefer `sqliteDialect.identity`; this export is removed in 1.0. */
export const sqliteIdentity = sqliteIdentityImplementation

/** @deprecated This package-root implementation export is removed in 1.0. */
export const inferSqliteColumnType = inferSqliteColumnTypeImplementation

/** @deprecated Prefer `sqliteDialect.catalog`; this export is removed in 1.0. */
export const sqliteCatalog = sqliteCatalogImplementation

/** @deprecated This package-root implementation export is removed in 1.0. */
export const lowerSqliteDesiredSchema = lowerSqliteDesiredSchemaImplementation

/** @deprecated Prefer `sqliteDialect.query`; this export is removed in 1.0. */
export const mapSqliteParamValue = mapSqliteParamValueImplementation

/** @deprecated Prefer `sqliteDialect.query`; this export is removed in 1.0. */
export const mapSqliteResultValue = mapSqliteResultValueImplementation

/** @deprecated Prefer `sqliteDialect.naming`; this export is removed in 1.0. */
export const SQLITE_PHYSICAL_NAMING = SQLITE_PHYSICAL_NAMING_IMPLEMENTATION

/** @deprecated Prefer `sqliteDialect.naming`; this export is removed in 1.0. */
export const sqliteNaming = sqliteNamingImplementation

/** @deprecated Prefer `sqliteDialect.schema`; this export is removed in 1.0. */
export const normalizeSqliteDataType = normalizeSqliteDataTypeImplementation

/** @deprecated Prefer `sqliteDialect.schema`; this export is removed in 1.0. */
export const normalizeSqliteDefaultExpression =
  normalizeSqliteDefaultExpressionImplementation

/** @deprecated Prefer `sqliteDialect.query`; this export is removed in 1.0. */
export const resolveSqliteQuery = resolveSqliteQueryImplementation

/** @deprecated Prefer `sqliteDialect.operations`; this export is removed in 1.0. */
export const compileSqliteOperationCommand = compileSqliteOperationCommandImplementation

/** @deprecated Prefer `sqliteDialect.operations`; this export is removed in 1.0. */
export const sqliteOperations = sqliteOperationsImplementation

/** @deprecated Prefer `sqliteDialect.migration`; this export is removed in 1.0. */
export const executeSqliteMigration = executeSqliteMigrationImplementation

/** @deprecated Prefer `sqliteDialect.migration`; this export is removed in 1.0. */
export const lowerSqliteMigrationPlan = lowerSqliteMigrationPlanImplementation

/** @deprecated This package-root implementation export is removed in 1.0. */
export const assertSafeSqliteDataType = assertSafeSqliteDataTypeImplementation

/** @deprecated This package-root implementation export is removed in 1.0. */
export const formatSqliteDefaultExpression = formatSqliteDefaultExpressionImplementation

/** @deprecated This package-root implementation export is removed in 1.0. */
export const formatSqliteLiteral = formatSqliteLiteralImplementation

/** @deprecated Prefer `sqliteDialect.schema`; this export is removed in 1.0. */
export const normalizeSqliteDefaultValue = normalizeSqliteDefaultValueImplementation

/** @deprecated This package-root implementation export is removed in 1.0. */
export const compileSqlite = compileSqliteImplementation

/** @deprecated This package-root implementation export is removed in 1.0. */
export const createSqliteQueryRelationResolver =
  createSqliteQueryRelationResolverImplementation

/** @deprecated This package-root implementation export is removed in 1.0. */
export const resolveSqliteQueryRelation = resolveSqliteQueryRelationImplementation

/** @deprecated Prefer `sqliteDialect.schema`; this export is removed in 1.0. */
export const sqliteSchema = sqliteSchemaImplementation

/** @deprecated Prefer `sqliteDialect.query`; this export is removed in 1.0. */
export const sqliteQuery = sqliteQueryImplementation
