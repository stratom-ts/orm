import type {
  CatalogColumn,
  CatalogConstraintNameReservation,
  CatalogDiagnostic,
  CatalogExecutor,
  CatalogFact,
  CatalogForeignKey,
  CatalogIndex,
  CatalogIntrospector,
  CatalogKeyConstraint,
  CatalogNameReservation,
  CatalogNamespace,
  CatalogNoEvidence,
  CatalogRelation,
  CatalogRequest,
  CatalogSnapshot,
  CatalogTable,
  OpaqueCatalogObject,
  ResolvedCatalogRequest,
} from '@/dialects/catalog'
import type {
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
} from '@/migrations/canonicalRelationIdentity'
import type { ReferentialAction } from '@/schemas/actions/types'
import { InvariantError } from '@/utils/error'

import { asciiFoldSqliteIdentifier, sqliteIdentity } from './identity'
import { normalizeSqliteDataType, normalizeSqliteDefaultExpression } from './normalize'
import {
  assertSafeSqliteDefaultExpression,
  normalizeSqliteDefaultValue,
} from './validate'

type Row = Record<string, unknown>
type TableRow = {
  schema: string
  name: string
  type: string
  ncol: number
  wr: number
  strict: number
}
type SchemaRow = { type: string; name: string; tbl_name: string; sql: string | null }
type XInfoRow = {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
}
type IndexListRow = {
  seq: number
  name: string
  unique: number
  origin: string
  partial: number
}
type IndexInfoRow = {
  seqno: number
  cid: number
  name: string | null
  desc: number
  coll: string | null
  key: number
}
type ForeignKeyRow = {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  on_update: string
  on_delete: string
  match: string
}

const complete = { state: 'complete' } as const
const absent = { state: 'absent' } as const
const mainNamespace = [{ role: 'database' as const, spelling: 'main' }]

function present<T>(value: T): CatalogFact<T> {
  return { state: 'present', value }
}

function unsupported(reason: string): CatalogNoEvidence {
  return { state: 'unsupported', by: 'adapter', reason }
}

function unsupportedByEngine(reason: string): CatalogNoEvidence {
  return { state: 'unsupported', by: 'engine', reason }
}

function unmanaged(reason: string): CatalogNoEvidence {
  return { state: 'unmanaged', reason }
}

function unknown(reason: string): CatalogNoEvidence {
  return { state: 'unknown', reason }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function relationSpelling(identity: CanonicalRelationIdentity): string {
  const namespace = identity.namespace
    .map((segment) => `${segment.role}:${segment.identifier.spelling}`)
    .join('\0')

  return `${namespace}\0${identity.relation.spelling}`
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).sort(compare).join(',')}]`

  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }

  return JSON.stringify(typeof value === 'bigint' ? value.toString() : value)
}

function rowAt(value: unknown, query: string, index: number): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantError(`Malformed SQLite ${query} row ${index}: expected an object`)
  }

  return value as Row
}

function stringAt(row: Row, key: string, query: string, index: number): string {
  const value = row[key]

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvariantError(
      `Malformed SQLite ${query} row ${index}: ${JSON.stringify(key)} must be a non-empty string`,
    )
  }

  return value
}

function nullableStringAt(
  row: Row,
  key: string,
  query: string,
  index: number,
): string | null {
  const value = row[key]

  if (value === null) return null

  if (typeof value !== 'string') {
    throw new InvariantError(
      `Malformed SQLite ${query} row ${index}: ${JSON.stringify(key)} must be a string or null`,
    )
  }

  return value
}

function integerAt(row: Row, key: string, query: string, index: number, min = 0): number {
  const value = row[key]

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) {
    throw new InvariantError(
      `Malformed SQLite ${query} row ${index}: ${JSON.stringify(key)} must be an integer`,
    )
  }

  return value
}

function flagAt(row: Row, key: string, query: string, index: number): number {
  const value = integerAt(row, key, query, index)

  if (value !== 0 && value !== 1) {
    throw new InvariantError(
      `Malformed SQLite ${query} row ${index}: ${JSON.stringify(key)} must be 0 or 1`,
    )
  }

  return value
}

function sameNamespace(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
) {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right[index]
      return (
        segment.role === other?.role &&
        segment.identifier.comparisonKey === other.identifier.comparisonKey
      )
    })
  )
}

function compareNamespaces(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
) {
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const a = left[index]!
    const b = right[index]!
    const role = compare(a.role, b.role)

    if (role) return role

    const name = compare(a.identifier.comparisonKey, b.identifier.comparisonKey)

    if (name) return name
  }

  return left.length - right.length
}

function relationInput(database: string, relation: string) {
  return { namespace: [{ role: 'database' as const, spelling: database }], relation }
}

function resolveRequest(
  request: CatalogRequest,
  identities: ReturnType<typeof sqliteIdentity.create>,
): ResolvedCatalogRequest {
  const relationsMap =
    identities.createRegistry<ResolvedCatalogRequest['relations'][number]>()

  for (const entry of request.relations) {
    const identity = identities.resolve(entry.relation)
    relationsMap.set(identity, { identity, shape: entry.shape })
  }

  const relations = request.relations
    .map((entry) => relationsMap.get(identities.resolve(entry.relation))!)
    .filter(
      (entry, index, values) =>
        values.findIndex((candidate) =>
          identities.equals(candidate.identity, entry.identity),
        ) === index,
    )
    .sort((a, b) => identities.compare(a.identity, b.identity))
  const absentMap = identities.createRegistry<CanonicalRelationIdentity>()
  for (const input of request.absentRelations) {
    const identity = identities.resolve(input)
    absentMap.set(identity, identity)
  }

  const absentRelations = request.absentRelations
    .map((input) => absentMap.get(identities.resolve(input))!)
    .filter(
      (entry, index, values) =>
        values.findIndex((candidate) => identities.equals(candidate, entry)) === index,
    )
    .sort(identities.compare)
  const completeNamespaces = request.completeNamespaces
    .map((namespace) => identities.resolveNamespace(namespace))
    .filter(
      (namespace, index, values) =>
        values.findIndex((candidate) => sameNamespace(candidate, namespace)) === index,
    )
    .sort(compareNamespaces)
  return { relations, absentRelations, completeNamespaces }
}

function compareFact(left: CatalogFact<string>, right: CatalogFact<string>): number {
  const state = compare(left.state, right.state)

  if (state) return state

  if (left.state === 'present' && right.state === 'present')
    return compare(left.value, right.value)

  return compare(JSON.stringify(left), JSON.stringify(right))
}

function relationRequested(
  identity: CanonicalRelationIdentity,
  request: ResolvedCatalogRequest,
  identities: ReturnType<typeof sqliteIdentity.create>,
) {
  return (
    request.relations.some((entry) => identities.equals(entry.identity, identity)) ||
    request.absentRelations.some((entry) => identities.equals(entry, identity)) ||
    request.completeNamespaces.some((namespace) =>
      sameNamespace(namespace, identity.namespace),
    )
  )
}

function isMain(identity: CanonicalRelationIdentity): boolean {
  return (
    identity.namespace.length === 1 &&
    identity.namespace[0]?.role === 'database' &&
    identity.namespace[0].identifier.comparisonKey === 'main'
  )
}

function parseDefault(
  raw: string,
): CatalogFact<
  NonNullable<CatalogColumn['default'] extends CatalogFact<infer T> ? T : never>
> {
  const value = raw.trim()
  let comparisonKey: string | undefined

  if (/^null$/i.test(value)) comparisonKey = 'null'
  else if (/^(true|false)$/i.test(value))
    comparisonKey = normalizeSqliteDefaultValue(value.toLowerCase() === 'true')
  else if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
    comparisonKey = value
  else if (/^[xX]'(?:[0-9a-fA-F]{2})*'$/.test(value)) comparisonKey = value.toLowerCase()
  else if (/^'(?:[^']|'')*'$/.test(value)) comparisonKey = value

  if (comparisonKey !== undefined)
    return present({
      kind: 'literal',
      native: raw,
      comparisonKey: present(comparisonKey),
    })

  try {
    const expression = assertSafeSqliteDefaultExpression(value)

    return present({
      kind: 'portableExpression',
      native: raw,
      comparisonKey: present(normalizeSqliteDefaultExpression(expression)),
    })
  } catch {
    return present({
      kind: 'nativeExpression',
      native: raw,
      comparisonKey: unsupported('SQLite default expression is not portable'),
    })
  }
}

/** A quote/comment-aware scanner for unquoted CREATE TABLE SQL token sequences. */
// oxlint-disable-next-line complexity
function hasSqlTokens(sql: string, wanted: readonly string[]): boolean {
  let index = 0
  let token = ''
  const tokens: string[] = []
  const flush = () => {
    if (token.length > 0) tokens.push(token.toUpperCase())

    token = ''
  }

  while (index < sql.length) {
    const character = sql[index]!

    if (character === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index + 2)
      index = end < 0 ? sql.length : end + 1
      flush()
      continue
    }

    if (character === '/' && sql[index + 1] === '*') {
      const end = sql.indexOf('*/', index + 2)

      if (end < 0)
        throw new InvariantError(
          'Malformed SQLite schema SQL: unterminated block comment',
        )

      index = end + 2
      flush()
      continue
    }

    if (character === "'") {
      flush()
      index++
      let closed = false
      while (index < sql.length) {
        if (sql[index] === "'") {
          if (sql[index + 1] === "'") index += 2
          else {
            index++
            closed = true
            break
          }
        } else index++
      }

      if (!closed)
        throw new InvariantError('Malformed SQLite schema SQL: unterminated string')

      continue
    }

    if (character === '"' || character === '`' || character === '[') {
      flush()
      const close = character === '[' ? ']' : character
      index++
      let closed = false
      while (index < sql.length) {
        if (sql[index] === close) {
          if (sql[index + 1] === close && close !== ']') index += 2
          else {
            index++
            closed = true
            break
          }
        } else index++
      }

      if (!closed)
        throw new InvariantError(
          'Malformed SQLite schema SQL: unterminated quoted identifier',
        )

      continue
    }

    if (/[A-Za-z0-9_]/.test(character)) token += character
    else flush()

    index++
  }

  flush()
  return tokens.some((_, index) =>
    wanted.every((part, offset) => tokens[index + offset] === part),
  )
}

function hasSqlToken(sql: string, wanted: string): boolean {
  return hasSqlTokens(sql, [wanted])
}

function action(value: string, query: string, index: number): ReferentialAction {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ')

  if (
    normalized === 'no action' ||
    normalized === 'restrict' ||
    normalized === 'cascade' ||
    normalized === 'set null' ||
    normalized === 'set default'
  )
    return normalized

  throw new InvariantError(
    `Malformed SQLite ${query} row ${index}: invalid referential action`,
  )
}

function sameColumnIdentities(
  left: readonly string[],
  right: readonly string[],
  identities: ReturnType<typeof sqliteIdentity.create>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (column, index) =>
        identities.member('column', column).comparisonKey ===
        identities.member('column', right[index]!).comparisonKey,
    )
  )
}

function decodeTableRows(rows: unknown[]): TableRow[] {
  return rows.map((value, index) => {
    const row = rowAt(value, 'table_list', index)
    const type = stringAt(row, 'type', 'table_list', index)

    if (type !== 'table' && type !== 'view' && type !== 'virtual' && type !== 'shadow')
      throw new InvariantError(`Malformed SQLite table_list row ${index}: invalid type`)

    return {
      schema: stringAt(row, 'schema', 'table_list', index),
      name: stringAt(row, 'name', 'table_list', index),
      type,
      ncol: integerAt(row, 'ncol', 'table_list', index),
      wr: flagAt(row, 'wr', 'table_list', index),
      strict: flagAt(row, 'strict', 'table_list', index),
    }
  })
}

function decodeSchemaRows(rows: unknown[]): SchemaRow[] {
  return rows.map((value, index) => {
    const row = rowAt(value, 'sqlite_schema', index)
    return {
      type: stringAt(row, 'type', 'sqlite_schema', index),
      name: stringAt(row, 'name', 'sqlite_schema', index),
      tbl_name: stringAt(row, 'tbl_name', 'sqlite_schema', index),
      sql: nullableStringAt(row, 'sql', 'sqlite_schema', index),
    }
  })
}

function decodeXInfoRows(rows: unknown[], table: string): XInfoRow[] {
  return rows.map((value, index) => {
    const row = rowAt(value, `table_xinfo(${table})`, index)
    const hidden = integerAt(row, 'hidden', 'table_xinfo', index)

    if (hidden > 3)
      throw new InvariantError(
        `Malformed SQLite table_xinfo row ${index}: invalid hidden value`,
      )

    return {
      cid: integerAt(row, 'cid', 'table_xinfo', index),
      name: stringAt(row, 'name', 'table_xinfo', index),
      type:
        typeof row.type === 'string'
          ? row.type
          : (() => {
              throw new InvariantError(
                `Malformed SQLite table_xinfo row ${index}: "type" must be a string`,
              )
            })(),
      notnull: flagAt(row, 'column_notnull', 'table_xinfo', index),
      dflt_value: nullableStringAt(row, 'dflt_value', 'table_xinfo', index),
      pk: integerAt(row, 'pk', 'table_xinfo', index),
      hidden,
    }
  })
}

function decodeIndexListRows(rows: unknown[], table: string): IndexListRow[] {
  return rows.map((value, index) => {
    const row = rowAt(value, `index_list(${table})`, index)
    const origin = stringAt(row, 'origin', 'index_list', index).toLowerCase()

    if (origin !== 'c' && origin !== 'u' && origin !== 'pk')
      throw new InvariantError(`Malformed SQLite index_list row ${index}: invalid origin`)

    return {
      seq: integerAt(row, 'seq', 'index_list', index),
      name: stringAt(row, 'name', 'index_list', index),
      unique: flagAt(row, 'unique', 'index_list', index),
      origin,
      partial: flagAt(row, 'partial', 'index_list', index),
    }
  })
}

function decodeIndexInfoRows(
  rows: unknown[],
  table: string,
  indexName: string,
): IndexInfoRow[] {
  return rows.map((value, index) => {
    const row = rowAt(value, `index_xinfo(${table},${indexName})`, index)
    return {
      seqno: integerAt(row, 'seqno', 'index_xinfo', index),
      cid:
        typeof row.cid === 'number' && Number.isSafeInteger(row.cid)
          ? row.cid
          : (() => {
              throw new InvariantError(
                `Malformed SQLite index_xinfo row ${index}: "cid" must be an integer`,
              )
            })(),
      name: row.name === null ? null : stringAt(row, 'name', 'index_xinfo', index),
      desc: flagAt(row, 'desc', 'index_xinfo', index),
      coll: nullableStringAt(row, 'coll', 'index_xinfo', index),
      key: flagAt(row, 'key', 'index_xinfo', index),
    }
  })
}

function decodeForeignKeyRows(rows: unknown[], table: string): ForeignKeyRow[] {
  return rows.map((value, index) => {
    const row = rowAt(value, `foreign_key_list(${table})`, index)
    return {
      id: integerAt(row, 'id', 'foreign_key_list', index),
      seq: integerAt(row, 'seq', 'foreign_key_list', index),
      table: stringAt(row, 'table', 'foreign_key_list', index),
      from: stringAt(row, 'from', 'foreign_key_list', index),
      to: nullableStringAt(row, 'to', 'foreign_key_list', index),
      on_update: stringAt(row, 'on_update', 'foreign_key_list', index),
      on_delete: stringAt(row, 'on_delete', 'foreign_key_list', index),
      match: stringAt(row, 'match', 'foreign_key_list', index),
    }
  })
}

const queries = {
  version: { sql: 'select sqlite_version() as version', params: [] },
  databases: {
    sql: 'select seq, name, file from pragma_database_list order by seq, name',
    params: [],
  },
  tables: {
    sql: 'select schema, name, type, ncol, wr, strict from pragma_table_list order by schema, name, type',
    params: [],
  },
  schema: {
    sql: 'select type, name, tbl_name, sql from main.sqlite_schema order by type, name, tbl_name',
    params: [],
  },
  xinfo: (table: string) => ({
    sql: 'select cid, name, type, "notnull" as column_notnull, dflt_value, pk, hidden from pragma_table_xinfo(?, ?) order by cid, name',
    params: [table, 'main'],
  }),
  indexes: (table: string) => ({
    sql: 'select seq, name, "unique", origin, partial from pragma_index_list(?, ?) order by seq, name',
    params: [table, 'main'],
  }),
  indexInfo: (indexName: string) => ({
    sql: 'select seqno, cid, name, "desc", coll, "key" from pragma_index_xinfo(?, ?) order by seqno, cid, name',
    params: [indexName, 'main'],
  }),
  foreignKeys: (table: string) => ({
    sql: 'select id, seq, "table", "from", "to", on_update, on_delete, "match" from pragma_foreign_key_list(?, ?) order by id, seq',
    params: [table, 'main'],
  }),
}

/** Production SQLite evidence-bearing catalog introspector. */
// oxlint-disable-next-line complexity
async function introspectSqlite(
  executor: CatalogExecutor,
  request: CatalogRequest,
): Promise<CatalogSnapshot> {
  const versionRows = await executor.execute(queries.version)

  if (versionRows.length !== 1)
    throw new InvariantError('SQLite sqlite_version() must return exactly one row')

  const versionRow = rowAt(versionRows[0], 'sqlite_version', 0)
  const version = stringAt(versionRow, 'version', 'sqlite_version', 0)
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version)

  if (!match)
    throw new InvariantError(
      'Malformed SQLite sqlite_version row 0: "version" must be semantic numeric version',
    )

  const actualVersion = [Number(match[1]), Number(match[2]), Number(match[3])]

  if (actualVersion.some((part) => !Number.isSafeInteger(part)))
    throw new InvariantError(
      'Malformed SQLite sqlite_version row 0: version components must be safe integers',
    )

  const namespaceContext = { writableDefault: mainNamespace }
  const identities = sqliteIdentity.create({
    context: namespaceContext,
    ...(request.registrationDefault === undefined
      ? {}
      : { registrationDefault: request.registrationDefault }),
  })

  if (
    request.registrationDefault !== undefined &&
    !sameNamespace(
      identities.resolveNamespace(request.registrationDefault),
      identities.resolveNamespace(mainNamespace),
    )
  )
    throw new InvariantError(
      'SQLite catalog cannot manage an attached registration default',
    )

  const resolvedRequest = resolveRequest(request, identities)
  for (const identity of resolvedRequest.relations
    .map((entry) => entry.identity)
    .concat(resolvedRequest.absentRelations))
    if (!isMain(identity))
      throw new InvariantError(
        `SQLite catalog cannot manage attached database relation ${identities.format(identity)}`,
      )
  for (const namespace of resolvedRequest.completeNamespaces)
    if (!sameNamespace(namespace, identities.resolveNamespace(mainNamespace)))
      throw new InvariantError(
        'SQLite catalog cannot manage an attached database namespace',
      )
  const versionLimited =
    actualVersion[0]! < 3 || (actualVersion[0] === 3 && actualVersion[1]! < 37)

  if (versionLimited) {
    const evidence = {
      state: 'unavailable' as const,
      cause: 'version' as const,
      actual: version,
      requires: '3.37.0',
    }
    return {
      source: { dialect: 'sqlite', version },
      request: resolvedRequest,
      capabilities: {
        namespaces: evidence,
        relationOwner: evidence,
        identity: evidence,
        richObjects: evidence,
      },
      namespaceContext,
      namespaces: { items: [], coverage: evidence },
      nameReservations: { items: [], coverage: evidence },
      constraintNameReservations: { items: [], coverage: evidence },
      diagnostics: [
        {
          code: 'catalog.capability.version',
          message: `SQLite catalog introspection requires version 3.37.0; observed ${version}`,
        },
      ],
    }
  }

  const dbRows = await executor.execute(queries.databases)
  const databases = dbRows.map((value, index) => {
    const row = rowAt(value, 'database_list', index)
    return {
      seq: integerAt(row, 'seq', 'database_list', index),
      name: stringAt(row, 'name', 'database_list', index),
      file: nullableStringAt(row, 'file', 'database_list', index),
    }
  })

  if (new Set(databases.map((entry) => entry.seq)).size !== databases.length)
    throw new InvariantError('SQLite database_list sequence values must be unique')

  if (
    new Set(databases.map((entry) => asciiFoldSqliteIdentifier(entry.name))).size !==
    databases.length
  )
    throw new InvariantError('SQLite database_list aliases must be unique')

  if (databases.filter((entry) => entry.name === 'main').length !== 1)
    throw new InvariantError(
      'SQLite database_list must contain exactly one main database',
    )

  const databaseAliases = new Set(
    databases.map((entry) => asciiFoldSqliteIdentifier(entry.name)),
  )

  const temporaryDatabase = databases.some(
    (entry) => asciiFoldSqliteIdentifier(entry.name) === 'temp',
  )
  const attached = databases
    .filter(
      (entry) =>
        asciiFoldSqliteIdentifier(entry.name) !== 'main' &&
        asciiFoldSqliteIdentifier(entry.name) !== 'temp',
    )
    .sort((a, b) => compare(a.name, b.name))
  const diagnostics: CatalogDiagnostic[] = attached.map((entry) => ({
    code: 'catalog.sqlite.attached',
    message: `SQLite attached database ${JSON.stringify(entry.name)} is observed but its schema dependencies are not managed`,
  }))

  if (temporaryDatabase)
    diagnostics.push({
      code: 'catalog.sqlite.temporary',
      message: 'SQLite temporary schema is observed but its dependencies are not managed',
    })

  const tableRows = decodeTableRows(await executor.execute(queries.tables))
  const schemaRows = decodeSchemaRows(await executor.execute(queries.schema))
  const tableListIdentities = new Map<string, Set<string>>()

  for (const row of tableRows) {
    const schemaKey = asciiFoldSqliteIdentifier(row.schema)
    const identity = identities.resolve(relationInput(row.schema, row.name))
    const relationKeys = tableListIdentities.get(schemaKey) ?? new Set<string>()
    const internalSchemaTable =
      row.name === 'sqlite_schema' || row.name === 'sqlite_temp_schema'

    if (!databaseAliases.has(schemaKey) && !internalSchemaTable)
      throw new InvariantError(
        `SQLite table_list row ${JSON.stringify(row.name)} references an unlisted database alias ${JSON.stringify(row.schema)}`,
      )

    if (relationKeys.has(identity.relation.comparisonKey))
      throw new InvariantError(
        `Duplicate SQLite table_list relation ${JSON.stringify(row.schema)}.${JSON.stringify(row.name)}`,
      )

    relationKeys.add(identity.relation.comparisonKey)
    tableListIdentities.set(schemaKey, relationKeys)
  }

  const mainTables = tableRows.filter(
    (row) => row.schema === 'main' && !row.name.startsWith('sqlite_'),
  )
  const viewObjects = schemaRows.filter((row) => row.type === 'view')
  const triggerObjects = schemaRows.filter((row) => row.type === 'trigger')

  if (viewObjects.length > 0)
    diagnostics.push({
      code: 'catalog.sqlite.view-dependency',
      message: 'SQLite view dependencies are not resolved and may affect ordinary tables',
    })

  if (triggerObjects.length > 0)
    diagnostics.push({
      code: 'catalog.sqlite.trigger-dependency',
      message: 'SQLite trigger dependencies are not resolved and may affect other tables',
    })

  const hasExternalNamespace =
    attached.length > 0 ||
    temporaryDatabase ||
    tableRows.some(
      (row) =>
        asciiFoldSqliteIdentifier(row.schema) !== 'main' &&
        !row.name.startsWith('sqlite_'),
    )
  for (const row of tableRows.filter(
    (entry) => entry.schema !== 'main' && !entry.name.startsWith('sqlite_'),
  ))
    diagnostics.push({
      code: 'catalog.sqlite.unmanaged-relation',
      message: `SQLite ${asciiFoldSqliteIdentifier(row.schema) === 'temp' ? 'temporary' : 'attached'} relation ${JSON.stringify(row.name)} is observed but its schema dependencies are not managed`,
    })
  const scopeIdentity = (name: string) => identities.resolve(relationInput('main', name))
  const scopeRows = mainTables.filter((row) =>
    relationRequested(scopeIdentity(row.name), resolvedRequest, identities),
  )
  const completeMain = resolvedRequest.completeNamespaces.some((entry) =>
    sameNamespace(entry, identities.resolveNamespace(mainNamespace)),
  )

  const schemaNames = new Set<string>()
  for (const row of schemaRows) {
    if (
      row.type !== 'table' &&
      row.type !== 'index' &&
      row.type !== 'view' &&
      row.type !== 'trigger'
    )
      throw new InvariantError(
        `Malformed SQLite sqlite_schema row: invalid type ${JSON.stringify(row.type)}`,
      )

    const collisionDomain =
      row.type === 'trigger' ? 'trigger' : row.type === 'index' ? 'index' : 'relation'
    const key = `${collisionDomain}:${asciiFoldSqliteIdentifier(row.name)}`

    if (schemaNames.has(key))
      throw new InvariantError(
        `Duplicate SQLite sqlite_schema ${collisionDomain} name ${JSON.stringify(row.name)}`,
      )

    schemaNames.add(key)
  }

  const schemaForTable = (name: string) =>
    schemaRows.find(
      (row) =>
        (row.type === 'table' || row.type === 'view') &&
        asciiFoldSqliteIdentifier(row.name) === asciiFoldSqliteIdentifier(name),
    )

  for (const schemaRow of schemaRows) {
    const relevant =
      completeMain ||
      relationRequested(
        scopeIdentity(
          schemaRow.type === 'table' || schemaRow.type === 'view'
            ? schemaRow.name
            : schemaRow.tbl_name || schemaRow.name,
        ),
        resolvedRequest,
        identities,
      )

    if (!relevant || schemaRow.name.startsWith('sqlite_')) continue

    if (
      (schemaRow.type === 'table' || schemaRow.type === 'view') &&
      scopeIdentity(schemaRow.name).relation.comparisonKey !==
        scopeIdentity(schemaRow.tbl_name).relation.comparisonKey
    )
      throw new InvariantError(
        `SQLite sqlite_schema ${schemaRow.type} row ${JSON.stringify(schemaRow.name)} has mismatched tbl_name ${JSON.stringify(schemaRow.tbl_name)}`,
      )

    if (
      (schemaRow.type === 'table' || schemaRow.type === 'view') &&
      !mainTables.some(
        (table) =>
          scopeIdentity(table.name).relation.comparisonKey ===
          scopeIdentity(schemaRow.name).relation.comparisonKey,
      )
    )
      throw new InvariantError(
        `SQLite sqlite_schema relation ${JSON.stringify(schemaRow.name)} is missing from table_list`,
      )

    if (
      schemaRow.type === 'index' &&
      !mainTables.some(
        (table) =>
          scopeIdentity(table.name).relation.comparisonKey ===
          scopeIdentity(schemaRow.tbl_name).relation.comparisonKey,
      )
    )
      throw new InvariantError(
        `SQLite sqlite_schema index ${JSON.stringify(schemaRow.name)} references a missing table`,
      )
  }

  for (const tableRow of mainTables) {
    if (
      tableRow.name.startsWith('sqlite_') ||
      (!completeMain &&
        !relationRequested(scopeIdentity(tableRow.name), resolvedRequest, identities))
    )
      continue

    const schemaRow = schemaForTable(tableRow.name)

    if (schemaRow === undefined)
      throw new InvariantError(
        `SQLite ${tableRow.type} relation ${JSON.stringify(tableRow.name)} is missing sqlite_schema definition`,
      )

    if (schemaRow !== undefined) {
      const expectedSchemaType = tableRow.type === 'view' ? 'view' : 'table'

      if (schemaRow.type !== expectedSchemaType)
        throw new InvariantError(
          `SQLite table_list relation ${JSON.stringify(tableRow.name)} type ${JSON.stringify(tableRow.type)} disagrees with sqlite_schema type ${JSON.stringify(schemaRow.type)}`,
        )
    }
  }

  const xinfo = new Map<string, XInfoRow[]>()
  const indexLists = new Map<string, IndexListRow[]>()
  const indexInfos = new Map<string, IndexInfoRow[]>()
  const foreignKeys = new Map<string, ForeignKeyRow[]>()
  for (const row of scopeRows) {
    if (row.type !== 'table' && row.type !== 'virtual' && row.type !== 'shadow') continue

    xinfo.set(
      row.name,
      decodeXInfoRows(await executor.execute(queries.xinfo(row.name)), row.name),
    )

    indexLists.set(
      row.name,
      decodeIndexListRows(await executor.execute(queries.indexes(row.name)), row.name),
    )

    foreignKeys.set(
      row.name,
      decodeForeignKeyRows(
        await executor.execute(queries.foreignKeys(row.name)),
        row.name,
      ),
    )

    for (const index of indexLists.get(row.name)!)
      indexInfos.set(
        `${row.name}\0${index.name}`,
        decodeIndexInfoRows(
          await executor.execute(queries.indexInfo(index.name)),
          row.name,
          index.name,
        ),
      )
  }

  const reservationIndexLists = new Map<string, IndexListRow[]>()
  for (const row of mainTables.filter(
    (entry) => entry.type === 'table' && !entry.name.startsWith('sqlite_'),
  )) {
    const observed =
      indexLists.get(row.name) ??
      decodeIndexListRows(await executor.execute(queries.indexes(row.name)), row.name)
    reservationIndexLists.set(row.name, observed)
  }

  for (const owner of mainTables.filter((entry) =>
    relationRequested(scopeIdentity(entry.name), resolvedRequest, identities),
  )) {
    const indexes =
      indexLists.get(owner.name) ?? reservationIndexLists.get(owner.name) ?? []
    const listed = new Set(
      indexes.map((entry) => identities.member('index', entry.name).comparisonKey),
    )

    for (const entry of indexes) {
      if (entry.origin === 'u' && (entry.unique !== 1 || entry.partial !== 0))
        throw new InvariantError(
          `SQLite UNIQUE index ${JSON.stringify(entry.name)} has invalid flags`,
        )

      if (entry.origin !== 'c') continue

      const matches = schemaRows.filter(
        (schema) =>
          schema.type === 'index' &&
          identities.member('index', schema.name).comparisonKey ===
            identities.member('index', entry.name).comparisonKey &&
          scopeIdentity(schema.tbl_name).relation.comparisonKey ===
            scopeIdentity(owner.name).relation.comparisonKey,
      )

      if (matches.length !== 1 || matches[0]!.sql === null)
        throw new InvariantError(
          `SQLite user index ${JSON.stringify(entry.name)} has missing or mismatched sqlite_schema evidence`,
        )
    }

    for (const schema of schemaRows.filter(
      (entry) =>
        entry.type === 'index' &&
        scopeIdentity(entry.tbl_name).relation.comparisonKey ===
          scopeIdentity(owner.name).relation.comparisonKey,
    ))
      if (!listed.has(identities.member('index', schema.name).comparisonKey))
        throw new InvariantError(
          `SQLite sqlite_schema index ${JSON.stringify(schema.name)} is missing from index_list`,
        )
  }

  const scopedRows = (rows: readonly TableRow[]) =>
    rows.filter(
      (row) =>
        row.schema === 'main' &&
        relationRequested(scopeIdentity(row.name), resolvedRequest, identities),
    )

  const assertSame = (label: string, first: unknown, second: unknown) => {
    if (stable(first) !== stable(second))
      throw new InvariantError(
        `SQLite catalog changed during introspection: ${label} observations differ`,
      )
  }

  assertSame(
    'database_list',
    databases,
    (await executor.execute(queries.databases)).map((value, index) => {
      const row = rowAt(value, 'database_list', index)
      return {
        seq: integerAt(row, 'seq', 'database_list', index),
        name: stringAt(row, 'name', 'database_list', index),
        file: nullableStringAt(row, 'file', 'database_list', index),
      }
    }),
  )

  assertSame(
    'table_list',
    scopedRows(tableRows),
    scopedRows(decodeTableRows(await executor.execute(queries.tables))),
  )

  const finalSchema = decodeSchemaRows(await executor.execute(queries.schema))
  assertSame('sqlite_schema', schemaRows, finalSchema)
  for (const [table, observed] of reservationIndexLists)
    assertSame(
      `reservation index_list(${table})`,
      observed,
      decodeIndexListRows(await executor.execute(queries.indexes(table)), table),
    )

  for (const row of scopeRows) {
    if (row.type !== 'table' && row.type !== 'virtual' && row.type !== 'shadow') continue

    const finalX = decodeXInfoRows(
      await executor.execute(queries.xinfo(row.name)),
      row.name,
    )
    const finalI = decodeIndexListRows(
      await executor.execute(queries.indexes(row.name)),
      row.name,
    )
    const finalF = decodeForeignKeyRows(
      await executor.execute(queries.foreignKeys(row.name)),
      row.name,
    )
    assertSame(`table_xinfo(${row.name})`, xinfo.get(row.name), finalX)
    assertSame(`index_list(${row.name})`, indexLists.get(row.name), finalI)
    assertSame(`foreign_key_list(${row.name})`, foreignKeys.get(row.name), finalF)
    for (const index of finalI)
      assertSame(
        `index_xinfo(${row.name},${index.name})`,
        indexInfos.get(`${row.name}\0${index.name}`),
        decodeIndexInfoRows(
          await executor.execute(queries.indexInfo(index.name)),
          row.name,
          index.name,
        ),
      )
  }

  const names: CatalogNameReservation[] = []
  for (const row of schemaRows) {
    if (row.type === 'trigger') continue

    names.push({ namespace: identities.resolveNamespace(mainNamespace), name: row.name })
  }

  for (const row of mainTables.filter(
    (entry) => entry.type === 'table' && !entry.name.startsWith('sqlite_'),
  )) {
    const indexes = reservationIndexLists.get(row.name) ?? []
    for (const index of indexes)
      names.push({
        namespace: identities.resolveNamespace(mainNamespace),
        name: index.name,
      })
  }

  const seenNameSpellings = new Map<string, string>()

  for (const entry of names) {
    const key = asciiFoldSqliteIdentifier(entry.name)
    const previous = seenNameSpellings.get(key)

    if (previous !== undefined && previous !== entry.name)
      throw new InvariantError(
        `Conflicting SQLite catalog reservations ${JSON.stringify(previous)} and ${JSON.stringify(entry.name)}`,
      )

    seenNameSpellings.set(key, entry.name)
  }

  const uniqueNames = names
    .filter(
      (entry, index, values) =>
        values.findIndex(
          (other) =>
            asciiFoldSqliteIdentifier(other.name) ===
            asciiFoldSqliteIdentifier(entry.name),
        ) === index,
    )
    .sort(
      (a, b) =>
        compare(asciiFoldSqliteIdentifier(a.name), asciiFoldSqliteIdentifier(b.name)) ||
        compare(a.name, b.name),
    )
  const hasUnobservableConstraintNames =
    hasExternalNamespace ||
    schemaRows.some(
      (entry) =>
        entry.type === 'table' &&
        entry.sql !== null &&
        hasSqlToken(entry.sql, 'CONSTRAINT'),
    )
  const constraintNameCoverage = hasUnobservableConstraintNames
    ? unknown('SQLite authored constraint names are not fully observable')
    : complete
  const constraintReservations: CatalogConstraintNameReservation[] = []
  const relations: CatalogRelation[] = []
  const byKey = (left: CatalogKeyConstraint, right: CatalogKeyConstraint) =>
    compareFact(left.name, right.name) ||
    compare(left.columns.join('\0'), right.columns.join('\0')) ||
    compare(JSON.stringify(left.semantics), JSON.stringify(right.semantics)) ||
    compare(JSON.stringify(left.validity), JSON.stringify(right.validity)) ||
    compare(JSON.stringify(left.nativeDefinition), JSON.stringify(right.nativeDefinition))
  const byIndex = (left: CatalogIndex, right: CatalogIndex) =>
    compareFact(left.name, right.name) ||
    compare(left.columns.join('\0'), right.columns.join('\0')) ||
    compare(String(left.unique), String(right.unique)) ||
    compare(JSON.stringify(left.semantics), JSON.stringify(right.semantics)) ||
    compare(JSON.stringify(left.nativeDefinition), JSON.stringify(right.nativeDefinition))
  const byOpaque = (left: OpaqueCatalogObject, right: OpaqueCatalogObject) =>
    compareFact(left.name, right.name) ||
    compare(left.kind, right.kind) ||
    compare(left.reason, right.reason) ||
    compare(JSON.stringify(left.nativeDefinition), JSON.stringify(right.nativeDefinition))

  for (const row of scopeRows) {
    if (row.name.startsWith('sqlite_')) continue

    const identity = scopeIdentity(row.name)
    const schema = schemaForTable(row.name)

    if (
      row.type !== 'table' &&
      row.type !== 'view' &&
      row.type !== 'virtual' &&
      row.type !== 'shadow'
    )
      throw new InvariantError(
        `Malformed SQLite table_list row: unsupported type ${JSON.stringify(row.type)}`,
      )

    if (row.type === 'table' && schema === undefined)
      throw new InvariantError(
        `SQLite table ${JSON.stringify(row.name)} is missing sqlite_schema definition`,
      )

    const nativeDefinition =
      schema?.sql === null || schema === undefined
        ? row.type === 'table'
          ? unsupported('SQLite table has no sqlite_schema definition')
          : absent
        : present(schema.sql)
    const tableKind =
      row.type === 'view'
        ? ('view' as const)
        : row.type === 'virtual'
          ? ('virtualTable' as const)
          : row.type === 'shadow'
            ? ('shadowTable' as const)
            : ('table' as const)
    let managed =
      row.type === 'table' &&
      row.wr === 0 &&
      row.strict === 0 &&
      schema?.sql !== null &&
      schema !== undefined
    const tableOpaque: OpaqueCatalogObject[] = []

    if (hasExternalNamespace) {
      managed = false

      tableOpaque.push({
        kind: 'other',
        name: absent,
        nativeDefinition: unknown(
          'Attached and temporary SQLite schema definitions were not fully observed',
        ),
        reason: 'Attached or temporary schema objects may depend on this relation',
      })
    }

    for (const dependency of [...viewObjects, ...triggerObjects]) {
      managed = false

      tableOpaque.push({
        kind: dependency.type === 'trigger' ? 'trigger' : 'other',
        name: present(dependency.name),
        nativeDefinition:
          dependency.sql === null
            ? unsupported(`SQLite ${dependency.type} has no native definition`)
            : present(dependency.sql),
        reason: `SQLite ${dependency.type} dependencies on this relation are not proven`,
      })
    }

    if (row.type === 'shadow' || row.type === 'virtual') {
      managed = false

      tableOpaque.push({
        kind: 'other',
        name: present(row.name),
        nativeDefinition,
        reason: `SQLite ${row.type} tables are not managed`,
      })
    }

    if (row.type === 'view') managed = false

    if (row.wr) {
      managed = false
    }

    if (row.strict) {
      managed = false
    }

    const options = [
      { name: 'strict', value: row.strict ? 'true' : 'false' },
      { name: 'withoutRowid', value: row.wr ? 'true' : 'false' },
    ]
    let table: CatalogTable | undefined

    if (row.type === 'table' || row.type === 'virtual' || row.type === 'shadow') {
      const columns = [...(xinfo.get(row.name) ?? [])].sort(
        (left, right) => left.cid - right.cid || compare(left.name, right.name),
      )

      if (columns.length !== row.ncol)
        throw new InvariantError(
          `SQLite table ${JSON.stringify(row.name)} table_list ncol does not match table_xinfo`,
        )

      if (columns.some((column, index) => column.cid !== index))
        throw new InvariantError(
          `SQLite table ${JSON.stringify(row.name)} table_xinfo cids must be contiguous`,
        )

      const seenCids = new Set<number>()
      const seenColumnNames = new Set<string>()
      const decodedColumns: CatalogColumn[] = []
      for (const column of columns) {
        if (seenCids.has(column.cid))
          throw new InvariantError(
            `Duplicate SQLite table_xinfo cid for ${JSON.stringify(row.name)}`,
          )

        const columnKey = identities.member('column', column.name).comparisonKey

        if (seenColumnNames.has(columnKey))
          throw new InvariantError(
            `Duplicate SQLite table_xinfo column for ${JSON.stringify(row.name)}`,
          )

        seenCids.add(column.cid)
        seenColumnNames.add(columnKey)
        const type: CatalogColumn['dataType'] = present({
          native: column.type,
          comparisonKey: normalizeSqliteDataType(column.type),
          family: normalizeSqliteDataType(column.type),
          parameters: [],
          userDefined: absent,
        })
        const columnNative = schema?.sql
          ? present(schema.sql)
          : unsupported('SQLite column definition is unavailable')
        const generated =
          column.hidden === 2 || column.hidden === 3
            ? unsupported(
                'SQLite generated column expression is not independently available',
              )
            : column.hidden === 1
              ? unsupported('SQLite hidden column is not managed')
              : absent

        if (column.hidden !== 0) managed = false

        const columnDefault =
          column.dflt_value === null ? absent : parseDefault(column.dflt_value)

        if (
          columnDefault.state === 'present' &&
          columnDefault.value.kind === 'nativeExpression'
        ) {
          managed = false

          tableOpaque.push({
            kind: 'other',
            name: present(column.name),
            nativeDefinition: present(columnDefault.value.native),
            reason: 'SQLite default expression cannot be compared portably',
          })
        }

        if ((row.type === 'virtual' || row.type === 'shadow') && column.hidden !== 0)
          tableOpaque.push({
            kind: 'other',
            name: present(column.name),
            nativeDefinition,
            reason: `SQLite ${row.type} hidden/generated column (hidden=${column.hidden}) is preserved as opaque evidence`,
          })

        decodedColumns.push({
          name: column.name,
          position: column.cid + 1,
          dataType: type,
          nullable: present(column.notnull !== 1),
          default: columnDefault,
          generation: generated,
          nativeDefinition: columnNative,
        })
      }

      const pks = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)

      if (pks.some((column, index) => column.pk !== index + 1))
        throw new InvariantError(
          `SQLite table ${JSON.stringify(row.name)} has non-contiguous primary-key ordinals`,
        )

      const indexes = indexLists.get(row.name)!
      const indexSeqs = indexes.map((index) => index.seq).sort((a, b) => a - b)

      if (indexSeqs.some((seq, position) => seq !== position))
        throw new InvariantError(
          `SQLite table ${JSON.stringify(row.name)} has non-contiguous index_list sequences`,
        )

      if (
        new Set(
          indexes.map((index) => identities.member('index', index.name).comparisonKey),
        ).size !== indexes.length
      )
        throw new InvariantError(
          `Duplicate SQLite index_list name on ${JSON.stringify(row.name)}`,
        )

      const pkIndexes = indexes.filter((index) => index.origin === 'pk')

      if (pkIndexes.length > 1)
        throw new InvariantError(
          `SQLite table ${JSON.stringify(row.name)} has multiple primary-key indexes`,
        )

      const pkIndex = pkIndexes[0]

      if (pkIndex && (pkIndex.unique !== 1 || pkIndex.partial !== 0))
        throw new InvariantError(
          `SQLite primary-key index on ${JSON.stringify(row.name)} has invalid flags`,
        )

      const rowidAlias =
        row.wr === 0 &&
        pks.length === 1 &&
        pks[0]!.type.toUpperCase() === 'INTEGER' &&
        pkIndex === undefined
      const createSql = schema?.sql ?? null
      const constraintName =
        createSql !== null && hasSqlToken(createSql, 'CONSTRAINT')
          ? unknown('SQLite does not expose authored constraint names')
          : absent

      if (constraintName.state === 'unknown') {
        managed = false

        tableOpaque.push({
          kind: 'constraint',
          name: constraintName,
          nativeDefinition,
          reason: 'SQLite authored constraint names are not exposed by catalog PRAGMAs',
        })
      }

      const unsupportedClauses = [
        hasSqlToken(createSql ?? '', 'COLLATE') && 'COLLATE',
        hasSqlTokens(createSql ?? '', ['ON', 'CONFLICT']) && 'ON CONFLICT',
        hasSqlToken(createSql ?? '', 'DEFERRABLE') && 'DEFERRABLE',
        hasSqlToken(createSql ?? '', 'INITIALLY') && 'INITIALLY',
        hasSqlToken(createSql ?? '', 'MATCH') && 'MATCH',
      ].filter((clause): clause is string => clause !== false)

      if (unsupportedClauses.length > 0) {
        managed = false

        tableOpaque.push({
          kind: 'other',
          name: absent,
          nativeDefinition,
          reason: `SQLite table clauses are not fully represented: ${unsupportedClauses.join(', ')}`,
        })
      }

      const autoIncrement =
        createSql === null ? false : hasSqlToken(createSql, 'AUTOINCREMENT')

      if (autoIncrement !== rowidAlias && autoIncrement) {
        managed = false

        tableOpaque.push({
          kind: 'other',
          name: absent,
          nativeDefinition,
          reason: 'AUTOINCREMENT does not describe an INTEGER rowid alias',
        })
      }

      const pkInfo = pkIndex ? (indexInfos.get(`${row.name}\0${pkIndex.name}`) ?? []) : []
      const pkTerms = pkInfo
        .filter((entry) => entry.key === 1)
        .sort((a, b) => a.seqno - b.seqno)
      const pkSimple =
        pks.length === 0 ||
        (pkIndex === undefined
          ? row.wr === 0
          : pkTerms.length === pks.length &&
            pkTerms.every(
              (entry, position) =>
                entry.cid === pks[position]!.cid &&
                entry.name === pks[position]!.name &&
                entry.desc === 0 &&
                entry.coll === 'BINARY',
            ))
      const pk: CatalogFact<CatalogKeyConstraint> =
        pks.length === 0
          ? absent
          : present({
              name: constraintName,
              columns: pks.map((column) => column.name),
              semantics: pkSimple
                ? present({ kind: 'simple' })
                : unsupported('SQLite primary key uses rich index semantics'),
              validity: present('valid'),
              nativeDefinition: createSql
                ? present(createSql)
                : unsupported('SQLite primary-key definition is unavailable'),
            })

      if (!pkSimple) managed = false

      if (rowidAlias) {
        const column = decodedColumns.find((entry) => entry.name === pks[0]!.name)!
        decodedColumns[columns.indexOf(pks[0]!)!] = {
          ...column,
          nullable: present(false),
          generation: present({ kind: 'rowidAlias', autoIncrement }),
        }
      }

      const uniqueConstraints: CatalogKeyConstraint[] = []
      const catalogIndexes: CatalogIndex[] = []
      for (const index of indexes) {
        const info = indexInfos.get(`${row.name}\0${index.name}`)!
        const seqnos = info.map((entry) => entry.seqno).sort((a, b) => a - b)

        if (seqnos.some((seqno, position) => seqno !== position))
          throw new InvariantError(
            `SQLite index ${JSON.stringify(index.name)} has non-contiguous index_xinfo seqnos`,
          )

        const keyEntries = info
          .filter((entry) => entry.key === 1)
          .sort((a, b) => a.seqno - b.seqno)

        if (keyEntries.some((entry, position) => entry.seqno !== position))
          throw new InvariantError(
            `SQLite index ${JSON.stringify(index.name)} has non-contiguous key index_xinfo seqnos`,
          )

        const columnsForIndex: string[] = []
        let simple = index.partial === 0

        for (const auxiliary of info.filter((entry) => entry.key === 0)) {
          if (
            auxiliary.cid < -2 ||
            auxiliary.cid === -2 ||
            (auxiliary.cid === -1 && auxiliary.name !== null) ||
            (auxiliary.cid >= 0 && auxiliary.name === null)
          )
            throw new InvariantError(
              `SQLite index ${JSON.stringify(index.name)} has malformed auxiliary index_xinfo row`,
            )
        }

        for (const entry of keyEntries) {
          if (entry.cid === -1)
            throw new InvariantError(
              `SQLite index ${JSON.stringify(index.name)} has a rowid auxiliary marked as a key term`,
            )

          if (entry.cid === -2 && entry.name !== null)
            throw new InvariantError(
              `SQLite index ${JSON.stringify(index.name)} has a malformed expression term`,
            )

          if (entry.cid < -2)
            throw new InvariantError(
              `SQLite index ${JSON.stringify(index.name)} has an invalid column id`,
            )

          if (entry.cid < 0 || entry.name === null) {
            simple = false
            continue
          }

          const referencedColumn = columns.find((column) => column.cid === entry.cid)

          if (referencedColumn === undefined || referencedColumn.name !== entry.name)
            throw new InvariantError(
              `SQLite index ${JSON.stringify(index.name)} references a missing or mismatched column`,
            )

          columnsForIndex.push(entry.name)

          if (entry.desc !== 0 || entry.coll !== 'BINARY') simple = false
        }

        if (keyEntries.length === 0) simple = false

        const indexSql =
          schemaRows.find(
            (entry) =>
              entry.type === 'index' &&
              identities.member('index', entry.name).comparisonKey ===
                identities.member('index', index.name).comparisonKey,
          )?.sql ?? null

        if (index.origin === 'c') {
          if (indexSql === null)
            throw new InvariantError(
              `SQLite user index ${JSON.stringify(index.name)} is missing sqlite_schema definition`,
            )

          catalogIndexes.push({
            name: present(index.name),
            origin: 'user',
            columns: columnsForIndex,
            unique: index.unique === 1,
            semantics: simple
              ? present({ kind: 'simple' })
              : unsupported(
                  'SQLite index uses expression, collation, ordering, or partial semantics',
                ),
            validity: present('valid'),
            nativeDefinition: present(indexSql),
          })

          if (!simple) managed = false
        } else if (index.origin === 'u') {
          uniqueConstraints.push({
            name: constraintName,
            columns: columnsForIndex,
            semantics: simple
              ? present({ kind: 'simple' })
              : unsupported('SQLite UNIQUE constraint uses unsupported index semantics'),
            validity: present('valid'),
            nativeDefinition: createSql
              ? present(createSql)
              : unsupported('SQLite UNIQUE constraint definition is unavailable'),
          })

          if (!simple) managed = false
        }
      }

      const fks: CatalogForeignKey[] = []
      const grouped = new Map<number, ForeignKeyRow[]>()
      for (const fk of foreignKeys.get(row.name)!) {
        const group = grouped.get(fk.id) ?? []
        group.push(fk)
        grouped.set(fk.id, group)
      }

      for (const group of grouped.values()) {
        group.sort((a, b) => a.seq - b.seq)

        if (group.some((entry, position) => entry.seq !== position))
          throw new InvariantError(
            `SQLite foreign-key group on ${JSON.stringify(row.name)} has non-contiguous sequence`,
          )

        const first = group[0]!
        const onDelete = action(first.on_delete, 'foreign_key_list', 0)
        const onUpdate = action(first.on_update, 'foreign_key_list', 0)

        if (
          group.some(
            (entry) =>
              entry.table !== first.table ||
              entry.on_delete.toLowerCase() !== first.on_delete.toLowerCase() ||
              entry.on_update.toLowerCase() !== first.on_update.toLowerCase() ||
              entry.match.toLowerCase() !== first.match.toLowerCase(),
          )
        )
          throw new InvariantError(
            `SQLite foreign-key group on ${JSON.stringify(row.name)} is inconsistent`,
          )

        const sourceColumns = group.map((entry) => {
          const source = columns.find(
            (column) =>
              identities.member('column', column.name).comparisonKey ===
              identities.member('column', entry.from).comparisonKey,
          )

          if (source === undefined)
            throw new InvariantError(
              `SQLite foreign key on ${JSON.stringify(row.name)} references a missing source column`,
            )

          return source.name
        })

        const targetTable = mainTables.find(
          (candidate) =>
            scopeIdentity(candidate.name).relation.comparisonKey ===
            scopeIdentity(first.table).relation.comparisonKey,
        )
        const targetIdentity = scopeIdentity(targetTable?.name ?? first.table)
        const requestedTargetColumns = group.map((entry) => entry.to)
        const targetInfo =
          targetTable === undefined
            ? undefined
            : xinfo
                .get(targetTable.name)
                ?.slice()
                .sort((left, right) => left.cid - right.cid)
        const explicitTargetColumns = requestedTargetColumns.every(
          (entry): entry is string => entry !== null,
        )
        const parentPrimaryKey = (targetInfo ?? [])
          .filter((column) => column.pk > 0)
          .sort((left, right) => left.pk - right.pk)
          .map((column) => column.name)
        const targetColumns = explicitTargetColumns
          ? requestedTargetColumns.map((targetColumn) => {
              const parentColumn = targetInfo?.find(
                (column) =>
                  identities.member('column', column.name).comparisonKey ===
                  identities.member('column', targetColumn).comparisonKey,
              )

              return parentColumn?.name ?? targetColumn
            })
          : parentPrimaryKey
        const targetColumnsObserved =
          targetInfo !== undefined &&
          targetColumns.length === group.length &&
          targetColumns.every((targetColumn) =>
            targetInfo.some(
              (column) =>
                identities.member('column', column.name).comparisonKey ===
                identities.member('column', targetColumn).comparisonKey,
            ),
          )
        const keyIndexes = targetTable ? (indexLists.get(targetTable.name) ?? []) : []
        const simpleUniqueKeys: string[][] = []
        let matchingRichUniqueKey = false

        if (targetTable !== undefined && targetInfo !== undefined) {
          for (const index of keyIndexes.filter(
            (candidate) => candidate.origin !== 'pk' && candidate.unique === 1,
          )) {
            if (index.partial !== 0) continue

            const indexInfo = indexInfos.get(`${targetTable.name}\0${index.name}`) ?? []
            const keyInfo = indexInfo
              .filter((entry) => entry.key === 1)
              .sort((left, right) => left.seqno - right.seqno)
            const keyColumns = keyInfo.flatMap((entry) =>
              entry.cid >= 0 && entry.name !== null ? [entry.name] : [],
            )

            if (!sameColumnIdentities(targetColumns, keyColumns, identities)) continue

            if (
              keyColumns.length === keyInfo.length &&
              keyInfo.every((entry) => entry.desc === 0 && entry.coll === 'BINARY')
            ) {
              simpleUniqueKeys.push(keyColumns)
            } else {
              matchingRichUniqueKey = true
            }
          }
        }

        const matchesPrimaryKey = sameColumnIdentities(
          targetColumns,
          parentPrimaryKey,
          identities,
        )
        const targetKeyValid =
          targetColumnsObserved &&
          targetTable?.type === 'table' &&
          (matchesPrimaryKey || simpleUniqueKeys.length > 0)
        const targetKeyUnknown =
          targetTable === undefined ||
          (targetTable.type !== 'view' && targetInfo === undefined) ||
          (targetTable?.type === 'table' && matchingRichUniqueKey)
        const fkSimple =
          targetKeyValid &&
          targetTable?.type === 'table' &&
          first.match.toLowerCase() === 'none' &&
          targetColumnsObserved
        fks.push({
          name: constraintName,
          columns: sourceColumns,
          semantics: fkSimple
            ? present({ kind: 'simple' })
            : unsupported(
                'SQLite foreign key has implicit target columns or rich match semantics',
              ),
          validity: targetKeyValid
            ? present('valid')
            : targetKeyUnknown
              ? unknown('SQLite referenced parent key facts are unavailable')
              : present('invalid'),
          nativeDefinition: createSql
            ? present(createSql)
            : unsupported('SQLite foreign-key definition is unavailable'),
          referencedRelation: targetIdentity,
          referencedColumns: targetColumns,
          onDelete,
          onUpdate,
        })

        if (!fkSimple) managed = false
      }

      if (createSql !== null && hasSqlToken(createSql, 'CHECK')) {
        tableOpaque.push({
          kind: 'constraint',
          name: constraintName,
          nativeDefinition: present(createSql),
          reason: 'SQLite CHECK constraint is preserved as opaque table SQL',
        })

        managed = false
      }

      table = {
        columns: {
          items: decodedColumns.sort(
            (a, b) => a.position - b.position || compare(a.name, b.name),
          ),
          coverage: complete,
        },
        primaryKey: pk,
        uniqueConstraints: { items: uniqueConstraints.sort(byKey), coverage: complete },
        foreignKeys: {
          items: fks.sort(
            (a, b) =>
              identities.compare(a.referencedRelation, b.referencedRelation) ||
              compare(
                relationSpelling(a.referencedRelation),
                relationSpelling(b.referencedRelation),
              ) ||
              compare(a.columns.join('\0'), b.columns.join('\0')) ||
              compare(a.referencedColumns.join('\0'), b.referencedColumns.join('\0')) ||
              compare(a.onDelete, b.onDelete) ||
              compare(a.onUpdate, b.onUpdate) ||
              compare(JSON.stringify(a.name), JSON.stringify(b.name)) ||
              compare(JSON.stringify(a.semantics), JSON.stringify(b.semantics)) ||
              compare(JSON.stringify(a.validity), JSON.stringify(b.validity)) ||
              compare(
                JSON.stringify(a.nativeDefinition),
                JSON.stringify(b.nativeDefinition),
              ) ||
              compare(JSON.stringify(a), JSON.stringify(b)),
          ),
          coverage: complete,
        },
        indexes: { items: catalogIndexes.sort(byIndex), coverage: complete },
        options: { items: options, coverage: complete },
        opaqueObjects: {
          items: tableOpaque.sort(byOpaque),
          coverage: hasExternalNamespace
            ? {
                state: 'partial',
                remainder: unknown(
                  'Attached and temporary SQLite opaque dependencies are not fully observable',
                ),
              }
            : complete,
        },
      }
    }

    relations.push({
      identity,
      kind: tableKind,
      persistence: 'permanent',
      owner: unsupportedByEngine('SQLite has no relation owner'),
      management: managed ? 'managed' : 'unmanaged',
      nativeDefinition,
      table: table === undefined ? absent : present(table),
    })
  }

  relations.sort((a, b) => identities.compare(a.identity, b.identity))
  const namespace: CatalogNamespace = {
    identity: identities.resolveNamespace(mainNamespace),
    owner: unsupportedByEngine('SQLite has no namespace owner'),
    relations: {
      items: relations,
      coverage: completeMain
        ? complete
        : {
            state: 'partial',
            remainder: unmanaged(
              'Relations outside the requested catalog scope are unmanaged',
            ),
          },
    },
  }
  return {
    source: { dialect: 'sqlite', version },
    request: resolvedRequest,
    capabilities: {
      namespaces: { state: 'supported', fidelity: 'native' },
      relationOwner: {
        state: 'unsupported',
        by: 'engine',
        reason: 'SQLite has no relation owner',
      },
      identity: { state: 'supported', fidelity: 'native' },
      richObjects: { state: 'supported', fidelity: 'opaque' },
    },
    namespaceContext,
    namespaces: { items: [namespace], coverage: complete },
    nameReservations: { items: uniqueNames, coverage: complete },
    constraintNameReservations: {
      items: constraintReservations,
      coverage: constraintNameCoverage,
    },
    diagnostics: diagnostics.sort(
      (a, b) => compare(a.code, b.code) || compare(a.message, b.message),
    ),
  }
}

export const sqliteCatalog: CatalogIntrospector = { introspectCatalog: introspectSqlite }
