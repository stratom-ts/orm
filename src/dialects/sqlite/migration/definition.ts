import type { PlannedMigration } from '@/ddl/migrationPlan'
import type { CatalogFact, CatalogSet, CatalogTable } from '@/dialects/catalog'
import type { LoweredDesiredColumn, LoweredDesiredTable } from '@/dialects/types'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'

import { isSqliteDefaultLiteral } from '../defaults'
import { asciiFoldSqliteIdentifier } from '../identity'
import {
  assertSafeSqliteDataType,
  assertSafeSqliteDefaultExpression,
  formatSqliteLiteral,
} from '../validate'

export type Column = {
  name: string
  dataType: string
  notNull: boolean
  defaultSql?: string
  rowidAlias: boolean
  autoIncrement: boolean
}

export type ForeignKey = {
  columns: readonly string[]
  relation: CanonicalRelationIdentity
  referencedColumns: readonly string[]
  onDelete: string
  onUpdate: string
}

export type Index = { name: string; columns: readonly string[]; unique: boolean }

export type Definition = {
  columns: Column[]
  primaryKey: readonly string[]
  unique: (readonly string[])[]
  foreignKeys: ForeignKey[]
  indexes: Index[]
}

/** Requires one fully observed fact before preserving catalog state. */
export function fact<T>(value: CatalogFact<T>, label: string): T {
  if (value.state !== 'present')
    throw new Error(`Incomplete SQLite evidence: ${label} (${value.state})`)

  return value.value
}

/** Requires complete member coverage before rebuilding a table. */
export function complete<T>(value: CatalogSet<T>, label: string): readonly T[] {
  if (value.coverage.state !== 'complete')
    throw new Error(`Incomplete SQLite evidence: ${label}`)

  return value.items
}

/** Quotes a single SQLite identifier, including literal dots and quotes. */
export function quote(value: string): string {
  if (!value || value.includes('\0')) throw new Error('Invalid SQLite identifier')

  return `"${value.replaceAll('"', '""')}"`
}

/** Resolves an authoritative ordinary permanent main table definition. */
export function observedTable(
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
    throw new Error('SQLite target lacks a managed ordinary permanent table')

  fact(relation.nativeDefinition, 'table SQL')
  const table = fact(relation.table, 'table definition')

  if (complete(table.options, 'table options').some((option) => option.value !== 'false'))
    throw new Error('SQLite STRICT and WITHOUT ROWID tables are unsupported')

  if (complete(table.opaqueObjects, 'opaque dependencies').length)
    throw new Error('SQLite opaque dependencies cannot be preserved')

  return table
}

/** Converts a desired column into the supported SQLite physical definition. */
export function desiredColumn(
  column: LoweredDesiredColumn,
  primaryKey: readonly string[],
): Column {
  const name = column.identifier.spelling
  const rowidAlias =
    primaryKey.length === 1 &&
    primaryKey[0] === name &&
    column.dataType.trim().toUpperCase() === 'INTEGER'

  return {
    name,
    dataType: assertSafeSqliteDataType(column.dataType),
    notNull: column.notNull,
    rowidAlias,
    autoIncrement: column.autoIncrement,
    ...(column.databaseDefault
      ? { defaultSql: assertSafeSqliteDefaultExpression(column.databaseDefault.sql) }
      : {}),
    ...(column.defaultValue !== undefined
      ? { defaultSql: formatSqliteLiteral(column.defaultValue) }
      : {}),
  }
}

/** Produces an empty physical definition from a registered desired table. */
export function desiredDefinition(table: LoweredDesiredTable): Definition {
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
    throw new Error('Invalid SQLite constraint or index')
}

/** Preserves every observed physical member, including additive live columns. */
export function observedDefinition(table: CatalogTable): Definition {
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
function observedColumn(column: CatalogTable['columns']['items'][number]): Column {
  const generation =
    column.generation.state === 'absent'
      ? undefined
      : fact(column.generation, 'generation')

  if (generation && generation.kind !== 'rowidAlias')
    throw new Error('Unsupported SQLite generation')

  const defaultSql =
    column.default.state === 'absent' ? undefined : fact(column.default, 'default').native

  const nativeType = fact(column.dataType, 'column type').native
  return {
    name: column.name,
    dataType: nativeType ? assertSafeSqliteDataType(nativeType) : '',
    notNull: !fact(column.nullable, 'column nullability'),
    rowidAlias: generation?.kind === 'rowidAlias',
    autoIncrement: generation?.kind === 'rowidAlias' && generation.autoIncrement,
    ...(defaultSql === undefined
      ? {}
      : { defaultSql: assertSafeSqliteDefaultExpression(defaultSql) }),
  }
}

/** Compares names under SQLite's ASCII identifier folding. */
export function sameName(left: string, right: string): boolean {
  return asciiFoldSqliteIdentifier(left) === asciiFoldSqliteIdentifier(right)
}

/** Proves a constant default rather than permitting executable expressions as a backfill. */
export function literalDefault(value: string | undefined): boolean {
  return value === undefined || isSqliteDefaultLiteral(value)
}
