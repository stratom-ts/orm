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

import type { Column, Definition, ForeignKey, Index } from './definition'
import { quote } from './definition'
import { SqliteMigrationCapabilityError, capabilityError } from './error'

/** Verifies a structured identifier rather than accepting a forged comparison key. */
export function assertIdentifier(identifier: CanonicalIdentifier): void {
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
export function assertMain(identity: CanonicalRelationIdentity): void {
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
export function statement(sql: string, params: unknown[] = []): CompiledQuery {
  return { sql, params }
}

/** Formats a validated ordinary main-database table address. */
export function address(name: string): string {
  return `"main".${quote(name)}`
}

/** Compiles one supported SQLite column, with exact rowid-alias behavior. */
export function columnSql(column: Column): string {
  const primary = column.rowidAlias
    ? ` primary key${column.autoIncrement ? ' autoincrement' : ''}`
    : ''

  return `${quote(column.name)}${column.dataType ? ` ${column.dataType}` : ''}${primary}${column.notNull ? ' not null' : ''}${column.defaultSql === undefined ? '' : ` default ${column.defaultSql}`}`
}

/** Formats ordered columns for a key, index or explicit projection. */
export function columnsSql(columns: readonly string[]): string {
  if (!columns.length) throw capabilityError('SQLite key/index columns cannot be empty')

  return columns.map(quote).join(', ')
}

/** Validates referential actions before putting them in DDL. */
function actionSql(action: string): string {
  if (!['cascade', 'restrict', 'no action', 'set null', 'set default'].includes(action))
    throw capabilityError('Unsupported SQLite referential action')

  return action
}

/** Compiles a same-database foreign key using SQLite's unqualified REFERENCES syntax. */
function foreignKeySql(key: ForeignKey): string {
  assertMain(key.relation)

  if (key.columns.length !== key.referencedColumns.length)
    throw capabilityError('SQLite FK arity mismatch')

  return `foreign key (${columnsSql(key.columns)}) references ${quote(key.relation.relation.spelling)} (${columnsSql(key.referencedColumns)}) on delete ${actionSql(key.onDelete)} on update ${actionSql(key.onUpdate)}`
}

/** Compiles every final column and retained simple constraint into one CREATE TABLE. */
export function createSql(name: string, definition: Definition): CompiledQuery {
  try {
    validateSqliteObjectName(name, 'table')
  } catch (cause) {
    if (!(cause instanceof SqliteReservedObjectNameError)) throw cause

    throw capabilityError(cause.message)
  }

  if (!definition.columns.length)
    throw capabilityError('SQLite table must retain at least one column')

  const clauses = definition.columns.map(columnSql)

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
export function indexSql(table: string, index: Index): CompiledQuery {
  try {
    validateSqliteObjectName(index.name, 'index')
  } catch (cause) {
    if (!(cause instanceof SqliteReservedObjectNameError)) throw cause

    throw capabilityError(cause.message)
  }

  return statement(
    `create ${index.unique ? 'unique ' : ''}index ${address(index.name)} on ${quote(table)} (${columnsSql(index.columns)})`,
  )
}
