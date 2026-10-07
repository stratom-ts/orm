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
  CanonicalRelationIdentityModule,
} from '@/migrations/canonicalRelationIdentity'
import type { ReferentialAction } from '@/schemas/actions/types'
import { InvariantError } from '@/utils/error'

import { isSqliteDefaultLiteral, trimSqliteWhitespace } from './defaults'
import { asciiFoldSqliteIdentifier, sqliteIdentity } from './identity'
import { normalizeSqliteDataType, normalizeSqliteDefaultExpression } from './normalize'
import { assertSafeSqliteDefaultExpression } from './validate'

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

/** Wraps a decoded value as present catalog evidence. */
function present<T>(value: T): CatalogFact<T> {
  return { state: 'present', value }
}

/** Records adapter-level unsupported catalog evidence with its reason. */
function unsupported(reason: string): CatalogNoEvidence {
  return { state: 'unsupported', by: 'adapter', reason }
}

/** Records a feature that the database engine cannot expose. */
function unsupportedByEngine(reason: string): CatalogNoEvidence {
  return { state: 'unsupported', by: 'engine', reason }
}

/** Records catalog evidence outside the requested migration authority. */
function unmanaged(reason: string): CatalogNoEvidence {
  return { state: 'unmanaged', reason }
}

/** Records a catalog fact whose value cannot be established safely. */
function unknown(reason: string): CatalogNoEvidence {
  return { state: 'unknown', reason }
}

/** Orders canonical identities using locale-independent code-unit comparisons. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Reads the authored relation spelling from canonical identity.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns The authored relation spelling after namespace support checks.
 */
function relationSpelling(identity: CanonicalRelationIdentity): string {
  const namespace = identity.namespace
    .map((segment) => `${segment.role}:${segment.identifier.spelling}`)
    .join('\0')

  return `${namespace}\0${identity.relation.spelling}`
}

/**
 * Serializes catalog observations with stable object-key ordering.
 *
 * @param value - Runtime value to validate, normalize, or map.
 *
 * @returns An order-normalized serialization used to compare repeated native
 *   observations.
 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).sort(compare).join(',')}]`

  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`
  }

  return String(JSON.stringify(typeof value === 'bigint' ? value.toString() : value))
}

/** Gives malformed native rows a stable position before decoding diagnostics. */
function stableRows(rows: unknown[]): unknown[] {
  return [...rows].sort((left, right) => compare(stable(left), stable(right)))
}

/** Validates the shape of one native catalog query row. */
function rowAt(value: unknown, query: string, index: number): Row {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvariantError(`Malformed SQLite ${query} row ${index}: expected an object`)
  }

  return value as Row
}

/**
 * Reads a required nonempty string and reports malformed catalog fields.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param key - Native row field or identity component being addressed.
 * @param query - Native query label used to identify malformed catalog evidence.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 *
 * @returns The validated non-empty native string field.
 */
function stringAt(row: Row, key: string, query: string, index: number): string {
  const value = row[key]

  if (typeof value !== 'string' || value.length === 0) {
    throw new InvariantError(
      `Malformed SQLite ${query} row ${index}: ${JSON.stringify(key)} must be a non-empty string`,
    )
  }

  return value
}

/**
 * Reads a string-or-null catalog field without treating missing evidence as absence.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param key - Native row field or identity component being addressed.
 * @param query - Native query label used to identify malformed catalog evidence.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 *
 * @returns The validated native string or null field.
 */
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

/**
 * Reads an integer catalog field within the required lower bound.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param key - Native row field or identity component being addressed.
 * @param query - Native query label used to identify malformed catalog evidence.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 *
 * @returns The validated integer field; malformed or unsafe values throw.
 */
function integerAt(row: Row, key: string, query: string, index: number): number {
  const value = row[key]

  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new InvariantError(
      `Malformed SQLite ${query} row ${index}: ${JSON.stringify(key)} must be an integer`,
    )
  }

  return value
}

/**
 * Validates and decodes a native SQLite zero-or-one flag.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param key - Native row field or identity component being addressed.
 * @param query - Native query label used to identify malformed catalog evidence.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 *
 * @returns The validated native boolean flag.
 */
function flagAt(row: Row, key: string, query: string, index: number): number {
  const value = integerAt(row, key, query, index)

  if (value !== 0 && value !== 1) {
    throw new InvariantError(
      `Malformed SQLite ${query} row ${index}: ${JSON.stringify(key)} must be 0 or 1`,
    )
  }

  return value
}

/**
 * Compares namespace roles and canonical identifier keys positionally.
 *
 * @param left - Left operand or identity in the comparison.
 * @param right - Right operand or identity in the comparison.
 *
 * @returns True when both namespaces have equal role-tagged canonical identifiers.
 */
function sameNamespace(
  left: readonly CanonicalNamespaceSegment[],
  right: readonly CanonicalNamespaceSegment[],
) {
  return (
    left.length === right.length &&
    left.every((segment, index) => {
      const other = right.at(index)!
      return (
        segment.role === other.role &&
        segment.identifier.comparisonKey === other.identifier.comparisonKey
      )
    })
  )
}

/**
 * Orders canonical namespaces by their roles and identifier comparison keys.
 *
 * @param left - Left operand or identity in the comparison.
 * @param right - Right operand or identity in the comparison.
 *
 * @returns A negative, zero, or positive value for canonical namespace order.
 */
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

/** Builds a structured authored relation from its native namespace spelling. */
function relationInput(database: string, relation: string) {
  return { namespace: [{ role: 'database' as const, spelling: database }], relation }
}

/**
 * Resolves and deduplicates requested relations and namespace ownership under one
 * identity policy.
 *
 * @param request - Requested relations, declared absences, and completely owned
 *   namespaces.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns And deduplicates requested relations and namespace ownership under one
 *   identity policy.
 */
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
    .sort((left, right) => identities.compare(left, right))

  const completeNamespaces = request.completeNamespaces
    .map((namespace) => identities.resolveNamespace(namespace))
    .filter(
      (namespace, index, values) =>
        values.findIndex((candidate) => sameNamespace(candidate, namespace)) === index,
    )
    .sort(compareNamespaces)

  return { relations, absentRelations, completeNamespaces }
}

/**
 * Orders catalog facts by stable serialized evidence.
 *
 * @param left - Left operand or identity in the comparison.
 * @param right - Right operand or identity in the comparison.
 *
 * @returns A negative, zero, or positive value for deterministic catalog-fact order.
 */
function compareFact(left: CatalogFact<string>, right: CatalogFact<string>): number {
  const state = compare(left.state, right.state)

  if (state) return state

  if (left.state === 'present' && right.state === 'present')
    return compare(left.value, right.value)

  return compare(JSON.stringify(left), JSON.stringify(right))
}

/**
 * Tests whether a resolved catalog request covers a relation.
 *
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 * @param request - Requested relations, declared absences, and completely owned
 *   namespaces.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns True when a resolved catalog request covers a relation.
 */
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

/** Tests whether a canonical relation belongs to SQLite's main database. */
function isMain(identity: CanonicalRelationIdentity): boolean {
  return (
    identity.namespace.length === 1 &&
    identity.namespace[0]?.role === 'database' &&
    identity.namespace[0].identifier.comparisonKey === 'main'
  )
}

/**
 * Decodes supported SQLite defaults and preserves unrecognized expressions as opaque
 * evidence.
 *
 * @param raw - Native SQL default expression before decoding.
 *
 * @returns Portable default evidence retaining unsupported native expressions explicitly.
 */
function parseDefault(
  raw: string,
): CatalogFact<
  NonNullable<CatalogColumn['default'] extends CatalogFact<infer T> ? T : never>
> {
  const value = trimSqliteWhitespace(raw)

  if (isSqliteDefaultLiteral(value))
    return present({
      kind: 'literal',
      native: raw,
      comparisonKey: present(normalizeSqliteDefaultExpression(value)),
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

/**
 * Finds the end of a quoted SQL token while honoring doubled quote escapes.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 * @param close - Closing quote character or callback that releases the owned resource.
 * @param doubledClose - Whether doubled closing quotes escape the quote inside this
 *   token.
 * @param description - Diagnostic label that identifies invalid input.
 *
 * @returns The position after the closing quote, or the scanner's malformed-input
 *   boundary.
 */
function quotedSqlEnd(
  sql: string,
  index: number,
  close: string,
  doubledClose: boolean,
  description: string,
): number {
  let cursor = index + 1

  while (cursor < sql.length) {
    if (sql[cursor] !== close) {
      cursor++
      continue
    }

    if (doubledClose && sql[cursor + 1] === close) {
      cursor += 2
      continue
    }

    return cursor + 1
  }

  throw new InvariantError(`Malformed SQLite schema SQL: unterminated ${description}`)
}

/** A quote/comment-aware scanner for unquoted CREATE TABLE SQL token sequences. */
// oxlint-disable-next-line complexity
function hasSqlTokens(sql: string, wanted: readonly string[]): boolean {
  const tokens: string[] = tokenizeSqliteSql(sql)
  return tokens.some((_, index) =>
    wanted.every((part, offset) => tokens[index + offset] === part),
  )
}

/**
 * Collects unquoted SQL tokens while skipping quoted text and comments.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 *
 * @returns SQL tokens used to classify native clauses without interpreting quoted text as
 *   syntax.
 */
function tokenizeSqliteSql(sql: string) {
  let index = 0
  const collector = createSqlTokenCollector()

  while (index < sql.length) {
    const character = sql[index]!
    const blockCommentEnd =
      character === '/' && sql[index + 1] === '*' ? sql.indexOf('*/', index + 2) : null

    if (blockCommentEnd === -1) {
      throw new InvariantError('Malformed SQLite schema SQL: unterminated block comment')
    }

    if (character === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index + 2)
      index = end < 0 ? sql.length : end + 1
      collector.flush()
      continue
    }

    if (blockCommentEnd !== null) {
      index = blockCommentEnd + 2
      collector.flush()
      continue
    }

    if (character === "'") {
      collector.flush()
      index = quotedSqlEnd(sql, index, "'", true, 'string')
      continue
    }

    if (character === '"' || character === '`' || character === '[') {
      collector.flush()
      const close = character === '[' ? ']' : character
      index = quotedSqlEnd(sql, index, close, close !== ']', 'quoted identifier')
      continue
    }

    if (/[A-Za-z0-9_]/.test(character)) collector.append(character)
    else collector.flush()

    index++
  }

  collector.flush()
  return collector.tokens
}

/** Tests for an unquoted SQL token outside strings and comments. */
function hasSqlToken(sql: string, wanted: string): boolean {
  return hasSqlTokens(sql, [wanted])
}

/**
 * Validates a native foreign-key action and maps it to the portable catalog model.
 *
 * @param value - Runtime value to validate, normalize, or map.
 * @param query - Native query label used to identify malformed catalog evidence.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 *
 * @returns The portable referential action corresponding to the validated native
 *   spelling.
 */
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

/**
 * Compares candidate-key membership while rejecting repeated canonical columns.
 *
 * @param left - Left operand or identity in the comparison.
 * @param right - Right operand or identity in the comparison.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns True for the same unique columns regardless of FK target order.
 */
function sameCandidateKeyColumns(
  left: readonly string[],
  right: readonly string[],
  identities: ReturnType<typeof sqliteIdentity.create>,
): boolean {
  const leftKeys = left
    .map((column) => identities.member('column', column).comparisonKey)
    .sort()

  const rightKeys = right
    .map((column) => identities.member('column', column).comparisonKey)
    .sort()

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (column, index) => column === rightKeys[index] && column !== leftKeys[index - 1],
    )
  )
}

/**
 * Validates SQLite table_list rows before catalog assembly.
 *
 * @param rows - Ordered native observations or result rows to process.
 *
 * @returns Validated SQLite table-list observations with canonical native identities.
 */
function decodeTableRows(rows: unknown[]): TableRow[] {
  return stableRows(rows).map((value, index) => {
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

/**
 * Validates native sqlite_schema object identities and definitions.
 *
 * @param rows - Ordered native observations or result rows to process.
 *
 * @returns Validated native SQLite schema definitions and object identities.
 */
function decodeSchemaRows(rows: unknown[]): SchemaRow[] {
  return stableRows(rows).map((value, index) => {
    const row = rowAt(value, 'sqlite_schema', index)
    return {
      type: stringAt(row, 'type', 'sqlite_schema', index),
      name: stringAt(row, 'name', 'sqlite_schema', index),
      tbl_name: stringAt(row, 'tbl_name', 'sqlite_schema', index),
      sql: nullableStringAt(row, 'sql', 'sqlite_schema', index),
    }
  })
}

/**
 * Decodes table_xinfo rows into validated column observations.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param table - Table metadata or evidence used to resolve its members.
 *
 * @returns Table_xinfo rows into validated column observations.
 */
function decodeXInfoRows(rows: unknown[], table: string): XInfoRow[] {
  return stableRows(rows).map((value, index) => {
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

/**
 * Decodes a table's index-list rows into validated index observations.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param table - Table metadata or evidence used to resolve its members.
 *
 * @returns A table's index-list rows into validated index observations.
 */
function decodeIndexListRows(rows: unknown[], table: string): IndexListRow[] {
  return stableRows(rows).map((value, index) => {
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

/**
 * Decodes index_xinfo rows and validates their native member fields.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param table - Table metadata or evidence used to resolve its members.
 * @param indexName - Physical index spelling used for native member lookup.
 *
 * @returns Index_xinfo rows and validates their native member fields.
 */
function decodeIndexInfoRows(
  rows: unknown[],
  table: string,
  indexName: string,
): IndexInfoRow[] {
  return stableRows(rows).map((value, index) => {
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

/**
 * Decodes foreign-key PRAGMA rows without losing composite-key order.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param table - Table metadata or evidence used to resolve its members.
 *
 * @returns Foreign-key PRAGMA rows without losing composite-key order.
 */
function decodeForeignKeyRows(rows: unknown[], table: string): ForeignKeyRow[] {
  return stableRows(rows).map((value, index) => {
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
  /** Reads validated column observations for a catalog table. */
  xinfo: (table: string) => ({
    sql: 'select cid, name, type, "notnull" as column_notnull, dflt_value, pk, hidden from pragma_table_xinfo(?, ?) order by cid, name',
    params: [table, 'main'],
  }),
  /** Reads validated index-list observations for a catalog table. */
  indexes: (table: string) => ({
    sql: 'select seq, name, "unique", origin, partial from pragma_index_list(?, ?) order by seq, name',
    params: [table, 'main'],
  }),
  /** Reads validated native members for one observed index. */
  indexInfo: (indexName: string) => ({
    sql: 'select seqno, cid, name, "desc", coll, "key" from pragma_index_xinfo(?, ?) order by seqno, cid, name',
    params: [indexName, 'main'],
  }),
  /** Reads validated native foreign-key observations for a catalog table. */
  foreignKeys: (table: string) => ({
    sql: 'select id, seq, "table", "from", "to", on_update, on_delete, "match" from pragma_foreign_key_list(?, ?) order by id, seq',
    params: [table, 'main'],
  }),
}

/**
 * Finds the native schema definition associated with one table.
 *
 * @param schemaRows - Native sqlite_schema definitions used to verify relation and index
 *   evidence.
 * @param name - Physical identifier or dialect label used by this operation.
 *
 * @returns The unique matching schema definition, or undefined when the table is absent.
 */
function schemaForTable(
  schemaRows: readonly SchemaRow[],
  name: string,
): SchemaRow | undefined {
  return schemaRows.find(
    (row) =>
      (row.type === 'table' || row.type === 'view') &&
      asciiFoldSqliteIdentifier(row.name) === asciiFoldSqliteIdentifier(name),
  )
}

/**
 * Checks requested schema relations against observed main-database tables.
 *
 * @param schemaRows - Native sqlite_schema definitions used to verify relation and index
 *   evidence.
 * @param mainTables - Validated ordinary tables observed in SQLite's main database.
 * @param resolvedRequest - Requested scope after canonical identity and namespace
 *   resolution.
 * @param identities - Canonical identity operations for the resolved namespace context.
 */
function validateSchemaRelations(
  schemaRows: readonly SchemaRow[],
  mainTables: readonly TableRow[],
  resolvedRequest: ResolvedCatalogRequest,
  identities: ReturnType<typeof sqliteIdentity.create>,
  errors: Map<string, string>,
): void {
  /** Resolves a native relation name under the current catalog namespace. */
  const scopeIdentity = (name: string) => identities.resolve(relationInput('main', name))
  const completeMain = resolvedRequest.completeNamespaces.some((entry) =>
    sameNamespace(entry, identities.resolveNamespace(mainNamespace)),
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

    const owner =
      schemaRow.type === 'table' || schemaRow.type === 'view'
        ? schemaRow.name
        : schemaRow.tbl_name

    const observedOwner = mainTables.find(
      (table) =>
        scopeIdentity(table.name).relation.comparisonKey ===
        scopeIdentity(owner).relation.comparisonKey,
    )

    if (!observedOwner) {
      assertSqliteSchemaRelation(schemaRow, mainTables, scopeIdentity)
      continue
    }

    decodeTableObservation(observedOwner.name, errors, () =>
      assertSqliteSchemaRelation(schemaRow, mainTables, scopeIdentity),
    )
  }
}

/** Checks schema names and requested relations against table_list evidence. */
function validateSchemaRows(
  schemaRows: readonly SchemaRow[],
  mainTables: readonly TableRow[],
  resolvedRequest: ResolvedCatalogRequest,
  identities: ReturnType<typeof sqliteIdentity.create>,
  errors: Map<string, string>,
): void {
  /** Resolves a native relation name under the current catalog namespace. */
  const scopeIdentity = (name: string) => identities.resolve(relationInput('main', name))
  const completeMain = resolvedRequest.completeNamespaces.some((entry) =>
    sameNamespace(entry, identities.resolveNamespace(mainNamespace)),
  )

  assertUniqueSchemaNames(schemaRows)

  validateSchemaRelations(schemaRows, mainTables, resolvedRequest, identities, errors)

  for (const tableRow of mainTables) {
    if (
      tableRow.name.startsWith('sqlite_') ||
      (!completeMain &&
        !relationRequested(scopeIdentity(tableRow.name), resolvedRequest, identities))
    )
      continue

    const schemaRow = schemaForTable(schemaRows, tableRow.name)

    if (schemaRow === undefined) {
      errors.set(
        tableRow.name,
        `SQLite ${tableRow.type} relation ${JSON.stringify(tableRow.name)} is missing sqlite_schema definition`,
      )

      continue
    }

    const expectedSchemaType = tableRow.type === 'view' ? 'view' : 'table'

    if (schemaRow.type !== expectedSchemaType)
      errors.set(
        tableRow.name,
        `SQLite table_list relation ${JSON.stringify(tableRow.name)} type ${JSON.stringify(tableRow.type)} disagrees with sqlite_schema type ${JSON.stringify(schemaRow.type)}`,
      )
  }
}

/**
 * Rejects schema objects with duplicate SQLite comparison keys.
 *
 * @param schemaRows - Native sqlite_schema definitions used to verify relation and index
 *   evidence.
 */
function assertUniqueSchemaNames(schemaRows: readonly SchemaRow[]) {
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
}

/** Checks table indexes against their schema definitions. */
function validateOwnerIndexes(
  owner: TableRow,
  indexes: readonly IndexListRow[],
  schemaRows: readonly SchemaRow[],
  identities: ReturnType<typeof sqliteIdentity.create>,
): void {
  /** Resolves a native relation name under the current catalog namespace. */
  const scopeIdentity = (name: string) => identities.resolve(relationInput('main', name))
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

/** Collects reserved names and determines constraint name coverage. */
function collectNameReservations(
  schemaRows: readonly SchemaRow[],
  mainTables: readonly TableRow[],
  reservationIndexLists: ReadonlyMap<string, readonly IndexListRow[]>,
  identities: ReturnType<typeof sqliteIdentity.create>,
  hasExternalNamespace: boolean,
) {
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

  const uniqueNames = normalizeNameReservations(names)

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

  return { names: uniqueNames, constraintNameCoverage }
}

/**
 * Sorts and deduplicates physical names under SQLite identifier rules.
 *
 * @param names - Mutable set of local binding names used for dependency detection.
 *
 * @returns Physical-name reservations in deterministic identity order.
 */
function normalizeNameReservations(names: CatalogNameReservation[]) {
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

  return uniqueNames
}

/** Determines initial relation management and preserves opaque dependencies. */
function initialRelationManagement(
  row: TableRow,
  schema: SchemaRow | undefined,
  nativeDefinition: CatalogRelation['nativeDefinition'],
  hasExternalNamespace: boolean,
  dependencies: readonly SchemaRow[],
) {
  let initialManaged =
    row.type === 'table' &&
    row.wr === 0 &&
    row.strict === 0 &&
    schema?.sql !== null &&
    schema !== undefined
  const opaque: OpaqueCatalogObject[] = []

  initialManaged = collectSqliteDependencyEvidence(
    hasExternalNamespace,
    initialManaged,
    opaque,
    dependencies,
  )

  initialManaged = classifySqliteRelationManagement(
    row,
    initialManaged,
    opaque,
    nativeDefinition,
  )

  return { managed: initialManaged, opaque }
}

/**
 * Preserves views and triggers that prevent complete table management.
 *
 * @param hasExternalNamespace - Whether attached or temporary namespaces prevent complete
 *   main-database management.
 * @param initialManaged - Management status established before member and dependency
 *   evidence.
 * @param opaque - Mutable evidence for native objects outside the supported portable
 *   model.
 * @param dependencies - Action prerequisites or observed views and triggers that affect
 *   management.
 *
 * @returns True when collect sqlite dependency evidence applies to the supplied input.
 */
function collectSqliteDependencyEvidence(
  hasExternalNamespace: boolean,
  initialManaged: boolean,
  opaque: OpaqueCatalogObject[],
  dependencies: readonly SchemaRow[],
) {
  if (hasExternalNamespace) {
    initialManaged = false

    opaque.push({
      kind: 'other',
      name: absent,
      nativeDefinition: unknown(
        'Attached and temporary SQLite schema definitions were not fully observed',
      ),
      reason: 'Attached or temporary schema objects may depend on this relation',
    })
  }

  for (const dependency of dependencies) {
    initialManaged = false

    opaque.push({
      kind: dependency.type === 'trigger' ? 'trigger' : 'other',
      name: present(dependency.name),
      nativeDefinition:
        dependency.sql === null
          ? unsupported(`SQLite ${dependency.type} has no native definition`)
          : present(dependency.sql),
      reason: `SQLite ${dependency.type} dependencies on this relation are not proven`,
    })
  }

  return initialManaged
}

/**
 * Marks unsupported native table kinds and options as unmanaged evidence.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param initialManaged - Management status established before member and dependency
 *   evidence.
 * @param opaque - Mutable evidence for native objects outside the supported portable
 *   model.
 * @param nativeDefinition - Present, absent, or unsupported evidence for the native SQL
 *   definition.
 *
 * @returns True when classify sqlite relation management applies to the supplied input.
 */
function classifySqliteRelationManagement(
  row: TableRow,
  initialManaged: boolean,
  opaque: OpaqueCatalogObject[],
  nativeDefinition: CatalogFact<string>,
) {
  if (row.type === 'shadow' || row.type === 'virtual') {
    initialManaged = false

    opaque.push({
      kind: 'other',
      name: present(row.name),
      nativeDefinition,
      reason: `SQLite ${row.type} tables are not managed`,
    })
  }

  if (row.type === 'view' || row.wr || row.strict) initialManaged = false

  return initialManaged
}

/** Decodes column facts and preserves evidence outside the managed profile. */
function decodeCatalogColumns(
  row: TableRow,
  schema: SchemaRow | undefined,
  observedColumns: readonly XInfoRow[],
  nativeDefinition: CatalogRelation['nativeDefinition'],
  identities: ReturnType<typeof sqliteIdentity.create>,
) {
  let managed = true
  const opaque: OpaqueCatalogObject[] = []
  const columns = orderSqliteColumns(observedColumns, row)

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
    managed = appendSqliteColumnEvidence(
      column,
      schema,
      managed,
      opaque,
      row,
      nativeDefinition,
      decodedColumns,
    )
  }

  return { columns, decodedColumns, managed, opaque }
}

/**
 * Orders observed columns and rejects conflicting names or ordinal positions.
 *
 * @param observedColumns - Native column facts compared with the desired schema.
 * @param row - Current native catalog row, insert row, or result object.
 *
 * @returns A copy of column evidence ordered by canonical column identity.
 */
function orderSqliteColumns(observedColumns: readonly XInfoRow[], row: TableRow) {
  const columns = [...observedColumns].sort(
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

  return columns
}

/**
 * Decodes one column and retains unsupported storage properties as opaque evidence.
 *
 * @param column - Authored or observed column metadata used for storage comparison.
 * @param schema - Native schema definition used to check table SQL and relation identity.
 * @param managed - Whether the evidence still supports complete table management.
 * @param opaque - Mutable evidence for native objects outside the supported portable
 *   model.
 * @param row - Current native catalog row, insert row, or result object.
 * @param nativeDefinition - Present, absent, or unsupported evidence for the native SQL
 *   definition.
 * @param decodedColumns - Portable columns accumulated in native ordinal order.
 *
 * @returns True when append sqlite column evidence applies to the supplied input.
 */
function appendSqliteColumnEvidence(
  column: XInfoRow,
  schema: SchemaRow | undefined,
  managed: boolean,
  opaque: OpaqueCatalogObject[],
  row: TableRow,
  nativeDefinition: CatalogFact<string>,
  decodedColumns: CatalogColumn[],
) {
  const { type, generated, columnNative } = sqliteColumnValueFacts(column, schema)

  if (column.hidden !== 0) managed = false

  const columnDefault =
    column.dflt_value === null ? absent : parseDefault(column.dflt_value)

  if (
    columnDefault.state === 'present' &&
    columnDefault.value.kind === 'nativeExpression'
  ) {
    managed = false

    opaque.push({
      kind: 'other',
      name: present(column.name),
      nativeDefinition: present(columnDefault.value.native),
      reason: 'SQLite default expression cannot be compared portably',
    })
  }

  if ((row.type === 'virtual' || row.type === 'shadow') && column.hidden !== 0)
    opaque.push({
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

  return managed
}

/**
 * Decodes defaults and generation facts from one SQLite column observation.
 *
 * @param column - Authored or observed column metadata used for storage comparison.
 * @param schema - Native schema definition used to check table SQL and relation identity.
 *
 * @returns Default and generation evidence derived from native column and rowid facts.
 */
function sqliteColumnValueFacts(column: XInfoRow, schema: SchemaRow | undefined) {
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
      ? unsupported('SQLite generated column expression is not independently available')
      : column.hidden === 1
        ? unsupported('SQLite hidden column is not managed')
        : absent

  return { type, generated, columnNative }
}

/** Reads the version and resolves the supported catalog request context. */
async function readCatalogContext(executor: CatalogExecutor, request: CatalogRequest) {
  const versionRows = await executor.execute(queries.version)

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
  return {
    ...readSqliteVersionEvidence(versionRows),
    namespaceContext,
    identities,
    resolvedRequest,
  }
}

/** Converts invalid successful version metadata into unavailable catalog evidence. */
function readSqliteVersionEvidence(versionRows: unknown[]) {
  try {
    const decoded = decodeSqliteVersion(versionRows)
    return {
      version: decoded.version,
      versionLimited:
        decoded.actualVersion[0]! < 3 ||
        (decoded.actualVersion[0] === 3 && decoded.actualVersion[1]! < 37),
      versionError: undefined as string | undefined,
    }
  } catch (error) {
    if (!(error instanceof InvariantError)) throw error

    return { version: 'unknown', versionLimited: false, versionError: error.message }
  }
}

/**
 * Validates the server version required to interpret native catalog evidence.
 *
 * @param versionRows - Native server-version observations supplied by the fixture.
 *
 * @returns The validated native SQLite version used to select catalog capabilities.
 */
function decodeSqliteVersion(versionRows: unknown[]) {
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

  return { actualVersion, version }
}

/** Reads database aliases and diagnoses attached and temporary namespaces. */
async function readDatabaseContext(executor: CatalogExecutor) {
  const dbRows = await executor.execute(queries.databases)
  const databases = decodeSqliteDatabases(dbRows)

  const databaseAliases = new Set(
    databases.map((entry) => asciiFoldSqliteIdentifier(entry.name)),
  )

  const temporaryDatabase =
    databases.some((entry) => asciiFoldSqliteIdentifier(entry.name) === 'temp') &&
    decodeSchemaRows(
      await executor.execute({
        sql: 'select type, name, tbl_name, sql from "temp".sqlite_schema order by type, name',
        params: [],
      }),
    ).length > 0

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

  return { databases, databaseAliases, temporaryDatabase, attached, diagnostics }
}

/**
 * Validates attached database aliases and reports external namespaces.
 *
 * @param dbRows - Native database-list observations before validation.
 *
 * @returns Validated database aliases and explicit external-namespace evidence.
 */
function decodeSqliteDatabases(dbRows: unknown[]) {
  const databases = stableRows(dbRows).map((value, index) => {
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

  return databases
}

/**
 * Rejects malformed auxiliary entries in native index evidence.
 *
 * @param info - Validated native index or relation evidence.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 */
function validateAuxiliaryEntries(info: IndexInfoRow[], index: IndexListRow): void {
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
}

/**
 * Resolves index member order and determines whether its semantics are fully supported.
 *
 * @param keyEntries - Native index key entries whose sequence and referenced columns must
 *   remain valid.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 * @param columns - Ordered column names, references, or observations used by this
 *   operation.
 *
 * @returns Index member order and determines whether its semantics are fully supported.
 */
function decodeIndexColumns(
  keyEntries: IndexInfoRow[],
  index: IndexListRow,
  columns: readonly XInfoRow[],
): { columnsForIndex: string[]; simple: boolean } {
  const columnsForIndex: string[] = []
  let simple = index.partial === 0

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

  return { columnsForIndex, simple }
}

/** Decodes table SQL facts and preserves unsupported clauses as opaque evidence. */
function tableSqlEvidence(
  schema: SchemaRow | undefined,
  rowidAlias: boolean,
  nativeDefinition: CatalogRelation['nativeDefinition'],
) {
  const opaque: OpaqueCatalogObject[] = []
  const createSql = schema?.sql ?? null
  const constraintName =
    createSql !== null && hasSqlToken(createSql, 'CONSTRAINT')
      ? unknown('SQLite does not expose authored constraint names')
      : absent

  const managed = constraintName.state !== 'unknown'

  if (constraintName.state === 'unknown') {
    opaque.push({
      kind: 'constraint',
      name: constraintName,
      nativeDefinition,
      reason: 'SQLite authored constraint names are not exposed by catalog PRAGMAs',
    })
  }

  const clauses = decodeTableSqlClauses(
    createSql,
    managed,
    opaque,
    nativeDefinition,
    rowidAlias,
  )

  return { createSql, constraintName, ...clauses, opaque }
}

/**
 * Preserves unsupported table clauses and validates rowid AUTOINCREMENT evidence.
 *
 * @param createSql - Native CREATE TABLE definition used for clause and constraint
 *   checks.
 * @param managed - Whether the evidence still supports complete table management.
 * @param opaque - Mutable evidence for native objects outside the supported portable
 *   model.
 * @param nativeDefinition - Present, absent, or unsupported evidence for the native SQL
 *   definition.
 * @param rowidAlias - Whether the primary key aliases SQLite's native rowid.
 *
 * @returns Supported rowid generation facts and retained unsupported native clauses.
 */
function decodeTableSqlClauses(
  createSql: string | null,
  managed: boolean,
  opaque: OpaqueCatalogObject[],
  nativeDefinition: CatalogFact<string>,
  rowidAlias: boolean,
) {
  const unsupportedClauses = [
    hasSqlToken(createSql ?? '', 'COLLATE') && 'COLLATE',
    hasSqlTokens(createSql ?? '', ['ON', 'CONFLICT']) && 'ON CONFLICT',
    hasSqlToken(createSql ?? '', 'DEFERRABLE') && 'DEFERRABLE',
    hasSqlToken(createSql ?? '', 'INITIALLY') && 'INITIALLY',
    hasSqlToken(createSql ?? '', 'MATCH') && 'MATCH',
  ].filter((clause): clause is string => clause !== false)

  if (unsupportedClauses.length > 0) {
    managed = false

    opaque.push({
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

    opaque.push({
      kind: 'other',
      name: absent,
      nativeDefinition,
      reason: 'AUTOINCREMENT does not describe an INTEGER rowid alias',
    })
  }

  return { autoIncrement, managed }
}

/** Validates index identities, sequence numbers, and primary-key flags. */
function validateTableIndexes(
  row: TableRow,
  indexes: readonly IndexListRow[],
  identities: ReturnType<typeof sqliteIdentity.create>,
): IndexListRow | undefined {
  const indexSeqs = indexes.map((index) => index.seq).sort((a, b) => a - b)

  if (indexSeqs.some((seq, position) => seq !== position))
    throw new InvariantError(
      `SQLite table ${JSON.stringify(row.name)} has non-contiguous index_list sequences`,
    )

  if (
    new Set(indexes.map((index) => identities.member('index', index.name).comparisonKey))
      .size !== indexes.length
  )
    throw new InvariantError(
      `Duplicate SQLite index_list name on ${JSON.stringify(row.name)}`,
    )

  const pkIndexes = indexes.filter((index) => index.origin === 'pk')

  if (pkIndexes.length > 1)
    throw new InvariantError(
      `SQLite table ${JSON.stringify(row.name)} has multiple primary-key indexes`,
    )

  const pkIndex = pkIndexes.at(0)

  if (pkIndex && (pkIndex.unique !== 1 || pkIndex.partial !== 0))
    throw new InvariantError(
      `SQLite primary-key index on ${JSON.stringify(row.name)} has invalid flags`,
    )

  return pkIndex
}

/**
 * Checks that rows in one composite foreign key share the same target and actions.
 *
 * @param group - Native rows forming one composite foreign key.
 * @param first - First observation or composite-key row used as the comparison baseline.
 *
 * @returns True when rows in one composite foreign key share the same target and actions.
 */
function foreignGroupIsConsistent(group: ForeignKeyRow[], first: ForeignKeyRow): boolean {
  return group.every(
    (entry) =>
      entry.table === first.table &&
      entry.on_delete.toLowerCase() === first.on_delete.toLowerCase() &&
      entry.on_update.toLowerCase() === first.on_update.toLowerCase() &&
      entry.match.toLowerCase() === first.match.toLowerCase(),
  )
}

/**
 * Resolves a foreign-key target against the observed main-database catalog.
 *
 * @param group - Native rows forming one composite foreign key.
 * @param first - First observation or composite-key row used as the comparison baseline.
 * @param mainTables - Validated ordinary tables observed in SQLite's main database.
 * @param xinfo - Native table-column observations indexed by table name.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns A foreign-key target against the observed main-database catalog.
 */
function resolveForeignTarget(
  group: ForeignKeyRow[],
  first: ForeignKeyRow,
  mainTables: readonly TableRow[],
  xinfo: ReadonlyMap<string, XInfoRow[]>,
  identities: ReturnType<typeof sqliteIdentity.create>,
) {
  /** Resolves a native relation name under the current catalog namespace. */
  const scopeIdentity = (name: string) => identities.resolve(relationInput('main', name))
  const targetTable = mainTables.find(
    (candidate) =>
      scopeIdentity(candidate.name).relation.comparisonKey ===
      scopeIdentity(first.table).relation.comparisonKey,
  )

  const targetIdentity = scopeIdentity(targetTable?.name ?? first.table)
  const requestedTargetColumns = group.map((entry) => entry.to)
  const targetInfo = targetTable
    ? xinfo
        .get(targetTable.name)
        ?.slice()
        .sort((left, right) => left.cid - right.cid)
    : undefined

  const { targetColumns, parentPrimaryKey } = foreignTargetColumns(
    targetInfo,
    requestedTargetColumns,
    identities,
  )

  return describeForeignKeyTarget(
    targetInfo,
    targetColumns,
    group,
    identities,
    targetTable,
    targetIdentity,
    parentPrimaryKey,
  )
}

/**
 * Resolves explicit target columns or the referenced table's primary-key order.
 *
 * @param targetInfo - Validated native column evidence for the referenced table.
 * @param requestedTargetColumns - Explicit target column names, with null indicating
 *   primary-key inference.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Resolved target columns and evidence of whether the native target and key were
 *   observed.
 */
function foreignTargetColumns(
  targetInfo: XInfoRow[] | undefined,
  requestedTargetColumns: (string | null)[],
  identities: CanonicalRelationIdentityModule,
) {
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

  return { targetColumns, parentPrimaryKey }
}

/**
 * Builds canonical target evidence after validating native column references.
 *
 * @param targetInfo - Validated native column evidence for the referenced table.
 * @param targetColumns - Ordered columns of the foreign-key target.
 * @param group - Native rows forming one composite foreign key.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param targetTable - Observed table referenced by the foreign key.
 * @param targetIdentity - Canonical foreign-key target identity.
 * @param parentPrimaryKey - Ordered parent key columns used for foreign-key inference.
 *
 * @returns A diagnostic label identifying the foreign-key target columns.
 */
function describeForeignKeyTarget(
  targetInfo: XInfoRow[] | undefined,
  targetColumns: string[],
  group: ForeignKeyRow[],
  identities: CanonicalRelationIdentityModule,
  targetTable: TableRow | undefined,
  targetIdentity: CanonicalRelationIdentity,
  parentPrimaryKey: string[],
) {
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

  return {
    targetTable,
    targetIdentity,
    targetInfo,
    parentPrimaryKey,
    targetColumns,
    targetColumnsObserved,
  }
}

/**
 * Checks whether observed primary or unique indexes support the referenced candidate key.
 *
 * @param targetTable - Observed table referenced by the foreign key.
 * @param targetInfo - Validated native column evidence for the referenced table.
 * @param targetColumns - Ordered columns of the foreign-key target.
 * @param indexLists - Native index-list observations indexed by owning table.
 * @param indexInfos - Native index-member observations indexed by physical index name.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Portable unique-key evidence with unsupported native semantics retained.
 */
function uniqueKeyEvidence(
  targetTable: TableRow | undefined,
  targetInfo: XInfoRow[] | undefined,
  targetColumns: string[],
  indexLists: ReadonlyMap<string, IndexListRow[]>,
  indexInfos: ReadonlyMap<string, IndexInfoRow[]>,
  identities: ReturnType<typeof sqliteIdentity.create>,
) {
  const simpleUniqueKeys: string[][] = []
  let matchingRichUniqueKey = false

  if (!targetTable || !targetInfo) return { simpleUniqueKeys, matchingRichUniqueKey }

  const keyIndexes = indexLists.get(targetTable.name) ?? []
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

    if (!sameCandidateKeyColumns(targetColumns, keyColumns, identities)) continue

    if (
      keyColumns.length === keyInfo.length &&
      keyInfo.every((entry) => entry.desc === 0 && entry.coll === 'BINARY')
    ) {
      simpleUniqueKeys.push(keyColumns)
    } else {
      matchingRichUniqueKey = true
    }
  }

  return { simpleUniqueKeys, matchingRichUniqueKey }
}

/** Orders key constraints deterministically by their names and evidence. */
const byKey = (left: CatalogKeyConstraint, right: CatalogKeyConstraint) =>
  compareFact(left.name, right.name) ||
  compare(left.columns.join('\0'), right.columns.join('\0')) ||
  compare(JSON.stringify(left.semantics), JSON.stringify(right.semantics)) ||
  compare(JSON.stringify(left.validity), JSON.stringify(right.validity)) ||
  compare(JSON.stringify(left.nativeDefinition), JSON.stringify(right.nativeDefinition))

/** Orders indexes deterministically by their names and evidence. */
const byIndex = (left: CatalogIndex, right: CatalogIndex) =>
  compareFact(left.name, right.name) ||
  compare(left.columns.join('\0'), right.columns.join('\0')) ||
  compare(String(left.unique), String(right.unique)) ||
  compare(JSON.stringify(left.semantics), JSON.stringify(right.semantics)) ||
  compare(JSON.stringify(left.nativeDefinition), JSON.stringify(right.nativeDefinition))

/** Orders opaque catalog objects by stable native evidence. */
const byOpaque = (left: OpaqueCatalogObject, right: OpaqueCatalogObject) =>
  compareFact(left.name, right.name) ||
  compare(left.kind, right.kind) ||
  compare(left.reason, right.reason) ||
  compare(JSON.stringify(left.nativeDefinition), JSON.stringify(right.nativeDefinition))

/** Reads column, index, and foreign-key evidence in catalog query order. */
async function readTableEvidence(
  executor: CatalogExecutor,
  scopeRows: readonly TableRow[],
  mainTables: readonly TableRow[],
) {
  const xinfo = new Map<string, XInfoRow[]>()
  const indexLists = new Map<string, IndexListRow[]>()
  const indexInfos = new Map<string, IndexInfoRow[]>()
  const foreignKeys = new Map<string, ForeignKeyRow[]>()
  const errors = new Map<string, string>()
  for (const row of scopeRows) {
    if (row.type !== 'table' && row.type !== 'virtual' && row.type !== 'shadow') continue

    await readSqliteTableEvidence(
      xinfo,
      row,
      executor,
      indexLists,
      foreignKeys,
      indexInfos,
      errors,
    )
  }

  const reservationIndexLists = new Map<string, IndexListRow[]>()
  for (const row of mainTables.filter(
    (entry) => entry.type === 'table' && !entry.name.startsWith('sqlite_'),
  )) {
    const observed = indexLists.get(row.name)

    if (observed) {
      reservationIndexLists.set(row.name, observed)
      continue
    }

    if (errors.has(row.name)) continue

    const rows = await executor.execute(queries.indexes(row.name))
    const decoded = decodeTableObservation(row.name, errors, () =>
      decodeIndexListRows(rows, row.name),
    )

    if (decoded) reservationIndexLists.set(row.name, decoded)
  }

  return { xinfo, indexLists, indexInfos, foreignKeys, reservationIndexLists, errors }
}

/** Keeps a relation-local decoder error distinct from an executor rejection. */
function decodeTableObservation<T>(
  table: string,
  errors: Map<string, string>,
  decode: () => T,
): T | undefined {
  try {
    return decode()
  } catch (error) {
    if (!(error instanceof InvariantError)) throw error
    if (!errors.has(table)) errors.set(table, error.message)

    return undefined
  }
}

/**
 * Reads one table's columns, indexes, and foreign keys in native query order.
 *
 * @param xinfo - Native table-column observations indexed by table name.
 * @param row - Current native catalog row, insert row, or result object.
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param indexLists - Native index-list observations indexed by owning table.
 * @param foreignKeys - Observed foreign keys or native composite-key rows to decode.
 * @param indexInfos - Native index-member observations indexed by physical index name.
 */
async function readSqliteTableEvidence(
  xinfo: Map<string, XInfoRow[]>,
  row: TableRow,
  executor: CatalogExecutor,
  indexLists: Map<string, IndexListRow[]>,
  foreignKeys: Map<string, ForeignKeyRow[]>,
  indexInfos: Map<string, IndexInfoRow[]>,
  errors: Map<string, string>,
) {
  const columns = await executor.execute(queries.xinfo(row.name))
  const decodedColumns = decodeTableObservation(row.name, errors, () =>
    decodeXInfoRows(columns, row.name),
  )

  if (decodedColumns) xinfo.set(row.name, decodedColumns)

  const indexes = await executor.execute(queries.indexes(row.name))
  const decodedIndexes = decodeTableObservation(row.name, errors, () =>
    decodeIndexListRows(indexes, row.name),
  )

  if (decodedIndexes) indexLists.set(row.name, decodedIndexes)

  const keys = await executor.execute(queries.foreignKeys(row.name))
  const decodedKeys = decodeTableObservation(row.name, errors, () =>
    decodeForeignKeyRows(keys, row.name),
  )

  if (decodedKeys) foreignKeys.set(row.name, decodedKeys)

  for (const index of decodedIndexes ?? []) {
    const info = await executor.execute(queries.indexInfo(index.name))
    const decodedInfo = decodeTableObservation(row.name, errors, () =>
      decodeIndexInfoRows(info, row.name, index.name),
    )

    if (decodedInfo) indexInfos.set(`${row.name}\0${index.name}`, decodedInfo)
  }
}

/** Rejects changed catalog observations before building a snapshot. */
async function assertCatalogUnchanged(input: SqliteCatalogConsistency): Promise<void> {
  const {
    executor,
    databases,
    tableRows,
    schemaRows,
    scopeRows,
    resolvedRequest,
    identities,
    evidence,
  } = input

  const { xinfo, indexLists, indexInfos, foreignKeys, reservationIndexLists, errors } =
    evidence

  /**
   * Keeps table observations covered by the resolved catalog request.
   *
   * @param rows - Ordered native observations or result rows to process.
   *
   * @returns Native rows within the requested canonical namespace scope.
   */
  const scopedRows = (rows: readonly TableRow[]) =>
    scopedSqliteCatalogRows(rows, resolvedRequest, identities)

  /** Rejects native catalog observations that changed between reads. */
  const assertSame = assertSameCatalogObservation

  await assertSqliteInventoryUnchanged(
    assertSame,
    databases,
    executor,
    scopedRows,
    tableRows,
    schemaRows,
    reservationIndexLists,
  )

  await assertSqliteTableEvidenceUnchanged(
    scopeRows,
    executor,
    assertSame,
    xinfo,
    indexLists,
    foreignKeys,
    indexInfos,
    errors,
  )
}

/**
 * Rechecks database, table, schema, and reservation inventory before returning a
 * snapshot.
 *
 * @param assertSame - Callback that checks identity equivalence under the fixture policy.
 * @param databases - Observed native database aliases from the initial inventory.
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param scopedRows - Native observations filtered to the requested namespace scope.
 * @param tableRows - Native table-list observations used as the consistency baseline.
 * @param schemaRows - Native sqlite_schema definitions used to verify relation and index
 *   evidence.
 * @param reservationIndexLists - Index lists used to reserve names outside the explicitly
 *   requested table scope.
 */
async function assertSqliteInventoryUnchanged(
  assertSame: (label: string, first: unknown, second: unknown) => void,
  databases: { seq: number; name: string; file: string | null }[],
  executor: CatalogExecutor,
  scopedRows: (rows: readonly TableRow[]) => TableRow[],
  tableRows: readonly TableRow[],
  schemaRows: readonly SchemaRow[],
  reservationIndexLists: Map<string, IndexListRow[]>,
) {
  assertSame(
    'database_list',
    databases,
    decodeSqliteDatabases(await executor.execute(queries.databases)),
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
}

/**
 * Rechecks requested column, index, and foreign-key observations for catalog races.
 *
 * @param scopeRows - Native namespace observations for the requested catalog scope.
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param assertSame - Callback that checks identity equivalence under the fixture policy.
 * @param xinfo - Native table-column observations indexed by table name.
 * @param indexLists - Native index-list observations indexed by owning table.
 * @param foreignKeys - Observed foreign keys or native composite-key rows to decode.
 * @param indexInfos - Native index-member observations indexed by physical index name.
 */
async function assertSqliteTableEvidenceUnchanged(
  scopeRows: readonly TableRow[],
  executor: CatalogExecutor,
  assertSame: (label: string, first: unknown, second: unknown) => void,
  xinfo: Map<string, XInfoRow[]>,
  indexLists: Map<string, IndexListRow[]>,
  foreignKeys: Map<string, ForeignKeyRow[]>,
  indexInfos: Map<string, IndexInfoRow[]>,
  errors: Map<string, string>,
) {
  for (const row of scopeRows) {
    if (row.type !== 'table' && row.type !== 'virtual' && row.type !== 'shadow') continue
    if (errors.has(row.name)) continue

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
}

/** Validates native relation evidence and resolves its catalog kind. */
function relationDefinition(row: TableRow, schema: SchemaRow | undefined) {
  /** Rejects native relation rows outside the supported catalog representation. */
  function assertSupportedRow(): void {
    if (
      row.type !== 'table' &&
      row.type !== 'view' &&
      row.type !== 'virtual' &&
      row.type !== 'shadow'
    ) {
      throw new InvariantError(
        `Malformed SQLite table_list row: unsupported type ${JSON.stringify(row.type)}`,
      )
    }

    if (row.type === 'table' && schema === undefined) {
      throw new InvariantError(
        `SQLite table ${JSON.stringify(row.name)} is missing sqlite_schema definition`,
      )
    }
  }

  /** Returns native SQL definition evidence without inventing absent definitions. */
  function relationNativeDefinition(): CatalogRelation['nativeDefinition'] {
    if (schema?.sql !== null && schema !== undefined) return present(schema.sql)

    if (row.type === 'table')
      return unsupported('SQLite table has no sqlite_schema definition')

    return absent
  }

  /**
   * Maps a native relation classification to the portable catalog kind.
   *
   * @returns The portable relation kind corresponding to the native observation.
   */
  function relationKind(): CatalogRelation['kind'] {
    if (row.type === 'view') return 'view'
    if (row.type === 'virtual') return 'virtualTable'
    if (row.type === 'shadow') return 'shadowTable'

    return 'table'
  }

  assertSupportedRow()
  const nativeDefinition = relationNativeDefinition()
  const tableKind = relationKind()

  return { nativeDefinition, tableKind }
}

/** Decodes primary-key semantics and applies rowid generation to its column. */
function createPrimaryKey(
  row: TableRow,
  indexInfos: Awaited<ReturnType<typeof readTableEvidence>>['indexInfos'],
  columns: XInfoRow[],
  decodedColumns: CatalogColumn[],
  pks: XInfoRow[],
  pkIndex: IndexListRow | undefined,
  rowidAlias: boolean,
  createSql: string | null,
  constraintName: CatalogFact<string>,
  autoIncrement: boolean,
): { primaryKey: CatalogFact<CatalogKeyConstraint>; managed: boolean } {
  const pkSimple = primaryKeyIndexSemantics(pkIndex, indexInfos, row, pks)

  if (rowidAlias) {
    const column = decodedColumns.find((entry) => entry.name === pks[0]!.name)!
    decodedColumns[columns.indexOf(pks[0]!)!] = {
      ...column,
      nullable: present(false),
      generation: present({ kind: 'rowidAlias', autoIncrement }),
    }
  }

  const primaryKey: CatalogFact<CatalogKeyConstraint> =
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

  return { primaryKey, managed: pkSimple }
}

/**
 * Checks backing-index member order and supported primary-key semantics.
 *
 * @param pkIndex - Native index backing the observed primary key.
 * @param indexInfos - Native index-member observations indexed by physical index name.
 * @param row - Current native catalog row, insert row, or result object.
 * @param pks - Native primary-key rows in key-column order.
 *
 * @returns True when backing-index member order and supported primary-key semantics.
 */
function primaryKeyIndexSemantics(
  pkIndex: IndexListRow | undefined,
  indexInfos: Map<string, IndexInfoRow[]>,
  row: TableRow,
  pks: XInfoRow[],
) {
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

  return pkSimple
}

/** Decodes one index and its backing UNIQUE constraint from native evidence. */
function decodeCatalogIndex(
  index: IndexListRow,
  info: IndexInfoRow[],
  columns: XInfoRow[],
  schemaRows: readonly SchemaRow[],
  identities: ReturnType<typeof sqliteIdentity.create>,
  constraintName: CatalogFact<string>,
  createSql: string | null,
): SqliteIndexEvidence {
  const keyEntries = validateIndexSequence(info, index)
  const { columnsForIndex, simple } = decodeIndexColumns(keyEntries, index, columns)

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

    return {
      managed: simple,
      catalogIndex: decodeSqliteUserIndex(index, columnsForIndex, simple, indexSql),
    }
  } else if (index.origin === 'u') {
    return {
      managed: simple,
      uniqueConstraint: {
        name: constraintName,
        columns: columnsForIndex,
        semantics: simple
          ? present({ kind: 'simple' })
          : unsupported('SQLite UNIQUE constraint uses unsupported index semantics'),
        validity: present('valid'),
        nativeDefinition: createSql
          ? present(createSql)
          : unsupported('SQLite UNIQUE constraint definition is unavailable'),
      },
    }
  }

  return { managed: true }
}

/**
 * Rejects repeated or invalid native index sequence numbers.
 *
 * @param info - Validated native index or relation evidence.
 * @param index - Zero-based row, column, or graph position used for ordering and
 *   diagnostics.
 *
 * @returns Validated index members in their contiguous native sequence.
 */
function validateIndexSequence(info: IndexInfoRow[], index: IndexListRow) {
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

  validateAuxiliaryEntries(info, index)
  return keyEntries
}

/** Decodes one foreign-key group and verifies its referenced candidate key. */
function decodeCatalogForeignKey(
  row: TableRow,
  group: ForeignKeyRow[],
  columns: XInfoRow[],
  mainTables: readonly TableRow[],
  evidence: Awaited<ReturnType<typeof readTableEvidence>>,
  identities: ReturnType<typeof sqliteIdentity.create>,
  createSql: string | null,
  constraintName: CatalogFact<string>,
): { foreignKey: CatalogForeignKey; managed: boolean } {
  const { xinfo, indexLists, indexInfos } = evidence
  const { first, sourceColumns, onDelete, onUpdate } = decodeForeignKeySource(
    group,
    row,
    columns,
    identities,
  )

  const target = resolveForeignTarget(group, first, mainTables, xinfo, identities)
  const { fkSimple, targetKeyValid, targetKeyUnknown } = resolveForeignKeySemantics(
    target,
    indexLists,
    indexInfos,
    identities,
    first,
  )

  const foreignKey: CatalogForeignKey = {
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
    referencedRelation: target.targetIdentity,
    referencedColumns: target.targetColumns,
    onDelete,
    onUpdate,
  }

  return { foreignKey, managed: fkSimple }
}

/**
 * Classifies a foreign key using referenced candidate-key evidence.
 *
 * @param target - Identity or evidence required by the current reference or diagnostic.
 * @param indexLists - Native index-list observations indexed by owning table.
 * @param indexInfos - Native index-member observations indexed by physical index name.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param first - First observation or composite-key row used as the comparison baseline.
 *
 * @returns Supported or unsupported semantics from the referenced candidate-key evidence.
 */
function resolveForeignKeySemantics(
  target: {
    targetTable: TableRow | undefined
    targetIdentity: CanonicalRelationIdentity
    targetInfo: XInfoRow[] | undefined
    parentPrimaryKey: string[]
    targetColumns: string[]
    targetColumnsObserved: boolean
  },
  indexLists: Map<string, IndexListRow[]>,
  indexInfos: Map<string, IndexInfoRow[]>,
  identities: CanonicalRelationIdentityModule,
  first: ForeignKeyRow,
) {
  const { simpleUniqueKeys, matchingRichUniqueKey } = uniqueKeyEvidence(
    target.targetTable,
    target.targetInfo,
    target.targetColumns,
    indexLists,
    indexInfos,
    identities,
  )

  const matchesPrimaryKey = sameCandidateKeyColumns(
    target.targetColumns,
    target.parentPrimaryKey,
    identities,
  )

  const targetKeyValid =
    target.targetColumnsObserved &&
    target.targetTable?.type === 'table' &&
    (matchesPrimaryKey || simpleUniqueKeys.length > 0)

  const targetKeyUnknown =
    target.targetTable === undefined ||
    (target.targetTable.type !== 'view' && target.targetInfo === undefined) ||
    (target.targetTable.type === 'table' && matchingRichUniqueKey)

  const fkSimple = targetKeyValid && first.match.toLowerCase() === 'none'

  return { fkSimple, targetKeyValid, targetKeyUnknown }
}

/**
 * Validates and orders the source columns of a composite foreign key.
 *
 * @param group - Native rows forming one composite foreign key.
 * @param row - Current native catalog row, insert row, or result object.
 * @param columns - Ordered column names, references, or observations used by this
 *   operation.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Validated source columns in native composite-key order.
 */
function decodeForeignKeySource(
  group: ForeignKeyRow[],
  row: TableRow,
  columns: XInfoRow[],
  identities: CanonicalRelationIdentityModule,
) {
  group.sort((a, b) => a.seq - b.seq)

  if (group.some((entry, position) => entry.seq !== position))
    throw new InvariantError(
      `SQLite foreign-key group on ${JSON.stringify(row.name)} has non-contiguous sequence`,
    )

  const first = group[0]!
  const onDelete = action(first.on_delete, 'foreign_key_list', 0)
  const onUpdate = action(first.on_update, 'foreign_key_list', 0)

  if (!foreignGroupIsConsistent(group, first))
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

  return { first, sourceColumns, onDelete, onUpdate }
}

/** Builds one relation from its observed SQLite catalog evidence. */
/** Orders foreign keys by canonical targets, authored names, and native evidence. */
function compareCatalogForeignKeys(
  a: CatalogForeignKey,
  b: CatalogForeignKey,
  identities: ReturnType<typeof sqliteIdentity.create>,
): number {
  return (
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
    compare(JSON.stringify(a.nativeDefinition), JSON.stringify(b.nativeDefinition)) ||
    compare(JSON.stringify(a), JSON.stringify(b))
  )
}

/** Reports SQLite STRICT and WITHOUT ROWID table options. */
function catalogTableOptions(row: TableRow) {
  const options = [
    { name: 'strict', value: row.strict ? 'true' : 'false' },
    { name: 'withoutRowid', value: row.wr ? 'true' : 'false' },
  ]

  return options
}

/** Builds table evidence and its resulting management status. */
function buildCatalogTable(input: SqliteTableAssembly) {
  const { row, evidence, identities, hasExternalNamespace, initial } = input
  const { xinfo, indexInfos, foreignKeys } = evidence
  const tableOpaque = initial.opaque
  const options = catalogTableOptions(row)
  const structure = decodeTableStructure({
    ...input,
    xinfo,
    managed: initial.managed,
    tableOpaque,
  })

  const { columns, decodedColumns, indexes, createSql, constraintName, pk } = structure
  const indexEvidence = decodeTableIndexes({
    ...input,
    indexes,
    indexInfos,
    columns,
    constraintName,
    createSql,
    managed: structure.managed,
  })

  const { uniqueConstraints, catalogIndexes } = indexEvidence
  const foreignEvidence = decodeTableForeignKeys({
    ...input,
    foreignKeys,
    columns,
    createSql,
    constraintName,
    managed: indexEvidence.managed,
  })

  const hasCheckConstraint = preserveCheckConstraint(
    createSql,
    constraintName,
    tableOpaque,
  )

  const managed = foreignEvidence.managed && !hasCheckConstraint
  const table = assembleCatalogTable(
    decodedColumns,
    pk,
    uniqueConstraints,
    foreignEvidence.fks,
    catalogIndexes,
    options,
    tableOpaque,
    hasExternalNamespace,
    identities,
  )

  return { table, managed }
}

/**
 * Builds portable index and unique-key evidence while preserving table management status.
 *
 * @param input - Sqlite index decoding inputs and shared accumulators.
 *
 * @returns Portable index and unique-key evidence while preserving table management
 *   status.
 */
function decodeTableIndexes(input: SqliteIndexDecoding) {
  let {
    indexes,
    indexInfos,
    row,
    columns,
    schemaRows,
    identities,
    constraintName,
    createSql,
    managed,
  } = input

  const uniqueConstraints: CatalogKeyConstraint[] = []
  const catalogIndexes: CatalogIndex[] = []

  for (const index of indexes) {
    const decoded = decodeCatalogIndex(
      index,
      indexInfos.get(`${row.name}\0${index.name}`)!,
      columns,
      schemaRows,
      identities,
      constraintName,
      createSql,
    )

    if (decoded.catalogIndex) catalogIndexes.push(decoded.catalogIndex)
    if (decoded.uniqueConstraint) uniqueConstraints.push(decoded.uniqueConstraint)

    managed = managed && decoded.managed
  }

  return { uniqueConstraints, catalogIndexes, managed }
}

/**
 * Builds portable foreign-key evidence while preserving table management status.
 *
 * @param input - Table foreign key decoding inputs and shared accumulators.
 *
 * @returns Portable foreign-key evidence while preserving table management status.
 */
function decodeTableForeignKeys(input: TableForeignKeyDecoding) {
  let {
    foreignKeys,
    row,
    columns,
    mainTables,
    evidence,
    identities,
    createSql,
    constraintName,
    managed,
  } = input

  const fks: CatalogForeignKey[] = []
  const grouped = new Map<number, ForeignKeyRow[]>()
  for (const fk of foreignKeys.get(row.name)!) {
    const group = grouped.get(fk.id) ?? []
    group.push(fk)
    grouped.set(fk.id, group)
  }

  for (const group of grouped.values()) {
    const decoded = decodeCatalogForeignKey(
      row,
      group,
      columns,
      mainTables,
      evidence,
      identities,
      createSql,
      constraintName,
    )

    fks.push(decoded.foreignKey)
    managed = managed && decoded.managed
  }

  return { fks, managed }
}

/**
 * Combines native identity, table evidence, and dependency-based management status.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param mainTables - Validated ordinary tables observed in SQLite's main database.
 * @param schemaRows - Native sqlite_schema definitions used to verify relation and index
 *   evidence.
 * @param evidence - Validated native observations used to assemble portable catalog
 *   facts.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param hasExternalNamespace - Whether attached or temporary namespaces prevent complete
 *   main-database management.
 * @param dependencies - Action prerequisites or observed views and triggers that affect
 *   management.
 *
 * @returns Native identity, table evidence, and dependency-based management status.
 */
function buildCatalogRelation(
  row: TableRow,
  mainTables: readonly TableRow[],
  schemaRows: readonly SchemaRow[],
  evidence: Awaited<ReturnType<typeof readTableEvidence>>,
  identities: ReturnType<typeof sqliteIdentity.create>,
  hasExternalNamespace: boolean,
  dependencies: readonly SchemaRow[],
): CatalogRelation {
  const identity = identities.resolve(relationInput('main', row.name))
  const schema = schemaForTable(schemaRows, row.name)

  const { nativeDefinition, tableKind } = relationDefinition(row, schema)

  const initial = initialRelationManagement(
    row,
    schema,
    nativeDefinition,
    hasExternalNamespace,
    dependencies,
  )

  const decoded =
    row.type === 'table' || row.type === 'virtual' || row.type === 'shadow'
      ? buildCatalogTable({
          row,
          mainTables,
          schemaRows,
          evidence,
          identities,
          hasExternalNamespace,
          schema,
          nativeDefinition,
          initial,
        })
      : undefined

  return {
    identity,
    kind: tableKind,
    persistence: 'permanent',
    owner: unsupportedByEngine('SQLite has no relation owner'),
    management: (decoded?.managed ?? initial.managed) ? 'managed' : 'unmanaged',
    nativeDefinition,
    table: decoded === undefined ? absent : present(decoded.table),
  }
}

/** Reports unavailable SQLite catalog capabilities below the supported version. */
function versionLimitedCatalog(
  context: Awaited<ReturnType<typeof readCatalogContext>>,
): CatalogSnapshot {
  const { version, resolvedRequest, namespaceContext } = context
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

/** Returns no management authority when the native catalog inventory is invalid. */
function invalidSqliteCatalog(
  context: Awaited<ReturnType<typeof readCatalogContext>>,
  reason: string,
): CatalogSnapshot {
  const evidence = unknown(reason)
  return {
    source: { dialect: 'sqlite', version: context.version },
    request: context.resolvedRequest,
    capabilities: catalogCapabilities(),
    namespaceContext: context.namespaceContext,
    namespaces: { items: [], coverage: evidence },
    nameReservations: { items: [], coverage: evidence },
    constraintNameReservations: { items: [], coverage: evidence },
    diagnostics: [{ code: 'catalog.sqlite.metadata', message: reason }],
  }
}

/** Validates table-list identity uniqueness and observed database aliases. */
function validateTableList(
  tableRows: TableRow[],
  databaseAliases: Set<string>,
  identities: ReturnType<typeof sqliteIdentity.create>,
): void {
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
}

/** Reports the native catalog capabilities of a supported SQLite version. */
function catalogCapabilities(): CatalogSnapshot['capabilities'] {
  return {
    namespaces: { state: 'supported', fidelity: 'native' },
    relationOwner: {
      state: 'unsupported',
      by: 'engine',
      reason: 'SQLite has no relation owner',
    },
    identity: { state: 'supported', fidelity: 'native' },
    richObjects: { state: 'supported', fidelity: 'opaque' },
  }
}

/** Production SQLite evidence-bearing catalog introspector. */
async function introspectSqlite(
  executor: CatalogExecutor,
  request: CatalogRequest,
): Promise<CatalogSnapshot> {
  const queryErrors = new Set<unknown>()
  const trackedExecutor: CatalogExecutor = {
    async execute(query) {
      try {
        return await executor.execute(query)
      } catch (error) {
        queryErrors.add(error)
        throw error
      }
    },
  }

  const context = await readCatalogContext(trackedExecutor, request)
  const { identities, versionLimited } = context

  if (context.versionError) return invalidSqliteCatalog(context, context.versionError)
  if (versionLimited) return versionLimitedCatalog(context)

  try {
    const inventory = await readSqliteInventory(trackedExecutor, identities)
    const evidence = await prepareSqliteCatalogEvidence(
      trackedExecutor,
      context,
      inventory,
    )

    return await buildSqliteSnapshot({
      ...context,
      ...inventory,
      ...evidence,
      executor: trackedExecutor,
    })
  } catch (error) {
    if (!(error instanceof InvariantError) || queryErrors.has(error)) throw error

    return invalidSqliteCatalog(context, error.message)
  }
}

export const sqliteCatalog: CatalogIntrospector = { introspectCatalog: introspectSqlite }

/**
 * Assembles the SQLite catalog snapshot after inventory and consistency checks.
 *
 * @param input - Sqlite snapshot assembly inputs and shared accumulators.
 *
 * @returns The SQLite catalog snapshot after inventory and consistency checks.
 */
async function buildSqliteSnapshot(input: SqliteSnapshotAssembly) {
  const {
    schemaRows,
    resolvedRequest,
    identities,
    tableEvidence,
    mainTables,
    reservationIndexLists,
    hasExternalNamespace,
    version,
    namespaceContext,
    diagnostics,
  } = input

  await assertCatalogUnchanged({ ...input, evidence: tableEvidence })

  const { names: uniqueNames, constraintNameCoverage } = collectNameReservations(
    schemaRows,
    mainTables,
    reservationIndexLists,
    identities,
    hasExternalNamespace,
  )

  const constraintReservations: CatalogConstraintNameReservation[] = []
  const namespace: CatalogNamespace = buildMainCatalogNamespace({ ...input })
  appendUnscopedMetadataDiagnostics(namespace, tableEvidence, diagnostics, identities)
  const invalidEvidence = tableEvidence.errors.size > 0
  return {
    source: { dialect: 'sqlite', version },
    request: resolvedRequest,
    capabilities: catalogCapabilities(),
    namespaceContext,
    namespaces: { items: [namespace], coverage: complete },
    nameReservations: {
      items: uniqueNames,
      coverage: invalidEvidence
        ? unknown('SQLite relation metadata does not prove all name reservations')
        : complete,
    },
    constraintNameReservations: {
      items: constraintReservations,
      coverage: invalidEvidence
        ? unknown('SQLite relation metadata does not prove all constraint names')
        : constraintNameCoverage,
    },
    diagnostics: diagnostics.sort(
      (a, b) => compare(a.code, b.code) || compare(a.message, b.message),
    ),
  }
}

/** Reports reservation errors on tables outside the returned relation scope. */
function appendUnscopedMetadataDiagnostics(
  namespace: CatalogNamespace,
  evidence: Awaited<ReturnType<typeof readTableEvidence>>,
  diagnostics: CatalogDiagnostic[],
  identities: CanonicalRelationIdentityModule,
): void {
  const returnedNames = new Set(
    namespace.relations.items.map((relation) => relation.identity.relation.comparisonKey),
  )

  for (const [name, reason] of evidence.errors) {
    const key = identities.resolve(relationInput('main', name)).relation.comparisonKey

    if (!returnedNames.has(key))
      appendMetadataDiagnostic(diagnostics, identities, name, reason)
  }
}

/**
 * Reads and validates the native table inventory for observed database aliases.
 *
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param databaseAliases - Validated database aliases used to check table-list
 *   observations.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns And validates the native table inventory for observed database aliases.
 */
async function readTableInventory(
  executor: CatalogExecutor,
  databaseAliases: Set<string>,
  identities: CanonicalRelationIdentityModule,
) {
  const tableRows = decodeTableRows(await executor.execute(queries.tables))
  const schemaRows = decodeSchemaRows(await executor.execute(queries.schema))
  validateTableList(tableRows, databaseAliases, identities)

  const mainTables = tableRows.filter(
    (row) => row.schema === 'main' && !row.name.startsWith('sqlite_'),
  )

  return { schemaRows, tableRows, mainTables }
}

/**
 * Checks requested indexes against both table PRAGMAs and native schema definitions.
 *
 * @param mainTables - Validated ordinary tables observed in SQLite's main database.
 * @param scopeIdentity - Canonical namespace identity for catalog scope checks.
 * @param resolvedRequest - Requested scope after canonical identity and namespace
 *   resolution.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param indexLists - Native index-list observations indexed by owning table.
 * @param reservationIndexLists - Index lists used to reserve names outside the explicitly
 *   requested table scope.
 * @param schemaRows - Native sqlite_schema definitions used to verify relation and index
 *   evidence.
 */
function validateRequestedOwnerIndexes(
  mainTables: TableRow[],
  scopeIdentity: (name: string) => CanonicalRelationIdentity,
  resolvedRequest: ResolvedCatalogRequest,
  identities: CanonicalRelationIdentityModule,
  indexLists: Map<string, IndexListRow[]>,
  reservationIndexLists: Map<string, IndexListRow[]>,
  schemaRows: SchemaRow[],
  errors: Map<string, string>,
) {
  const requestedOwners = mainTables.filter((entry) =>
    relationRequested(scopeIdentity(entry.name), resolvedRequest, identities),
  )

  for (const owner of requestedOwners) {
    if (errors.has(owner.name)) continue

    decodeTableObservation(owner.name, errors, () =>
      validateOwnerIndexes(
        owner,
        indexLists.get(owner.name) ?? reservationIndexLists.get(owner.name) ?? [],
        schemaRows,
        identities,
      ),
    )
  }
}

/**
 * Builds the main namespace with relation evidence and requested coverage.
 *
 * @param input - Sqlite namespace assembly inputs and shared accumulators.
 *
 * @returns The main namespace with relation evidence and requested coverage.
 */
function buildMainCatalogNamespace(input: SqliteNamespaceAssembly) {
  const { scopeRows, tableEvidence, identities, completeMain } = input
  const rows = scopeRows.filter((entry) => !entry.name.startsWith('sqlite_'))
  const relations = rows.map((row) => buildObservedSqliteRelation(row, input))
  downgradeInvalidForeignKeys(rows, relations, input)
  relations.sort((a, b) => identities.compare(a.identity, b.identity))

  const namespace: CatalogNamespace = {
    identity: identities.resolveNamespace(mainNamespace),
    owner: unsupportedByEngine('SQLite has no namespace owner'),
    relations: {
      items: relations,
      coverage:
        tableEvidence.errors.size > 0
          ? {
              state: 'partial',
              remainder: unknown('SQLite relation metadata is invalid'),
            }
          : completeMain
            ? complete
            : {
                state: 'partial',
                remainder: unmanaged(
                  'Relations outside the requested catalog scope are unmanaged',
                ),
              },
    },
  }

  return namespace
}

/** Builds one relation, recording a local metadata failure without losing its identity. */
function buildObservedSqliteRelation(
  row: TableRow,
  input: SqliteNamespaceAssembly,
): CatalogRelation {
  const {
    mainTables,
    schemaRows,
    tableEvidence,
    identities,
    hasExternalNamespace,
    viewObjects,
    triggerObjects,
    diagnostics,
  } = input

  const invalid = tableEvidence.errors.get(row.name)

  if (invalid) {
    appendMetadataDiagnostic(diagnostics, identities, row.name, invalid)
    return unknownSqliteRelation(row, schemaRows, tableEvidence, identities, invalid)
  }

  try {
    return buildCatalogRelation(
      row,
      mainTables,
      schemaRows,
      tableEvidence,
      identities,
      hasExternalNamespace,
      [...viewObjects, ...triggerObjects],
    )
  } catch (error) {
    if (!(error instanceof InvariantError)) throw error

    tableEvidence.errors.set(row.name, error.message)
    appendMetadataDiagnostic(diagnostics, identities, row.name, error.message)
    return unknownSqliteRelation(
      row,
      schemaRows,
      tableEvidence,
      identities,
      error.message,
    )
  }
}

/** Removes FK proofs that depend on invalid parent metadata. */
function downgradeInvalidForeignKeys(
  rows: readonly TableRow[],
  relations: CatalogRelation[],
  input: SqliteNamespaceAssembly,
): void {
  const { tableEvidence, schemaRows, identities, diagnostics } = input
  for (const [index, row] of rows.entries()) {
    if (tableEvidence.errors.has(row.name)) continue

    const dependency = tableEvidence.foreignKeys
      .get(row.name)
      ?.find((key) =>
        [...tableEvidence.errors.keys()].some(
          (name) =>
            asciiFoldSqliteIdentifier(name) === asciiFoldSqliteIdentifier(key.table),
        ),
      )

    if (!dependency) continue

    const reason = `SQLite foreign key on ${JSON.stringify(row.name)} references invalid parent metadata`
    relations[index] = unknownSqliteRelation(
      row,
      schemaRows,
      tableEvidence,
      identities,
      reason,
    )
    tableEvidence.errors.set(row.name, reason)
    appendMetadataDiagnostic(diagnostics, identities, row.name, reason)
  }
}

/** Preserves a proven relation identity and definition without granting management. */
function unknownSqliteRelation(
  row: TableRow,
  schemaRows: readonly SchemaRow[],
  evidence: Awaited<ReturnType<typeof readTableEvidence>>,
  identities: CanonicalRelationIdentityModule,
  reason: string,
): CatalogRelation {
  const schema = schemaForTable(schemaRows, row.name)
  const schemaValid =
    schema?.type === (row.type === 'view' ? 'view' : 'table') &&
    asciiFoldSqliteIdentifier(schema.tbl_name) === asciiFoldSqliteIdentifier(row.name)

  const nativeDefinition =
    schemaValid && schema.sql !== null ? present(schema.sql) : unknown(reason)

  const columns = recoveredSqliteColumns(
    row,
    schemaValid ? schema : undefined,
    evidence,
    nativeDefinition,
    identities,
    reason,
  )

  const unavailable = { items: [], coverage: unknown(reason) }
  return {
    identity: identities.resolve(relationInput('main', row.name)),
    kind:
      row.type === 'virtual'
        ? 'virtualTable'
        : row.type === 'shadow'
          ? 'shadowTable'
          : row.type === 'view'
            ? 'view'
            : 'table',
    persistence: 'permanent',
    owner: unsupportedByEngine('SQLite has no relation owner'),
    management: 'unmanaged',
    nativeDefinition,
    table:
      row.type === 'view'
        ? unknown(reason)
        : present({
            columns,
            primaryKey: unknown(reason),
            uniqueConstraints: unavailable,
            foreignKeys: unavailable,
            indexes: unavailable,
            options: { items: catalogTableOptions(row), coverage: complete },
            opaqueObjects: unavailable,
          }),
  }
}

/** Keeps valid column observations when another member observation is invalid. */
function recoveredSqliteColumns(
  row: TableRow,
  schema: SchemaRow | undefined,
  evidence: Awaited<ReturnType<typeof readTableEvidence>>,
  nativeDefinition: CatalogRelation['nativeDefinition'],
  identities: CanonicalRelationIdentityModule,
  reason: string,
): CatalogTable['columns'] {
  const observed = evidence.xinfo.get(row.name)

  if (!observed || !schema) return { items: [], coverage: unknown(reason) }

  try {
    const decoded = decodeCatalogColumns(
      row,
      schema,
      observed,
      nativeDefinition,
      identities,
    ).decodedColumns

    return {
      items: recoverRowidColumnFacts(
        row,
        schema,
        observed,
        evidence,
        decoded,
        identities,
        reason,
      ),
      coverage: complete,
    }
  } catch (error) {
    if (!(error instanceof InvariantError)) throw error

    return { items: [], coverage: unknown(reason) }
  }
}

/** Uses validated primary-key inventory before inferring INTEGER rowid facts. */
function recoverRowidColumnFacts(
  row: TableRow,
  schema: SchemaRow,
  observed: XInfoRow[],
  evidence: Awaited<ReturnType<typeof readTableEvidence>>,
  columns: CatalogColumn[],
  identities: CanonicalRelationIdentityModule,
  reason: string,
): CatalogColumn[] {
  const primary = observed.filter((column) => column.pk > 0)

  if (
    row.wr !== 0 ||
    primary.length !== 1 ||
    primary[0]!.pk !== 1 ||
    primary[0]!.type.toUpperCase() !== 'INTEGER'
  )
    return columns

  const ambiguous = columns.map((column) =>
    column.name === primary[0]!.name
      ? { ...column, nullable: unknown(reason), generation: unknown(reason) }
      : column,
  )

  const indexes = evidence.indexLists.get(row.name)

  if (!indexes) return ambiguous

  try {
    if (validateTableIndexes(row, indexes, identities)) return columns
  } catch (error) {
    if (!(error instanceof InvariantError)) throw error

    return ambiguous
  }

  const sql = schema.sql

  if (sql === null) return ambiguous

  return columns.map((column) =>
    column.name === primary[0]!.name
      ? {
          ...column,
          nullable: present(false),
          generation: present({
            kind: 'rowidAlias',
            autoIncrement: hasSqlToken(sql, 'AUTOINCREMENT'),
          }),
        }
      : column,
  )
}

/** Adds a stable, relation-targeted diagnostic for invalid metadata. */
function appendMetadataDiagnostic(
  diagnostics: CatalogDiagnostic[],
  identities: CanonicalRelationIdentityModule,
  name: string,
  reason: string,
): void {
  diagnostics.push({
    code: 'catalog.sqlite.metadata',
    message: reason,
    target: identities.resolve(relationInput('main', name)),
  })
}

/**
 * Reports views, triggers, and external namespaces that limit migration authority.
 *
 * @param viewObjects - Native view observations used to verify dependency handling.
 * @param diagnostics - Mutable catalog diagnostics preserving unsupported or unmanaged
 *   evidence.
 * @param triggerObjects - Native trigger observations outside the portable schema model.
 * @param attached - Observed attached database aliases outside main.
 * @param temporaryDatabase - Whether the native inventory includes a temporary database.
 * @param tableRows - Native table-list observations used as the consistency baseline.
 *
 * @returns True when views, triggers, and external namespaces that limit migration
 *   authority.
 */
function appendDependencyDiagnostics(
  viewObjects: SchemaRow[],
  diagnostics: Readonly<{
    code: string
    message: string
    target?: CanonicalRelationIdentity
  }>[],
  triggerObjects: SchemaRow[],
  attached: { seq: number; name: string; file: string | null }[],
  temporaryDatabase: boolean,
  tableRows: TableRow[],
) {
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
  return hasExternalNamespace
}

/**
 * Combines primary-key, table SQL, and rowid evidence into portable key facts.
 *
 * @param row - Current native catalog row, insert row, or result object.
 * @param columns - Ordered column names, references, or observations used by this
 *   operation.
 * @param evidence - Validated native observations used to assemble portable catalog
 *   facts.
 * @param identities - Canonical identity operations for the resolved namespace context.
 * @param schema - Native schema definition used to check table SQL and relation identity.
 * @param nativeDefinition - Present, absent, or unsupported evidence for the native SQL
 *   definition.
 * @param tableOpaque - Mutable opaque evidence attached to the current table.
 * @param decodedColumns - Portable columns accumulated in native ordinal order.
 * @param managed - Whether the evidence still supports complete table management.
 *
 * @returns Primary-key, table SQL, and rowid evidence into portable key facts.
 */
function decodeTablePrimaryKey(
  row: TableRow,
  columns: XInfoRow[],
  evidence: Awaited<ReturnType<typeof readTableEvidence>>,
  identities: ReturnType<typeof sqliteIdentity.create>,
  schema: SchemaRow | undefined,
  nativeDefinition: CatalogRelation['nativeDefinition'],
  tableOpaque: ReturnType<typeof initialRelationManagement>['opaque'],
  decodedColumns: CatalogColumn[],
  managed: boolean,
) {
  const { indexLists, indexInfos } = evidence
  const pks = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)

  if (pks.some((column, index) => column.pk !== index + 1))
    throw new InvariantError(
      `SQLite table ${JSON.stringify(row.name)} has non-contiguous primary-key ordinals`,
    )

  const indexes = indexLists.get(row.name)!
  const pkIndex = validateTableIndexes(row, indexes, identities)
  const rowidAlias =
    row.wr === 0 &&
    pks.length === 1 &&
    pks[0]!.type.toUpperCase() === 'INTEGER' &&
    pkIndex === undefined

  const sqlEvidence = tableSqlEvidence(schema, rowidAlias, nativeDefinition)
  const { createSql, constraintName, autoIncrement } = sqlEvidence
  managed = managed && sqlEvidence.managed
  tableOpaque.push(...sqlEvidence.opaque)
  const pkEvidence = createPrimaryKey(
    row,
    indexInfos,
    columns,
    decodedColumns,
    pks,
    pkIndex,
    rowidAlias,
    createSql,
    constraintName,
    autoIncrement,
  )

  managed = managed && pkEvidence.managed
  const pk = pkEvidence.primaryKey
  return { indexes, createSql, constraintName, pk, managed }
}

/**
 * Builds ordered table facts from decoded columns, keys, indexes, and opaque objects.
 *
 * @param decodedColumns - Portable columns accumulated in native ordinal order.
 * @param pk - Primary-key definition used to build the native fixture.
 * @param uniqueConstraints - Decoded unique constraints included in the table evidence.
 * @param fks - Decoded foreign keys included in the table evidence.
 * @param catalogIndexes - Decoded portable indexes included in the table evidence.
 * @param options - Configuration and dependencies for this operation.
 * @param tableOpaque - Mutable opaque evidence attached to the current table.
 * @param hasExternalNamespace - Whether attached or temporary namespaces prevent complete
 *   main-database management.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Ordered table facts from decoded columns, keys, indexes, and opaque objects.
 */
function assembleCatalogTable(
  decodedColumns: CatalogColumn[],
  pk: CatalogTable['primaryKey'],
  uniqueConstraints: CatalogKeyConstraint[],
  fks: CatalogForeignKey[],
  catalogIndexes: CatalogIndex[],
  options: CatalogTable['options']['items'],
  tableOpaque: ReturnType<typeof initialRelationManagement>['opaque'],
  hasExternalNamespace: boolean,
  identities: ReturnType<typeof sqliteIdentity.create>,
): CatalogTable {
  return {
    columns: {
      items: decodedColumns.sort(
        (a, b) => a.position - b.position || compare(a.name, b.name),
      ),
      coverage: complete,
    },
    primaryKey: pk,
    uniqueConstraints: { items: uniqueConstraints.sort(byKey), coverage: complete },
    foreignKeys: {
      items: fks.sort((a, b) => compareCatalogForeignKeys(a, b, identities)),
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

type TableForeignKeyDecoding = {
  foreignKeys: Map<string, ForeignKeyRow[]>
  row: TableRow
  columns: XInfoRow[]
  mainTables: readonly TableRow[]
  evidence: Awaited<ReturnType<typeof readTableEvidence>>
  identities: CanonicalRelationIdentityModule
  createSql: string | null
  constraintName: CatalogNoEvidence | { readonly state: 'absent' }
  managed: boolean
}

/**
 * Decodes columns and primary-key evidence before indexes and foreign keys.
 *
 * @param input - Sqlite table structure inputs and shared accumulators.
 *
 * @returns Columns and primary-key evidence before indexes and foreign keys.
 */
function decodeTableStructure(input: SqliteTableStructure) {
  let {
    row,
    schema,
    xinfo,
    nativeDefinition,
    identities,
    managed,
    tableOpaque,
    evidence,
  } = input

  const columnEvidence = decodeCatalogColumns(
    row,
    schema,
    xinfo.get(row.name) ?? [],
    nativeDefinition,
    identities,
  )

  const { columns, decodedColumns } = columnEvidence
  managed = managed && columnEvidence.managed
  tableOpaque.push(...columnEvidence.opaque)
  const primaryKeyEvidence = decodeTablePrimaryKey(
    row,
    columns,
    evidence,
    identities,
    schema,
    nativeDefinition,
    tableOpaque,
    decodedColumns,
    managed,
  )

  const { indexes, createSql, constraintName, pk } = primaryKeyEvidence
  managed = primaryKeyEvidence.managed
  return { columns, decodedColumns, indexes, createSql, constraintName, pk, managed }
}

type SqliteSnapshotAssembly = {
  executor: CatalogExecutor
  databases: { seq: number; name: string; file: string | null }[]
  tableRows: TableRow[]
  schemaRows: SchemaRow[]
  scopeRows: TableRow[]
  resolvedRequest: ResolvedCatalogRequest
  identities: CanonicalRelationIdentityModule
  tableEvidence: Awaited<ReturnType<typeof readTableEvidence>>
  mainTables: TableRow[]
  reservationIndexLists: Map<string, IndexListRow[]>
  hasExternalNamespace: boolean
  viewObjects: SchemaRow[]
  triggerObjects: SchemaRow[]
  completeMain: boolean
  version: string
  namespaceContext: { writableDefault: { role: 'database'; spelling: string }[] }
  diagnostics: Readonly<{
    code: string
    message: string
    target?: CanonicalRelationIdentity
  }>[]
}

type SqliteTableAssembly = {
  row: TableRow
  mainTables: readonly TableRow[]
  schemaRows: readonly SchemaRow[]
  evidence: Awaited<ReturnType<typeof readTableEvidence>>
  identities: ReturnType<typeof sqliteIdentity.create>
  hasExternalNamespace: boolean
  schema: SchemaRow | undefined
  nativeDefinition: CatalogRelation['nativeDefinition']
  initial: ReturnType<typeof initialRelationManagement>
}

type SqliteTableStructure = {
  row: TableRow
  schema: SchemaRow | undefined
  xinfo: Map<string, XInfoRow[]>
  nativeDefinition: CatalogFact<string>
  identities: ReturnType<typeof sqliteIdentity.create>
  managed: boolean
  tableOpaque: OpaqueCatalogObject[]
  evidence: Awaited<ReturnType<typeof readTableEvidence>>
}

/**
 * Reads database, table, schema, and dependency inventory on the current executor.
 *
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param identities - Canonical identity operations for the resolved namespace context.
 *
 * @returns Database, table, schema, and dependency inventory on the current executor.
 */
async function readSqliteInventory(
  executor: CatalogExecutor,
  identities: CanonicalRelationIdentityModule,
) {
  const { databases, databaseAliases, temporaryDatabase, attached, diagnostics } =
    await readDatabaseContext(executor)

  const { schemaRows, tableRows, mainTables } = await readTableInventory(
    executor,
    databaseAliases,
    identities,
  )

  const viewObjects = schemaRows.filter((row) => row.type === 'view')
  const triggerObjects = schemaRows.filter((row) => row.type === 'trigger')
  const hasExternalNamespace = appendDependencyDiagnostics(
    viewObjects,
    diagnostics,
    triggerObjects,
    attached,
    temporaryDatabase,
    tableRows,
  )

  return {
    databases,
    diagnostics,
    schemaRows,
    tableRows,
    mainTables,
    viewObjects,
    triggerObjects,
    hasExternalNamespace,
  }
}

/**
 * Reads requested table evidence and verifies that the native catalog remains unchanged.
 *
 * @param executor - Executor that owns the physical session used for SQL calls.
 * @param context - Resolved namespace, client, or session dependencies used by this
 *   operation.
 * @param inventory - Observed native databases, tables, schemas, and dependencies.
 *
 * @returns Validated SQLite inventory and member observations needed for catalog
 *   assembly.
 */
async function prepareSqliteCatalogEvidence(
  executor: CatalogExecutor,
  context: Awaited<ReturnType<typeof readCatalogContext>>,
  inventory: Awaited<ReturnType<typeof readSqliteInventory>>,
) {
  const { identities, resolvedRequest } = context
  const { mainTables, schemaRows } = inventory

  /** Resolves a native relation name under the current catalog namespace. */
  const scopeIdentity = (name: string) => identities.resolve(relationInput('main', name))
  const scopeRows = mainTables.filter((row) =>
    relationRequested(scopeIdentity(row.name), resolvedRequest, identities),
  )

  const completeMain = resolvedRequest.completeNamespaces.some((entry) =>
    sameNamespace(entry, identities.resolveNamespace(mainNamespace)),
  )

  const schemaErrors = new Map<string, string>()
  validateSchemaRows(schemaRows, mainTables, resolvedRequest, identities, schemaErrors)
  const tableEvidence = await readTableEvidence(executor, scopeRows, mainTables)
  for (const [name, reason] of schemaErrors)
    if (!tableEvidence.errors.has(name)) tableEvidence.errors.set(name, reason)
  const { indexLists, reservationIndexLists, errors } = tableEvidence
  validateRequestedOwnerIndexes(
    mainTables,
    scopeIdentity,
    resolvedRequest,
    identities,
    indexLists,
    reservationIndexLists,
    schemaRows,
    errors,
  )

  return { scopeRows, completeMain, tableEvidence, reservationIndexLists }
}

type SqliteNamespaceAssembly = {
  scopeRows: TableRow[]
  mainTables: TableRow[]
  schemaRows: SchemaRow[]
  tableEvidence: Awaited<ReturnType<typeof readTableEvidence>>
  identities: CanonicalRelationIdentityModule
  hasExternalNamespace: boolean
  viewObjects: SchemaRow[]
  triggerObjects: SchemaRow[]
  completeMain: boolean
  diagnostics: CatalogDiagnostic[]
}

type SqliteCatalogConsistency = {
  executor: CatalogExecutor
  databases: Awaited<ReturnType<typeof readDatabaseContext>>['databases']
  tableRows: readonly TableRow[]
  schemaRows: readonly SchemaRow[]
  scopeRows: readonly TableRow[]
  resolvedRequest: ResolvedCatalogRequest
  identities: ReturnType<typeof sqliteIdentity.create>
  evidence: Awaited<ReturnType<typeof readTableEvidence>>
}

type SqliteIndexDecoding = {
  indexes: IndexListRow[]
  indexInfos: Map<string, IndexInfoRow[]>
  row: TableRow
  columns: XInfoRow[]
  schemaRows: readonly SchemaRow[]
  identities: CanonicalRelationIdentityModule
  constraintName: CatalogNoEvidence | { readonly state: 'absent' }
  createSql: string | null
  managed: boolean
}

/**
 * Retains CHECK clauses as opaque evidence that prevents complete table management.
 *
 * @param createSql - Native CREATE TABLE definition used for clause and constraint
 *   checks.
 * @param constraintName - Observed constraint-name evidence, including unsupported or
 *   unknown names.
 * @param tableOpaque - Mutable opaque evidence attached to the current table.
 *
 * @returns True when preserve check constraint applies to the supplied input.
 */
function preserveCheckConstraint(
  createSql: string | null,
  constraintName: CatalogNoEvidence | { readonly state: 'absent' },
  tableOpaque: OpaqueCatalogObject[],
): boolean {
  if (createSql === null || !hasSqlToken(createSql, 'CHECK')) return false

  tableOpaque.push({
    kind: 'constraint',
    name: constraintName,
    nativeDefinition: present(createSql),
    reason: 'SQLite CHECK constraint is preserved as opaque table SQL',
  })

  return true
}

/**
 * Checks a native schema row's identity and kind against table-list evidence.
 *
 * @param schemaRow - Native schema definition used to classify portable table semantics.
 * @param mainTables - Validated ordinary tables observed in SQLite's main database.
 * @param scopeIdentity - Canonical namespace identity for catalog scope checks.
 */
function assertSqliteSchemaRelation(
  schemaRow: SchemaRow,
  mainTables: readonly TableRow[],
  scopeIdentity: (name: string) => CanonicalRelationIdentity,
) {
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

/**
 * Builds native user-index evidence and classifies unsupported index expressions or
 * clauses.
 */
function decodeSqliteUserIndex(
  index: IndexListRow,
  columnsForIndex: string[],
  simple: boolean,
  indexSql: string,
): CatalogIndex {
  return {
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
  }
}

/**
 * Accumulates unquoted token characters for SQLite table-clause scanning.
 *
 * @returns Token accumulation controls that distinguish quoted text from SQL syntax.
 */
function createSqlTokenCollector() {
  let token = ''
  const tokens: string[] = []
  return {
    tokens,
    /** Adds one character to the current unquoted SQL token. */
    append(character: string) {
      token += character
    },
    /** Finishes the current SQL token without adding empty tokens. */
    flush() {
      if (token.length > 0) tokens.push(token.toUpperCase())

      token = ''
    },
  }
}

type SqliteIndexEvidence = {
  catalogIndex?: CatalogIndex
  uniqueConstraint?: CatalogKeyConstraint
  managed: boolean
}

/**
 * Rejects native SQLite evidence that changed between catalog reads.
 *
 * @param label - Native observation being compared.
 * @param first - Initial observed evidence.
 * @param second - Repeated observed evidence.
 */
function assertSameCatalogObservation(
  label: string,
  first: unknown,
  second: unknown,
): void {
  if (stable(first) !== stable(second))
    throw new InvariantError(
      `SQLite catalog changed during introspection: ${label} observations differ`,
    )
}

/**
 * Keeps native main-database tables covered by the resolved ownership request.
 *
 * @param rows - Native table-list observations from either catalog read.
 * @param resolvedRequest - Canonical relation and namespace ownership scope.
 * @param identities - SQLite identity operations under the native namespace context.
 *
 * @returns Requested main-database rows in their observed order.
 */
function scopedSqliteCatalogRows(
  rows: readonly TableRow[],
  resolvedRequest: ResolvedCatalogRequest,
  identities: CanonicalRelationIdentityModule,
): TableRow[] {
  return rows.filter(
    (row) =>
      row.schema === 'main' &&
      relationRequested(
        identities.resolve(relationInput('main', row.name)),
        resolvedRequest,
        identities,
      ),
  )
}
