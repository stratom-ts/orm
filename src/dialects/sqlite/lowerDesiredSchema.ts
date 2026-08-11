import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { ColumnGeneration, DatabaseDefault } from '@/schemas'
import { isSqlNullable } from '@/schemas'
import { MigrationError } from '@/utils/error'

import type {
  AuthoredDesiredColumn,
  AuthoredDesiredSchema,
  AuthoredDesiredTable,
  CreateTableColumnAst,
  LoweredDesiredSchema,
} from '../types'

import { inferSqliteColumnType } from './infer'
import { normalizeSqliteDataType } from './normalize'
import {
  assertSafeSqliteDataType,
  assertSafeSqliteExpression,
  formatSqliteLiteral,
  normalizeSqliteDefaultExpression,
} from './validate'

const same = (a: CanonicalRelationIdentity, b: CanonicalRelationIdentity) =>
  a.relation.comparisonKey === b.relation.comparisonKey &&
  a.namespace.length === b.namespace.length &&
  a.namespace.every(
    (x, i) =>
      x.role === b.namespace[i]?.role &&
      x.identifier.comparisonKey === b.namespace[i]?.identifier.comparisonKey,
  )
const format = (i: CanonicalRelationIdentity, c?: string) =>
  `[${i.namespace.map((x) => `${x.role}:${JSON.stringify(x.identifier.spelling)}`).join(', ')}, relation:${JSON.stringify(i.relation.spelling)}${c === undefined ? '' : `, column:${JSON.stringify(c)}`}]`
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
const compareIdentity = (a: CanonicalRelationIdentity, b: CanonicalRelationIdentity) => {
  for (let i = 0; i < Math.min(a.namespace.length, b.namespace.length); i++) {
    const role = compare(a.namespace[i]!.role, b.namespace[i]!.role)
    if (role) return role
    const key = compare(
      a.namespace[i]!.identifier.comparisonKey,
      b.namespace[i]!.identifier.comparisonKey,
    )
    if (key) return key
  }
  return (
    a.namespace.length - b.namespace.length ||
    compare(a.relation.comparisonKey, b.relation.comparisonKey)
  )
}
function database(i: CanonicalRelationIdentity): string {
  if (
    i.namespace.length !== 1 ||
    i.namespace[0]!.role !== 'database' ||
    i.namespace[0]!.identifier.comparisonKey !== 'main'
  )
    throw new MigrationError({
      message: `SQLite only supports permanent tables in database main; received ${format(i)}`,
    })
  return i.namespace[0]!.identifier.spelling
}
function physical(c: AuthoredDesiredColumn): string {
  return assertSafeSqliteDataType(
    String(c.metadata?.physicalType?.sqlite ?? inferSqliteColumnType(c.schema)),
  )
}
function lowerDefault(value: DatabaseDefault): { sql: string; normalized: string } {
  let sql: string
  if (value.kind === 'literal') sql = formatSqliteLiteral(value.value)
  else if (value.kind === 'portableExpression')
    sql = (
      {
        currentTimestamp: 'current_timestamp',
        currentDate: 'current_date',
        currentTime: 'current_time',
      } as const
    )[value.expression]
  else {
    if (value.dialect !== 'sqlite')
      throw new MigrationError({
        message: `SQLite cannot lower database expression tagged for dialect ${JSON.stringify(value.dialect)}`,
      })
    try {
      sql = assertSafeSqliteExpression(value.expression)
    } catch (e) {
      throw new MigrationError({
        message: e instanceof Error ? e.message : 'Unsafe SQLite database expression',
        cause: e,
      })
    }
  }
  return { sql, normalized: normalizeSqliteDefaultExpression(sql) }
}
function generation(
  g: ColumnGeneration | undefined,
  table: AuthoredDesiredTable,
  c: AuthoredDesiredColumn,
  type: string,
  pk: readonly string[],
): boolean {
  if (!g) return false
  if (g.kind === 'identity')
    throw new MigrationError({
      message: `SQLite does not support PostgreSQL identity generation on ${format(table.identity, c.name)}`,
    })
  if (g.kind === 'computed')
    throw new MigrationError({
      message: `SQLite computed generation is not supported on ${format(table.identity, c.name)}`,
    })
  if (g.dialect !== 'sqlite' || g.generation.toLowerCase() !== 'autoincrement')
    throw new MigrationError({
      message: `Unsupported SQLite dialect generation ${JSON.stringify(g.generation)}`,
    })
  if (pk.length !== 1 || pk[0] !== c.name || !/^integer$/i.test(type))
    throw new MigrationError({
      message: `SQLite AUTOINCREMENT requires the sole INTEGER primary key on ${format(table.identity, c.name)}`,
    })
  if (c.metadata?.databaseDefault !== undefined)
    throw new MigrationError({
      message: `SQLite AUTOINCREMENT cannot have a database default on ${format(table.identity, c.name)}`,
    })
  return true
}
function validateMetadata(table: AuthoredDesiredTable, c: AuthoredDesiredColumn): void {
  const m = c.metadata
  if (m?.comment !== undefined || m?.onUpdate !== undefined)
    throw new MigrationError({
      message: `SQLite migration lowering does not support unsupported metadata on ${format(table.identity, c.name)}`,
    })
}
export function lowerSqliteDesiredSchema(
  graph: AuthoredDesiredSchema,
): LoweredDesiredSchema {
  const ordered = [...graph.tables]
    .sort((a, b) => compareIdentity(a.identity, b.identity))
    .map((t) => {
      database(t.identity)
      if (t.metadata.schema !== undefined)
        throw new MigrationError({
          message: `SQLite does not support schema-authored metadata on ${format(t.identity)}`,
        })
      if (t.columns.length === 0)
        throw new MigrationError({
          message: `table ${format(t.identity)} has no columns`,
        })
      return t
    })
  const resolved = new Map<AuthoredDesiredColumn, string>()
  for (const table of ordered)
    for (const c of [...table.columns].sort((a, b) => compare(a.name, b.name)))
      if (!c.reference) resolved.set(c, physical(c))
  let pending = ordered.flatMap((table) =>
    [...table.columns]
      .sort((a, b) => compare(a.name, b.name))
      .filter((c) => c.reference)
      .map((column) => ({ table, column })),
  )
  while (pending.length) {
    const next: typeof pending = []
    let progress = false
    for (const item of pending) {
      const r = item.column.reference!
      database(r.targetRelation)
      const target = ordered.find((t) => same(t.identity, r.targetRelation))
      if (!target)
        throw new MigrationError({
          message: `Reference ${format(item.table.identity, item.column.name)} targets unregistered relation ${format(r.targetRelation)}`,
        })
      const tc = target.columns.find((x) => x.name === r.targetColumn)
      if (!tc)
        throw new MigrationError({
          message: `Reference ${format(item.table.identity, item.column.name)} targets missing column ${format(r.targetRelation, r.targetColumn)}`,
        })
      const t = resolved.get(tc)
      if (!t) {
        next.push(item)
        continue
      }
      const local = item.column.metadata?.physicalType?.sqlite
      const localType =
        local === undefined ? undefined : assertSafeSqliteDataType(String(local))
      if (
        localType !== undefined &&
        normalizeSqliteDataType(localType) !== normalizeSqliteDataType(t)
      )
        throw new MigrationError({
          message: `Reference column ${format(item.table.identity, item.column.name)} selects SQLite type ${JSON.stringify(local)} but target type is ${JSON.stringify(t)}`,
        })
      resolved.set(item.column, t)
      progress = true
    }
    if (!progress) {
      const first = next[0]!
      throw new MigrationError({
        message: `Cannot resolve reference-only physical type cycle at ${format(first.table.identity, first.column.name)}`,
      })
    }
    pending = next
  }
  const tables = ordered.map((table) => {
    const pk = Array.isArray(table.metadata.primaryKey)
      ? table.metadata.primaryKey
      : [table.metadata.primaryKey]
    const columns = table.columns.map((c) => {
      validateMetadata(table, c)
      const inheritedType = resolved.get(c)!
      const localType = c.reference ? c.metadata?.physicalType?.sqlite : undefined
      const type =
        localType === undefined
          ? inheritedType
          : assertSafeSqliteDataType(String(localType))
      const auto = generation(c.metadata?.generation, table, c, type, pk)
      const ref = c.reference
      const out: CreateTableColumnAst = {
        name: c.name,
        dataType: type,
        notNull: !isSqlNullable(c.schema),
        unique: Boolean(c.metadata?.unique) && !(pk.length === 1 && pk[0] === c.name),
        autoIncrement: auto,
        ...(c.metadata?.databaseDefault === undefined
          ? {}
          : { databaseDefault: lowerDefault(c.metadata.databaseDefault) }),
        ...(ref
          ? {
              references: {
                table: ref.targetRelation.relation.spelling,
                column: ref.targetColumn,
                ...(ref.metadata.onDelete ? { onDelete: ref.metadata.onDelete } : {}),
                ...(ref.metadata.onUpdate ? { onUpdate: ref.metadata.onUpdate } : {}),
              },
            }
          : {}),
      }
      return Object.freeze(out)
    })
    return Object.freeze({
      handle: table.handle,
      identity: table.identity,
      ast: Object.freeze({
        kind: 'create_table' as const,
        table: table.metadata.name,
        schema: database(table.identity),
        columns: Object.freeze(columns),
        primaryKey: Object.freeze(pk),
      }),
    })
  })
  return Object.freeze({ tables: Object.freeze(tables) })
}
