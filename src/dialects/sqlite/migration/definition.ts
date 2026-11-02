import type { PlannedMigration } from '@/ddl/migrationPlan'
import type { CatalogFact, CatalogSet, CatalogTable } from '@/dialects/catalog'
import type { LoweredDesiredColumn, LoweredDesiredTable } from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'

import { isSqliteDefaultLiteral } from '../defaultExpression'
import { asciiFoldSqliteIdentifier } from '../identity'
import { assertSafeSqliteDataType, assertSafeSqliteDefaultExpression } from '../validate'

import { capabilityCheck, capabilityError } from './error'

type SqliteColumnDefinition = {
  name: string
  dataType: string
  notNull: boolean
  defaultSql?: string
  rowidAlias: boolean
  autoIncrement: boolean
}

type SqliteForeignKeyDefinition = {
  columns: readonly string[]
  relation: CanonicalRelationIdentity
  referencedColumns: readonly string[]
  onDelete: string
  onUpdate: string
}

type SqliteIndexDefinition = { name: string; columns: readonly string[]; unique: boolean }

type SqliteTableDefinition = {
  columns: SqliteColumnDefinition[]
  primaryKey: readonly string[]
  unique: (readonly string[])[]
  foreignKeys: SqliteForeignKeyDefinition[]
  indexes: SqliteIndexDefinition[]
}

/** Requires one fully observed fact before preserving catalog state. */
function fact<T>(value: CatalogFact<T>, label: string): T {
  if (value.state !== 'present')
    throw capabilityError(`Incomplete SQLite evidence: ${label} (${value.state})`)

  return value.value
}

/** Requires complete member coverage before rebuilding a table. */
function complete<T>(value: CatalogSet<T>, label: string): readonly T[] {
  if (value.coverage.state !== 'complete')
    throw capabilityError(`Incomplete SQLite evidence: ${label}`)

  return value.items
}

/** Resolves an authoritative ordinary permanent main table definition. */
function observedTable(
  planned: PlannedMigration,
  identity: CanonicalRelationIdentity,
): CatalogTable {
  const relations = planned.catalogSnapshot.namespaces.items.flatMap(
    (namespace) => namespace.relations.items,
  )

  const relation = relations.find((candidate) =>
    planned.identities.equals(candidate.identity, identity),
  )

  if (
    relation?.management !== 'managed' ||
    relation.kind !== 'table' ||
    relation.persistence !== 'permanent'
  )
    throw capabilityError('SQLite target lacks a managed ordinary permanent table')

  fact(relation.nativeDefinition, 'table SQL')
  const table = fact(relation.table, 'table definition')

  if (complete(table.options, 'table options').some((option) => option.value !== 'false'))
    throw capabilityError('SQLite STRICT and WITHOUT ROWID tables are unsupported')

  if (complete(table.opaqueObjects, 'opaque dependencies').length)
    throw capabilityError('SQLite opaque dependencies cannot be preserved')

  return table
}

/** Converts a desired column into the supported SQLite physical definition. */
function desiredColumn(
  column: LoweredDesiredColumn,
  primaryKey: readonly string[],
): SqliteColumnDefinition {
  const name = column.identifier.spelling
  const rowidAlias =
    primaryKey.length === 1 &&
    primaryKey[0] === name &&
    column.dataType.trim().toUpperCase() === 'INTEGER'

  return {
    name,
    dataType: capabilityCheck(() => assertSafeSqliteDataType(column.dataType)),
    notNull: column.notNull,
    rowidAlias,
    autoIncrement: column.autoIncrement,
    ...(column.databaseDefault
      ? {
          defaultSql: capabilityCheck(() =>
            assertSafeSqliteDefaultExpression(column.databaseDefault!.sql),
          ),
        }
      : {}),
  }
}

/** Produces an empty physical definition from a registered desired table. */
function desiredDefinition(table: LoweredDesiredTable): SqliteTableDefinition {
  const primaryKey = table.primaryKey.map((column) => column.spelling)
  return {
    columns: table.columns.map((column) => desiredColumn(column, primaryKey)),
    primaryKey,
    unique: table.columns
      .filter((column) => column.unique)
      .map((column) => [column.identifier.spelling]),
    foreignKeys: table.columns
      .filter((column) => column.reference)
      .map((column) => ({
        columns: [column.identifier.spelling],
        relation: column.reference!.relation,
        referencedColumns: [column.reference!.column.spelling],
        onDelete: column.reference!.onDelete ?? 'no action',
        onUpdate: column.reference!.onUpdate ?? 'no action',
      })),
    indexes: [],
  }
}

/** Rejects key or index semantics that cannot be recreated exactly. */
function assertSimple(value: {
  semantics: CatalogFact<unknown>
  validity: CatalogFact<string>
}): void {
  fact(value.semantics, 'constraint/index semantics')

  if (fact(value.validity, 'constraint/index validity') !== 'valid')
    throw capabilityError('Invalid SQLite constraint or index')
}

/** Preserves every observed physical member, including additive live columns. */
function observedDefinition(table: CatalogTable): SqliteTableDefinition {
  const primaryKey =
    table.primaryKey.state === 'absent'
      ? []
      : [...fact(table.primaryKey, 'primary key').columns]

  if (table.primaryKey.state === 'present') assertSimple(table.primaryKey.value)

  const unique = complete(table.uniqueConstraints, 'unique constraints').map(
    (constraint) => {
      assertSimple(constraint)
      return constraint.columns
    },
  )

  const foreignKeys = complete(table.foreignKeys, 'foreign keys').map((key) => {
    assertSimple(key)
    return {
      columns: key.columns,
      relation: key.referencedRelation,
      referencedColumns: key.referencedColumns,
      onDelete: key.onDelete,
      onUpdate: key.onUpdate,
    }
  })

  const indexes = complete(table.indexes, 'indexes').map((index) => {
    assertSimple(index)
    return {
      name: fact(index.name, 'index name'),
      columns: index.columns,
      unique: index.unique,
    }
  })

  return {
    columns: complete(table.columns, 'columns').map(observedColumn),
    primaryKey,
    unique,
    foreignKeys,
    indexes,
  }
}

/** Reads native column storage, defaults and rowid generation without lossy projection. */
function observedColumn(
  column: CatalogTable['columns']['items'][number],
): SqliteColumnDefinition {
  const generation =
    column.generation.state === 'absent'
      ? undefined
      : fact(column.generation, 'generation')

  if (generation && generation.kind !== 'rowidAlias')
    throw capabilityError('Unsupported SQLite generation')

  const defaultSql =
    column.default.state === 'absent' ? undefined : fact(column.default, 'default').native

  const nativeType = fact(column.dataType, 'column type').native
  return {
    name: column.name,
    dataType: nativeType
      ? capabilityCheck(() => assertSafeSqliteDataType(nativeType))
      : '',
    notNull: !fact(column.nullable, 'column nullability'),
    rowidAlias: generation?.kind === 'rowidAlias',
    autoIncrement: generation?.kind === 'rowidAlias' && generation.autoIncrement,
    ...(defaultSql === undefined
      ? {}
      : {
          defaultSql: capabilityCheck(() =>
            assertSafeSqliteDefaultExpression(defaultSql),
          ),
        }),
  }
}

/** Compares names under SQLite's ASCII identifier folding. */
function sameName(left: string, right: string): boolean {
  return asciiFoldSqliteIdentifier(left) === asciiFoldSqliteIdentifier(right)
}

/** Proves a constant default rather than permitting executable expressions as a backfill. */
function literalDefault(value: string | undefined): boolean {
  return value === undefined || isSqliteDefaultLiteral(value)
}

export type {
  SqliteColumnDefinition,
  SqliteForeignKeyDefinition,
  SqliteIndexDefinition,
  SqliteTableDefinition,
}

export {
  fact,
  complete,
  observedTable,
  desiredColumn,
  desiredDefinition,
  observedDefinition,
  sameName,
  literalDefault,
}
