import type { CompiledQuery } from '@/dialects/types'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
} from '@/migrations/canonicalRelationIdentity'

import { asciiFoldSqliteIdentifier } from '../identity'
import {
  SqliteReservedObjectNameError,
  sqliteNaming,
  validateSqliteObjectName,
} from '../naming'

import type {
  SqliteColumnDefinition,
  SqliteForeignKeyDefinition,
  SqliteIndexDefinition,
  SqliteTableDefinition,
} from './definition'
import { SqliteMigrationCapabilityError, capabilityError } from './error'

/** Quotes a single SQLite identifier, including literal dots and quotes. */
function quoteSqliteIdentifier(value: string): string {
  if (!value || value.includes('\0')) throw capabilityError('Invalid SQLite identifier')

  return `"${value.replaceAll('"', '""')}"`
}

/** Verifies a structured identifier rather than accepting a forged comparison key. */
function assertIdentifier(identifier: CanonicalIdentifier): void {
  if (!hasValidIdentifierSpelling(identifier.spelling))
    throw new SqliteMigrationCapabilityError(
      'invalid_target',
      'SQLite migration target contains an invalid identifier',
    )

  sqliteNaming.validate(identifier.spelling, 'SQLite migration identifier')

  if (asciiFoldSqliteIdentifier(identifier.spelling) !== identifier.comparisonKey)
    throw new SqliteMigrationCapabilityError(
      'invalid_target',
      'Invalid SQLite canonical identifier',
    )
}

/** Recognizes authored-name failures rejected by physical name validation. */
function hasValidIdentifierSpelling(value: string): boolean {
  if (!value || value.includes('\0')) return false

  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index)

    if (unit < 0xd800 || unit > 0xdfff) continue

    const next = value.charCodeAt(index + 1)

    if (unit > 0xdbff || !(next >= 0xdc00 && next <= 0xdfff)) return false

    index++
  }

  return true
}

/** Rejects targets outside the supported main profile before SQL compilation. */
function assertMain(identity: CanonicalRelationIdentity): void {
  const segment = identity.namespace[0]

  if (
    identity.namespace.length !== 1 ||
    segment.role !== 'database' ||
    segment.identifier.comparisonKey !== 'main'
  )
    throw new SqliteMigrationCapabilityError(
      'invalid_target',
      'SQLite migration targets must use database:main',
    )

  assertIdentifier(segment.identifier)
  assertIdentifier(identity.relation)
}

/** Compiles a statement with its explicit ordered parameter bindings. */
function statement(sql: string, params: unknown[] = []): CompiledQuery {
  return { sql, params }
}

/** Formats a validated ordinary main-database table address. */
function address(name: string): string {
  return `"main".${quoteSqliteIdentifier(name)}`
}

/** Compiles one supported SQLite column, with exact rowid-alias behavior. */
function compileColumnDefinition(column: SqliteColumnDefinition): string {
  const primary = column.rowidAlias
    ? ` primary key${column.autoIncrement ? ' autoincrement' : ''}`
    : ''

  return `${quoteSqliteIdentifier(column.name)}${column.dataType ? ` ${column.dataType}` : ''}${primary}${column.notNull ? ' not null' : ''}${column.defaultSql === undefined ? '' : ` default ${column.defaultSql}`}`
}

/** Formats ordered columns for a key, index or explicit projection. */
function columnsSql(columns: readonly string[]): string {
  if (!columns.length) throw capabilityError('SQLite key/index columns cannot be empty')

  return columns.map(quoteSqliteIdentifier).join(', ')
}

/** Validates referential actions before putting them in DDL. */
function actionSql(action: string): string {
  if (!['cascade', 'restrict', 'no action', 'set null', 'set default'].includes(action))
    throw capabilityError('Unsupported SQLite referential action')

  return action
}

/** Compiles a same-database foreign key using SQLite's unqualified REFERENCES syntax. */
function foreignKeySql(key: SqliteForeignKeyDefinition): string {
  assertMain(key.relation)

  if (key.columns.length !== key.referencedColumns.length)
    throw capabilityError('SQLite FK arity mismatch')

  return `foreign key (${columnsSql(key.columns)}) references ${quoteSqliteIdentifier(key.relation.relation.spelling)} (${columnsSql(key.referencedColumns)}) on delete ${actionSql(key.onDelete)} on update ${actionSql(key.onUpdate)}`
}

/** Compiles every final column and retained simple constraint into one CREATE TABLE. */
function compileCreateTable(
  name: string,
  definition: SqliteTableDefinition,
): CompiledQuery {
  try {
    validateSqliteObjectName(name, 'table')
  } catch (cause) {
    if (!(cause instanceof SqliteReservedObjectNameError)) throw cause

    throw capabilityError(cause.message)
  }

  if (!definition.columns.length)
    throw capabilityError('SQLite table must retain at least one column')

  const clauses = definition.columns.map(compileColumnDefinition)

  if (
    definition.primaryKey.length &&
    !definition.columns.some((column) => column.rowidAlias)
  )
    clauses.push(`primary key (${columnsSql(definition.primaryKey)})`)

  clauses.push(...definition.unique.map((key) => `unique (${columnsSql(key)})`))
  clauses.push(...definition.foreignKeys.map(foreignKeySql))
  return statement(`create table ${address(name)} (${clauses.join(', ')})`)
}

/** Compiles a simple main-database index without relying on IF NOT EXISTS. */
function compileCreateIndex(table: string, index: SqliteIndexDefinition): CompiledQuery {
  try {
    validateSqliteObjectName(index.name, 'index')
  } catch (cause) {
    if (!(cause instanceof SqliteReservedObjectNameError)) throw cause

    throw capabilityError(cause.message)
  }

  return statement(
    `create ${index.unique ? 'unique ' : ''}index ${address(index.name)} on ${quoteSqliteIdentifier(table)} (${columnsSql(index.columns)})`,
  )
}

export {
  quoteSqliteIdentifier,
  assertIdentifier,
  assertMain,
  statement,
  address,
  compileColumnDefinition,
  columnsSql,
  compileCreateTable,
  compileCreateIndex,
}
