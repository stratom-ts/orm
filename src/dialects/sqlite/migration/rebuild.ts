import type { MigrationStep, PlannedMigration } from '@/ddl/migrationPlan'
import type { MigrationAction, MigrationPrecondition } from '@/ddl/migrationProgram'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'

import { normalizeSqliteDataType, normalizeSqliteDefaultExpression } from '../normalize'
import { assertSafeSqliteDataType } from '../validate'

import type { Column, Definition } from './definition'
import {
  desiredColumn,
  literalDefault,
  observedDefinition,
  observedTable,
  quote,
  sameName,
} from './definition'
import { capabilityError } from './error'
import { address, columnsSql, createSql, indexSql, statement } from './sql'

export type TableGroup = {
  identity: CanonicalRelationIdentity
  steps: { step: MigrationStep; index: number }[]
}

/** Applies one semantic column operation to the retained table definition. */
function applyColumn(definition: Definition, step: MigrationStep): void {
  if (step.target.kind !== 'column') return

  const name = step.target.column.spelling
  const column = definition.columns.find((candidate) => sameName(candidate.name, name))

  if (!column)
    throw capabilityError(`SQLite column ${quote(name)} has no observed definition`)

  if (step.kind === 'alter_column_type') changeType(column, step.dataType)
  if (step.kind === 'set_not_null') column.notNull = true

  if (step.kind === 'drop_not_null') {
    if (column.rowidAlias)
      throw capabilityError('SQLite rowid aliases cannot become nullable')

    column.notNull = false
  }

  if (step.kind === 'add_unique_constraint') definition.unique.push([name])

  if (step.kind === 'add_foreign_key')
    definition.foreignKeys.push({
      columns: [name],
      relation: step.references.relation,
      referencedColumns: [step.references.column.spelling],
      onDelete: step.references.onDelete ?? 'no action',
      onUpdate: step.references.onUpdate ?? 'no action',
    })

  if (step.kind === 'drop_column') removeColumn(definition, name)
}

/** Permits only SQLite affinity changes that preserve all possible stored values. */
function changeType(column: Column, desired: string): void {
  const from = normalizeSqliteDataType(column.dataType)
  const to = normalizeSqliteDataType(desired)

  if (
    column.rowidAlias ||
    !(
      from === to ||
      to === 'blob' ||
      [from, to].every((type) => ['integer', 'numeric'].includes(type))
    )
  )
    throw capabilityError(
      `Unproven lossless SQLite conversion from ${column.dataType} to ${desired}`,
    )

  column.dataType = assertSafeSqliteDataType(desired)
}

/**
 * Removes only constraints authorized by a dropped column; retained indexes require
 * explicit drops.
 */
function removeColumn(definition: Definition, name: string): void {
  const touches = (columns: readonly string[]) =>
    columns.some((column) => sameName(column, name))

  if (
    touches(definition.primaryKey) ||
    definition.indexes.some((index) => touches(index.columns))
  )
    throw capabilityError(
      `SQLite dropped column ${quote(name)} has a retained key/index dependency`,
    )

  definition.columns = definition.columns.filter((column) => !sameName(column.name, name))
  definition.unique = definition.unique.filter((key) => !touches(key))
  definition.foreignKeys = definition.foreignKeys.filter((key) => !touches(key.columns))
}

/** Merges touching additions and explicit drops into one complete retained definition. */
export function finalDefinition(
  planned: PlannedMigration,
  group: TableGroup,
): Definition {
  const definition = observedDefinition(observedTable(planned, group.identity))
  const desired = planned.desiredTables.get(group.identity)

  for (const { step } of group.steps.filter(({ step }) => step.kind === 'drop_index')) {
    if (step.target.kind !== 'index') continue

    const name = step.target.index.spelling
    definition.indexes = definition.indexes.filter((index) => !sameName(index.name, name))
  }

  for (const { step } of group.steps) {
    if (step.kind === 'add_column') addColumn(definition, step, desired)
    else if (step.kind === 'create_index') {
      definition.indexes.push({
        name: step.target.index.spelling,
        columns: step.columns.map((column) => column.spelling),
        unique: step.unique,
      })
    } else applyColumn(definition, step)
  }

  return definition
}

/** Adds one registered column and its unique constraint to a final retained definition. */
function addColumn(
  definition: Definition,
  step: Extract<MigrationStep, { kind: 'add_column' }>,
  desired: import('@/dialects/types').LoweredDesiredTable | undefined,
): void {
  const column = desired?.columns.find(
    (candidate) =>
      candidate.identifier.comparisonKey === step.target.column.comparisonKey,
  )

  if (!column)
    throw capabilityError('SQLite ADD COLUMN lacks a registered desired column')

  definition.columns.push(desiredColumnForAddition(column))

  if (column.unique) definition.unique.push([column.identifier.spelling])
}

/** Reads a newly added desired column and rejects required-column backfills. */
function desiredColumnForAddition(
  column: import('@/dialects/types').LoweredDesiredColumn,
): Column {
  const result = desiredColumn(column, [])
  const normalized =
    result.defaultSql === undefined
      ? undefined
      : normalizeSqliteDefaultExpression(result.defaultSql)

  if (
    result.notNull &&
    (normalized === undefined ||
      normalized.toLowerCase() === 'null' ||
      !literalDefault(normalized))
  )
    throw capabilityError('SQLite required-column backfill is unsupported')

  return result
}

/** Chooses an unshadowed rowid spelling shared by old and replacement definitions. */
function hiddenRowid(old: Definition, final: Definition): string | undefined {
  if (old.columns.some((column) => column.rowidAlias)) return undefined

  const name = ['rowid', '_rowid_', 'oid'].find(
    (candidate) =>
      ![...old.columns, ...final.columns].some((column) =>
        sameName(column.name, candidate),
      ),
  )

  if (!name)
    throw capabilityError('SQLite hidden rowid cannot be addressed without shadowing')

  return name
}

/** Projects every retained column and rowid explicitly without casts or positional copies. */
function copySql(name: string, replacement: string, old: Definition, final: Definition) {
  const rowid = hiddenRowid(old, final)
  const columns = final.columns.map((column) => column.name)
  const expressions = final.columns.map((column) =>
    old.columns.some((source) => sameName(source.name, column.name))
      ? quote(column.name)
      : (column.defaultSql ?? 'null'),
  )

  if (rowid) {
    columns.unshift(rowid)
    expressions.unshift(quote(rowid))
  }

  return statement(
    `insert into ${address(replacement)} (${columnsSql(columns)}) select ${expressions.join(', ')} from ${address(name)}`,
  )
}

/** Preserves AUTOINCREMENT high-water state under the reserved replacement name. */
function sequenceBefore(name: string, replacement: string) {
  return statement(
    'insert into "main"."sqlite_sequence" (name, seq) select ?, seq from "main"."sqlite_sequence" where name = ? and not exists (select 1 from "main"."sqlite_sequence" where name = ?)',
    [replacement, name, replacement],
  )
}

/**
 * Raises the replacement sequence to the original high-water mark before dropping the
 * source.
 */
function sequenceRaise(name: string, replacement: string) {
  return statement(
    'update "main"."sqlite_sequence" set seq = max(seq, coalesce((select max(seq) from "main"."sqlite_sequence" where name = ?), 0)) where name = ?',
    [name, replacement],
  )
}

/** Builds one plan-atomic rebuild group with all source-step provenance. */
export function rebuild(
  planned: PlannedMigration,
  group: TableGroup,
  replacement: string,
): { action: MigrationAction; preconditions: MigrationPrecondition[] } {
  const name = group.identity.relation.spelling
  const old = observedDefinition(observedTable(planned, group.identity))
  const final = finalDefinition(planned, group)
  const statements = [
    createSql(replacement, final),
    copySql(name, replacement, old, final),
  ]

  if (old.columns.some((column) => column.autoIncrement))
    statements.push(sequenceBefore(name, replacement), sequenceRaise(name, replacement))

  statements.push(
    statement(`drop table ${address(name)}`),
    statement(`alter table ${address(replacement)} rename to ${quote(name)}`),
    ...final.indexes.map((index) => indexSql(name, index)),
  )

  const preconditions: MigrationPrecondition[] = group.steps
    .filter(({ step }) => step.kind === 'set_not_null')
    .map(({ step, index }) => ({
      kind: 'column_has_no_nulls',
      relation: group.identity,
      column: step.target.kind === 'column' ? step.target.column.spelling : '',
      sourceStepIndexes: [index],
    }))

  return {
    action: {
      sourceStepIndexes: group.steps.map(({ index }) => index),
      transaction: 'required',
      statements: [statements[0]!, ...statements.slice(1)],
    },
    preconditions,
  }
}
