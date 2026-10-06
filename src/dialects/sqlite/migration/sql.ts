import type { CompiledQuery } from '@/dialects/types'
import type {
  CanonicalIdentifier,
  CanonicalRelationIdentity,
} from '@/migrations/canonicalRelationIdentity'

import { asciiFoldSqliteIdentifier } from '../identity'
import { sqliteNaming } from '../naming'

import type { Column, Definition, ForeignKey, Index } from './definition'
import { quote } from './definition'

/** Verifies a structured identifier rather than accepting a forged comparison key. */
export function assertIdentifier(identifier: CanonicalIdentifier): void {
  sqliteNaming.validate(identifier.spelling, 'SQLite migration identifier')

  if (asciiFoldSqliteIdentifier(identifier.spelling) !== identifier.comparisonKey)
    throw new Error('Invalid SQLite canonical identifier')
}

/** Rejects targets outside the supported main profile before SQL compilation. */
export function assertMain(identity: CanonicalRelationIdentity): void {
  const segment = identity.namespace[0]

  if (
    identity.namespace.length !== 1 ||
    segment.role !== 'database' ||
    segment.identifier.comparisonKey !== 'main'
  )
    throw new Error('SQLite migration targets must use database:main')

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
  if (!columns.length) throw new Error('SQLite key/index columns cannot be empty')

  return columns.map(quote).join(', ')
}

/** Validates referential actions before putting them in DDL. */
function actionSql(action: string): string {
  if (!['cascade', 'restrict', 'no action', 'set null', 'set default'].includes(action))
    throw new Error('Unsupported SQLite referential action')

  return action
}

/** Compiles a same-database foreign key using SQLite's unqualified REFERENCES syntax. */
function foreignKeySql(key: ForeignKey): string {
  assertMain(key.relation)

  if (key.columns.length !== key.referencedColumns.length)
    throw new Error('SQLite FK arity mismatch')

  return `foreign key (${columnsSql(key.columns)}) references ${quote(key.relation.relation.spelling)} (${columnsSql(key.referencedColumns)}) on delete ${actionSql(key.onDelete)} on update ${actionSql(key.onUpdate)}`
}

/** Compiles every final column and retained simple constraint into one CREATE TABLE. */
export function createSql(name: string, definition: Definition): CompiledQuery {
  if (!definition.columns.length)
    throw new Error('SQLite table must retain at least one column')

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
  return statement(
    `create ${index.unique ? 'unique ' : ''}index ${address(index.name)} on ${quote(table)} (${columnsSql(index.columns)})`,
  )
}
