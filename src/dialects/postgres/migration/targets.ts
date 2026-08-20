import type {
  MigrationColumnReference,
  MigrationStep,
  PlannedMigration,
} from '@/ddl/migrationPlan'
import type { CreateSchemaAst, CreateTableAst, SqlAst } from '@/dialects/types'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
} from '@/migrations/canonicalRelationIdentity'
import {
  generatedForeignKeyName,
  generatedPrimaryKeyName,
  generatedUniqueName,
  physicalNamingProfile,
  validatePhysicalName,
} from '@/migrations/physicalNaming'
import { MigrationError } from '@/utils/error'

type PostgresRelationFields = {
  schema: string
  table: string
}

type PostgresReferenceFields = PostgresRelationFields & {
  column: string
  onDelete?: string
  onUpdate?: string
}

const POSTGRES_NAMING_PROFILE = physicalNamingProfile('postgresql')

/**
 * Reads the schema spelling a PostgreSQL statement must name.
 *
 * @example
 *   const schema = schemaFromNamespace(relation.namespace)
 *
 * @param namespace - Canonical namespace containing a schema segment.
 */
export function schemaFromNamespace(
  namespace: CanonicalRelationIdentity['namespace'],
): string {
  const schema = namespace.find((segment) => segment.role === 'schema')

  if (!schema) {
    throw new MigrationError({
      message: 'PostgreSQL migration target has no schema namespace',
    })
  }

  return schema.identifier.spelling
}

/**
 * Projects a canonical relation identity into PostgreSQL AST relation fields.
 *
 * @param identity - Canonical relation identity to project.
 */
function relationFields(identity: CanonicalRelationIdentity): PostgresRelationFields {
  return {
    schema: schemaFromNamespace(identity.namespace),
    table: identity.relation.spelling,
  }
}

/**
 * Projects a structured foreign-key reference into PostgreSQL AST fields.
 *
 * @param reference - Structured foreign-key reference to project.
 */
function referenceFields(reference: MigrationColumnReference): PostgresReferenceFields {
  return {
    ...relationFields(reference.relation),
    column: reference.column.spelling,
    ...(reference.onDelete === undefined ? {} : { onDelete: reference.onDelete }),
    ...(reference.onUpdate === undefined ? {} : { onUpdate: reference.onUpdate }),
  }
}

/**
 * Converts one semantic step into its PostgreSQL statement AST.
 *
 * @example
 *   const ast = stepToAst(step, planned)
 *
 * @param step - Semantic migration step to convert.
 * @param planned - Planned migration supplying desired table ASTs.
 */
export function stepToAst(
  step: MigrationStep,
  planned: PlannedMigration,
): SqlAst | undefined {
  const profile = POSTGRES_NAMING_PROFILE

  switch (step.kind) {
    case 'ensure_namespace': {
      const ast: CreateSchemaAst = {
        kind: 'create_schema',
        schema: schemaFromNamespace(step.target.namespace),
      }
      return ast
    }
    case 'create_table': {
      const identity = step.target.relation
      const ast = planned.desiredTables.get(identity)
      if (!ast) return undefined
      const projected: CreateTableAst = {
        ...ast,
        ...relationFields(identity),
        primaryKeyName: generatedPrimaryKeyName(identity, ast.primaryKey, profile),
        columns: ast.columns.map((column) => ({
          ...column,
          references: undefined,
          ...(column.unique
            ? {
                uniqueConstraintName: generatedUniqueName(identity, column.name, profile),
              }
            : {}),
        })),
      }
      return projected
    }
    case 'add_column': {
      const identity = step.target.relation
      const column = step.target.column.spelling
      return {
        kind: 'add_column',
        ...relationFields(identity),
        column: {
          name: column,
          dataType: step.dataType,
          notNull: step.notNull,
          unique: step.unique ?? false,
          ...(step.unique
            ? {
                uniqueConstraintName: generatedUniqueName(identity, column, profile),
              }
            : {}),
          autoIncrement: step.autoIncrement ?? false,
          ...(step.defaultValue !== undefined ? { defaultValue: step.defaultValue } : {}),
          ...(step.databaseDefault !== undefined
            ? { databaseDefault: step.databaseDefault }
            : {}),
          ...(step.generated ? { generated: step.generated } : {}),
        },
      }
    }
    case 'alter_column_type':
      return {
        kind: 'alter_column_type',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        dataType: step.dataType,
      }
    case 'add_unique_constraint':
      return {
        kind: 'add_unique_constraint',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        name: generatedUniqueName(
          step.target.relation,
          step.target.column.spelling,
          profile,
        ),
      }
    case 'add_foreign_key':
      return {
        kind: 'add_foreign_key',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
        name: generatedForeignKeyName(
          step.target.relation,
          step.target.column.spelling,
          step.references.relation,
          step.references.column.spelling,
          step.references.onDelete,
          step.references.onUpdate,
          profile,
        ),
        references: referenceFields(step.references),
      }
    case 'set_not_null':
      return {
        kind: 'set_not_null',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'drop_not_null':
      return {
        kind: 'drop_not_null',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'create_index':
      return {
        kind: 'create_index',
        ...relationFields(step.target.relation),
        name: step.target.index.spelling,
        columns: step.columns.map((column) => column.spelling),
        unique: step.unique,
      }
    case 'drop_column':
      return {
        kind: 'drop_column',
        ...relationFields(step.target.relation),
        column: step.target.column.spelling,
      }
    case 'drop_table':
      return { kind: 'drop_table', ...relationFields(step.target.relation) }
    case 'drop_index':
      return {
        kind: 'drop_index',
        ...relationFields(step.target.relation),
        index: step.target.index.spelling,
      }
  }
}

/**
 * Validates one canonical PostgreSQL identifier and its physical spelling.
 *
 * @param identifier - Canonical identifier to validate.
 * @param label - Target description used in issue messages.
 */
function identifierIssues(identifier: CanonicalIdentifier, label: string): string[] {
  const issues: string[] = []

  if (identifier.comparisonKey !== identifier.spelling) {
    issues.push(`${label} is not canonical under PostgreSQL identifier rules`)
  }

  try {
    validatePhysicalName(identifier.spelling, label, POSTGRES_NAMING_PROFILE)
  } catch (cause) {
    issues.push(cause instanceof Error ? cause.message : `${label} is not addressable`)
  }

  return issues
}

/**
 * Validates the exact database and schema shape PostgreSQL target projection requires.
 *
 * @param namespace - Canonical namespace to validate.
 * @param expectedDatabase - Database identity resolved for the executing session.
 * @param label - Target description used in issue messages.
 */
function namespaceIssues(
  namespace: CanonicalRelationIdentity['namespace'],
  expectedDatabase: CanonicalIdentifier | undefined,
  label: string,
): string[] {
  const issues: string[] = []

  if (namespace.length !== 2) {
    issues.push(`${label} must contain exactly database and schema segments`)
  }

  const database = namespace[0]
  const schema = namespace[1]

  if (database?.role !== 'database') {
    issues.push(`${label} segment 0 must have role 'database'`)
  }

  if (schema?.role !== 'schema') {
    issues.push(`${label} segment 1 must have role 'schema'`)
  }

  for (const [index, segment] of namespace.entries()) {
    issues.push(...identifierIssues(segment.identifier, `${label} segment ${index}`))
  }

  if (!expectedDatabase) {
    issues.push('Executing PostgreSQL profile has no canonical database segment')
  } else if (
    database?.role === 'database' &&
    database.identifier.comparisonKey !== expectedDatabase.comparisonKey
  ) {
    issues.push(
      `${label} database ${JSON.stringify(database.identifier.spelling)} does not match executing database ${JSON.stringify(expectedDatabase.spelling)}`,
    )
  }

  return issues
}

/**
 * Collects deterministic PostgreSQL target and reference issues for one step.
 *
 * @example
 *   const issues = stepTargetIssues(step, expectedDatabase)
 *
 * @param step - Semantic migration step to validate.
 * @param expectedDatabase - Database identity resolved for the executing session.
 */
export function stepTargetIssues(
  step: MigrationStep,
  expectedDatabase: CanonicalIdentifier | undefined,
): string[] {
  const issues: string[] = []
  const namespace =
    step.target.kind === 'namespace'
      ? step.target.namespace
      : step.target.relation.namespace
  issues.push(
    ...namespaceIssues(namespace, expectedDatabase, 'Migration target namespace'),
  )

  if (step.target.kind !== 'namespace') {
    issues.push(...identifierIssues(step.target.relation.relation, 'Migration relation'))
  }

  if (step.target.kind === 'column') {
    issues.push(...identifierIssues(step.target.column, 'Migration column'))
  } else if (step.target.kind === 'index') {
    issues.push(...identifierIssues(step.target.index, 'Migration index'))
  }

  if (step.kind === 'add_foreign_key') {
    issues.push(
      ...namespaceIssues(
        step.references.relation.namespace,
        expectedDatabase,
        'Foreign-key reference namespace',
      ),
      ...identifierIssues(step.references.relation.relation, 'Referenced relation'),
      ...identifierIssues(step.references.column, 'Referenced column'),
    )
  }

  if (step.kind === 'create_index') {
    for (const column of step.columns) {
      issues.push(...identifierIssues(column, 'Indexed column'))
    }
  }

  return issues
}
