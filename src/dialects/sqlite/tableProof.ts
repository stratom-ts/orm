import type {
  CatalogColumn,
  CatalogFact,
  CatalogForeignKey,
  CatalogIndex,
  CatalogKeyConstraint,
  CatalogNoEvidence,
  CatalogRelation,
  CatalogTable,
  OpaqueCatalogObject,
} from '@/dialects/catalog'
import type {
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
} from '@/migrations/canonicalRelationIdentity'
import type { ReferentialAction } from '@/schemas/actions/types'

import { isSqliteDefaultLiteral, trimSqliteWhitespace } from './defaults'
import type { sqliteIdentity } from './identity'
import { asciiFoldSqliteIdentifier } from './identity'
import { normalizeSqliteDataType, normalizeSqliteDefaultExpression } from './normalize'
import { assertSafeSqliteDefaultExpression } from './validate'

/** A known malformed or contradictory SQLite table observation. */
export class SqliteTableMetadataError extends Error {}

const complete = { state: 'complete' } as const
const absent = { state: 'absent' } as const

function present<T>(value: T): CatalogFact<T> {
  return { state: 'present', value }
}

function unsupported(reason: string): CatalogNoEvidence {
  return { state: 'unsupported', by: 'adapter', reason }
}

function unsupportedByEngine(reason: string): CatalogNoEvidence {
  return { state: 'unsupported', by: 'engine', reason }
}

function unknown(reason: string): CatalogNoEvidence {
  return { state: 'unknown', reason }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareFact(left: CatalogFact<string>, right: CatalogFact<string>): number {
  const state = compare(left.state, right.state)

  if (state) return state

  if (left.state === 'present' && right.state === 'present')
    return compare(left.value, right.value)

  return compare(JSON.stringify(left), JSON.stringify(right))
}

/** Stable native ordering for raw and decoded SQLite observations. */
export function stableSqliteObservation(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(stableSqliteObservation).sort(compare).join(',')}]`

  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => compare(a, b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableSqliteObservation(item)}`)
      .join(',')}}`
  }

  return String(JSON.stringify(typeof value === 'bigint' ? value.toString() : value))
}

export function stableSqliteRows<T>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) =>
    compare(stableSqliteObservation(left), stableSqliteObservation(right)),
  )
}

function relationInput(database: string, relation: string) {
  return { namespace: [{ role: 'database' as const, spelling: database }], relation }
}

function relationSpelling(identity: CanonicalRelationIdentity): string {
  return `${identity.namespace.map((segment) => `${segment.role}:${segment.identifier.spelling}`).join('\0')}\0${identity.relation.spelling}`
}

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

type NativeProof = (sql: string) => NativeDefinitionEvidence

type TableProofDecisions = {
  native: NativeProof
  columns: (
    definition: CatalogRelation['nativeDefinition'],
  ) => ReturnType<typeof decodeCatalogColumns>
  options: () => CatalogTable['options']['items']
}

/** Retains a recognized failed decision so recovery sees the same evidence. */
function rememberMetadataDecision<T>(prove: () => T): () => T {
  let result: { value: T } | { error: SqliteTableMetadataError } | undefined
  return () => {
    result ??= captureMetadataDecision(prove)

    if ('error' in result) throw result.error

    return result.value
  }
}

function captureMetadataDecision<T>(prove: () => T) {
  try {
    return { value: prove() }
  } catch (error) {
    if (!(error instanceof SqliteTableMetadataError)) throw error

    return { error }
  }
}

function relationProofDecisions(
  row: TableRow,
  schema: SchemaRow | undefined,
  evidence: SqliteTableObservations,
  identities: CanonicalRelationIdentityModule,
  native: NativeProof,
): TableProofDecisions {
  let columns: (() => ReturnType<typeof decodeCatalogColumns>) | undefined
  const options = rememberMetadataDecision(() => {
    if (row.type === 'table' || row.type === 'virtual')
      verifyNativeTableEvidence(row, schema?.sql ?? null, native)

    return catalogTableOptions(row)
  })

  return {
    native,
    options,
    columns(definition) {
      columns ??= rememberMetadataDecision(() =>
        decodeCatalogColumns(
          row,
          schema,
          evidence.xinfo.get(row.name) ?? [],
          definition,
          identities,
        ),
      )
      return columns()
    },
  }
}

export type SqliteTableObservations = {
  xinfo: Map<string, XInfoRow[]>
  indexLists: Map<string, IndexListRow[]>
  indexInfos: Map<string, IndexInfoRow[]>
  foreignKeys: Map<string, ForeignKeyRow[]>
  errors: ReadonlyMap<string, string>
}

export type TableRow = {
  schema: string
  name: string
  type: string
  ncol: number
  wr: number
  strict: number
}

export type SchemaRow = {
  type: string
  name: string
  tbl_name: string
  sql: string | null
}

export type XInfoRow = {
  cid: number
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
}

export type IndexListRow = {
  seq: number
  name: string
  unique: number
  origin: string
  partial: number
}

export type IndexInfoRow = {
  seqno: number
  cid: number
  name: string | null
  desc: number
  coll: string | null
  key: number
}

export type ForeignKeyRow = {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  on_update: string
  on_delete: string
  match: string
}

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

  throw new SqliteTableMetadataError(
    `Malformed SQLite schema SQL: unterminated ${description}`,
  )
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
      throw new SqliteTableMetadataError(
        'Malformed SQLite schema SQL: unterminated block comment',
      )
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

type DefinitionToken = {
  kind: 'word' | 'identifier' | 'string' | 'symbol'
  value: string
  raw: string
}

type NativeIndexTerm = { name: string; coll: string; desc: boolean }

type NativeColumnEvidence = {
  name: string
  type: string
  collation: string
  notNull: boolean
  default: string | null
  hidden: 0 | 2 | 3
}

type NativeConstraintEvidence = {
  primaryKey: { columns: string[]; terms: NativeIndexTerm[]; rowidAlias: boolean } | null
  keys: { origin: 'pk' | 'u'; terms: NativeIndexTerm[] }[]
  foreignKeys: {
    columns: string[]
    table: string
    referencedColumns: string[] | null
    onDelete: string
    onUpdate: string
  }[]
}

type NativeDefinitionEvidence = NativeConstraintEvidence & {
  kind: 'table' | 'virtual'
  strict: boolean
  withoutRowid: boolean
  columns: NativeColumnEvidence[]
}

function definitionBlockCommentEnd(sql: string, index: number): number {
  const end = sql.indexOf('*/', index + 2)

  if (end < 0)
    throw new SqliteTableMetadataError(
      'Malformed SQLite schema SQL: unterminated block comment',
    )

  return end + 2
}

function definitionWordEnd(sql: string, index: number): number {
  let end = index + 1
  while (end < sql.length && /[A-Za-z0-9_$\u0080-\uFFFF]/.test(sql[end]!)) end++
  return end
}

/** Keeps clause boundaries and quoted identifiers when checking native constraints. */
function definitionTokens(sql: string): DefinitionToken[] {
  const tokens: DefinitionToken[] = []
  let index = 0

  while (index < sql.length) {
    const char = sql[index]!

    if (/\s/.test(char)) {
      index++
    } else if (char === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index + 2)
      index = end < 0 ? sql.length : end + 1
    } else if (char === '/' && sql[index + 1] === '*') {
      index = definitionBlockCommentEnd(sql, index)
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      const close = char === '[' ? ']' : char
      const end = quotedSqlEnd(
        sql,
        index,
        close,
        close !== ']',
        char === "'" ? 'string' : 'quoted identifier',
      )

      const raw = sql.slice(index + 1, end - 1)
      tokens.push({
        kind: char === "'" ? 'string' : 'identifier',
        value: close === ']' ? raw : raw.replaceAll(close + close, close),
        raw: sql.slice(index, end),
      })

      index = end
    } else if (/[A-Za-z0-9_$\u0080-\uFFFF]/.test(char)) {
      const end = definitionWordEnd(sql, index)
      tokens.push({
        kind: 'word',
        value: sql.slice(index, end),
        raw: sql.slice(index, end),
      })

      index = end
    } else {
      tokens.push({ kind: 'symbol', value: char, raw: char })
      index++
    }
  }

  return tokens
}

function definitionWord(token: DefinitionToken | undefined, word: string): boolean {
  return (
    token?.kind === 'word' &&
    asciiFoldSqliteIdentifier(token.value) === word.toLowerCase()
  )
}

function definitionIdentifier(token: DefinitionToken | undefined): string {
  if (token?.kind === 'word' || token?.kind === 'identifier' || token?.kind === 'string')
    return token.value

  throw new SqliteTableMetadataError(
    'SQLite native constraint has an unparseable identifier',
  )
}

/** Splits a parenthesized native clause at commas outside nested expressions. */
function definitionSegments(
  tokens: readonly DefinitionToken[],
  open: number,
): {
  segments: DefinitionToken[][]
  end: number
} {
  if (tokens[open]?.kind !== 'symbol' || tokens[open].value !== '(')
    throw new SqliteTableMetadataError('SQLite native constraint has no column list')

  const segments: DefinitionToken[][] = [[]]
  let depth = 1
  for (let index = open + 1; index < tokens.length; index++) {
    const token = tokens[index]!

    if (token.kind === 'symbol' && token.value === '(') depth++
    if (token.kind === 'symbol' && token.value === ')') depth--
    if (depth === 0) return { segments, end: index }

    if (token.kind === 'symbol' && token.value === ',' && depth === 1) segments.push([])
    else segments.at(-1)!.push(token)
  }

  throw new SqliteTableMetadataError(
    'Malformed SQLite schema SQL: unterminated column list',
  )
}

function definitionColumns(tokens: readonly DefinitionToken[], open: number): string[] {
  return definitionSegments(tokens, open).segments.map((segment) =>
    definitionIdentifier(segment[0]),
  )
}

function definitionIndexTerms(
  tokens: readonly DefinitionToken[],
  open: number,
  columnCollations: ReadonlyMap<string, string>,
): NativeIndexTerm[] {
  return definitionSegments(tokens, open).segments.map((segment) => {
    const name = definitionIdentifier(segment[0])
    let coll = columnCollations.get(asciiFoldSqliteIdentifier(name)) ?? 'BINARY'
    let desc = false
    for (let index = 1; index < segment.length; index++) {
      if (definitionWord(segment[index], 'COLLATE'))
        coll = definitionIdentifier(segment[index + 1])

      if (definitionWord(segment[index], 'DESC')) desc = true
    }

    return { name, coll, desc }
  })
}

function nativeForeignKey(
  segment: readonly DefinitionToken[],
  columns: string[],
  reference: number,
): NativeConstraintEvidence['foreignKeys'][number] {
  const table = definitionIdentifier(segment[reference + 1])
  const target = segment.at(reference + 2)
  const referencedColumns =
    target?.kind === 'symbol' && target.value === '('
      ? definitionColumns(segment, reference + 2)
      : null

  const actions = { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' }
  const actionStart =
    referencedColumns === null
      ? reference + 2
      : definitionSegments(segment, reference + 2).end + 1

  for (let index = actionStart; index < segment.length; index++) {
    if (definitionWord(segment[index], 'REFERENCES')) break
    if (!definitionWord(segment[index], 'ON')) continue

    const kind = definitionWord(segment[index + 1], 'DELETE')
      ? 'onDelete'
      : definitionWord(segment[index + 1], 'UPDATE')
        ? 'onUpdate'
        : null

    if (kind === null) continue

    const first = definitionIdentifier(segment[index + 2]).replace(/[a-z]/g, (letter) =>
      letter.toUpperCase(),
    )

    const second =
      first === 'SET' || first === 'NO'
        ? ` ${definitionIdentifier(segment[index + 3]).replace(/[a-z]/g, (letter) => letter.toUpperCase())}`
        : ''

    actions[kind] = first + second
  }

  return { columns, table, referencedColumns, ...actions }
}

function definitionSegmentHead(segment: readonly DefinitionToken[]) {
  const start = definitionWord(segment[0], 'CONSTRAINT') ? 2 : 0
  const tableClause =
    definitionWord(segment[start], 'PRIMARY') ||
    definitionWord(segment[start], 'UNIQUE') ||
    definitionWord(segment[start], 'FOREIGN') ||
    definitionWord(segment[start], 'CHECK') ||
    definitionWord(segment[0], 'CONSTRAINT')

  return {
    start: tableClause ? start : 1,
    column: tableClause ? null : definitionIdentifier(segment[0]),
  }
}

/** Reconstructs token SQL without comments or insignificant whitespace. */
function definitionSql(tokens: readonly DefinitionToken[]): string {
  let sql = ''
  let previous: DefinitionToken | undefined

  for (const token of tokens) {
    const separated =
      previous !== undefined &&
      previous.kind !== 'symbol' &&
      token.kind !== 'symbol' &&
      !(definitionWord(previous, 'X') && token.kind === 'string')

    sql += (separated ? ' ' : '') + token.raw
    previous = token
  }

  return sql
}

/** Finds a top-level token matching a column-constraint predicate. */
function definitionTopLevelIndex(
  segment: readonly DefinitionToken[],
  start: number,
  predicate: (index: number) => boolean,
): number {
  let depth = 0

  for (let index = start; index < segment.length; index++) {
    const token = segment[index]!

    if (token.kind === 'symbol' && token.value === '(') depth++
    if (token.kind === 'symbol' && token.value === ')') depth--
    if (depth === 0 && predicate(index)) return index
  }

  return -1
}

/** Recognizes a real column constraint without consuming type-name keywords. */
function definitionColumnConstraintAt(
  segment: readonly DefinitionToken[],
  index: number,
): boolean {
  const token = segment[index]

  return (
    definitionWord(token, 'CONSTRAINT') ||
    definitionWord(token, 'PRIMARY') ||
    definitionWord(token, 'NOT') ||
    definitionWord(token, 'NULL') ||
    definitionWord(token, 'UNIQUE') ||
    definitionWord(token, 'CHECK') ||
    definitionWord(token, 'DEFAULT') ||
    definitionWord(token, 'COLLATE') ||
    definitionWord(token, 'REFERENCES') ||
    definitionGeneratedStart(segment, index) ||
    (definitionWord(token, 'AS') && segment[index + 1]?.value === '(')
  )
}

/** Distinguishes a generated-column clause from GENERATED used in a type name. */
function definitionGeneratedStart(
  segment: readonly DefinitionToken[],
  index: number,
): boolean {
  if (!definitionWord(segment[index], 'GENERATED')) return false

  const asIndex = definitionWord(segment[index + 1], 'ALWAYS') ? index + 2 : index + 1

  return definitionWord(segment[asIndex], 'AS') && segment[asIndex + 1]?.value === '('
}

/** Extracts one ordinary-table column's independently retained native facts. */
function definitionColumnEvidence(
  segment: readonly DefinitionToken[],
): NativeColumnEvidence | null {
  const { column } = definitionSegmentHead(segment)

  if (column === null) return null

  const firstConstraint = definitionTopLevelIndex(segment, 1, (index) =>
    definitionColumnConstraintAt(segment, index),
  )

  const constraintStart = firstConstraint < 0 ? segment.length : firstConstraint
  const type = definitionSql(segment.slice(1, constraintStart))
  const notNull =
    definitionTopLevelIndex(
      segment,
      constraintStart,
      (index) =>
        definitionWord(segment[index], 'NOT') &&
        definitionWord(segment[index + 1], 'NULL'),
    ) >= 0

  const defaultSql = definitionColumnDefault(segment, constraintStart)
  const generatedIndex = definitionTopLevelIndex(
    segment,
    constraintStart,
    (index) => definitionWord(segment[index], 'AS') && segment[index + 1]?.value === '(',
  )

  let hidden: NativeColumnEvidence['hidden'] = 0

  if (generatedIndex >= 0) {
    const expressionEnd = definitionSegments(segment, generatedIndex + 1).end
    hidden = definitionWord(segment[expressionEnd + 1], 'STORED') ? 3 : 2
  }

  return {
    name: column,
    type,
    collation: definitionColumnCollation(segment) ?? 'BINARY',
    notNull,
    default: defaultSql,
    hidden,
  }
}

/** Extracts a DEFAULT clause up to the next top-level column constraint. */
function definitionColumnDefault(
  segment: readonly DefinitionToken[],
  constraintStart: number,
): string | null {
  const defaultIndex = definitionTopLevelIndex(segment, constraintStart, (index) =>
    definitionWord(segment[index], 'DEFAULT'),
  )

  if (defaultIndex < 0) return null

  const defaultEnd = definitionTopLevelIndex(segment, defaultIndex + 1, (index) => {
    if (index === defaultIndex + 1) return false

    return definitionColumnConstraintAt(segment, index)
  })

  return definitionSql(
    segment.slice(defaultIndex + 1, defaultEnd < 0 ? segment.length : defaultEnd),
  )
}

/** Finds a column's own collation outside defaults and other expressions. */
function definitionColumnCollation(segment: readonly DefinitionToken[]): string | null {
  let depth = 0
  for (let index = 1; index < segment.length; index++) {
    const token = segment[index]!

    if (token.kind === 'symbol' && token.value === '(') depth++
    if (token.kind === 'symbol' && token.value === ')') depth--

    if (depth === 0 && definitionWord(token, 'COLLATE'))
      return definitionIdentifier(segment[index + 1])
  }

  return null
}

function definitionPrimaryKey(
  segment: readonly DefinitionToken[],
  index: number,
  column: string | null,
  collations: ReadonlyMap<string, string>,
): NonNullable<NativeConstraintEvidence['primaryKey']> {
  const terms =
    column === null
      ? definitionIndexTerms(segment, index + 2, collations)
      : [
          {
            name: column,
            coll: collations.get(asciiFoldSqliteIdentifier(column)) ?? 'BINARY',
            desc: definitionWord(segment[index + 2], 'DESC'),
          },
        ]

  const columns = terms.map((term) => term.name)
  return {
    columns,
    terms,
    rowidAlias:
      column === null
        ? columns.length === 1
        : !definitionWord(segment[index + 2], 'DESC'),
  }
}

function definitionUnique(
  segment: readonly DefinitionToken[],
  index: number,
  column: string | null,
  collations: ReadonlyMap<string, string>,
): NativeIndexTerm[] {
  if (column === null) return definitionIndexTerms(segment, index + 1, collations)

  return [
    {
      name: column,
      coll: collations.get(asciiFoldSqliteIdentifier(column)) ?? 'BINARY',
      desc: false,
    },
  ]
}

function definitionForeignKey(
  segment: readonly DefinitionToken[],
  index: number,
): { key: NativeConstraintEvidence['foreignKeys'][number]; end: number } {
  const source = definitionColumns(segment, index + 2)
  const end = definitionSegments(segment, index + 2).end

  if (!definitionWord(segment[end + 1], 'REFERENCES'))
    throw new SqliteTableMetadataError(
      'SQLite native foreign key has no REFERENCES clause',
    )

  return { key: nativeForeignKey(segment, source, end + 1), end }
}

function decodeDefinitionSegment(
  segment: readonly DefinitionToken[],
  collations: ReadonlyMap<string, string>,
): NativeConstraintEvidence {
  const result: NativeConstraintEvidence = {
    primaryKey: null,
    keys: [],
    foreignKeys: [],
  }

  const { start, column } = definitionSegmentHead(segment)
  let depth = 0

  for (let index = start; index < segment.length; index++) {
    const token = segment[index]!

    if (token.kind === 'symbol' && token.value === '(') depth++
    if (token.kind === 'symbol' && token.value === ')') depth--
    if (depth !== 0 || token.kind !== 'word') continue

    if (definitionWord(token, 'PRIMARY') && definitionWord(segment[index + 1], 'KEY')) {
      result.primaryKey = definitionPrimaryKey(segment, index, column, collations)
      result.keys.push({ origin: 'pk', terms: result.primaryKey.terms })
      index++
      continue
    }

    if (definitionWord(token, 'UNIQUE')) {
      const terms = definitionUnique(segment, index, column, collations)
      result.keys.push({ origin: 'u', terms })
      continue
    }

    if (definitionWord(token, 'FOREIGN') && definitionWord(segment[index + 1], 'KEY')) {
      const foreign = definitionForeignKey(segment, index)
      result.foreignKeys.push(foreign.key)
      index = foreign.end + 2
      continue
    }

    if (definitionWord(token, 'REFERENCES') && column !== null)
      result.foreignKeys.push(nativeForeignKey(segment, [column], index))
  }

  return result
}

/** Reads actual CREATE TABLE facts, excluding defaults and comments as syntax. */
function nativeDefinitionEvidence(sql: string): NativeDefinitionEvidence {
  const tokens = definitionTokens(sql)
  const tableKeyword = tokens.findIndex((token) => definitionWord(token, 'TABLE'))

  if (tableKeyword < 0)
    throw new SqliteTableMetadataError('SQLite native definition has no TABLE clause')

  const kind = tokens
    .slice(0, tableKeyword)
    .some((token) => definitionWord(token, 'VIRTUAL'))
    ? 'virtual'
    : 'table'

  if (kind === 'virtual')
    return {
      kind,
      strict: false,
      withoutRowid: false,
      columns: [],
      primaryKey: null,
      keys: [],
      foreignKeys: [],
    }

  const body = tokens.findIndex((token) => token.kind === 'symbol' && token.value === '(')

  if (body < 0)
    throw new SqliteTableMetadataError('SQLite table definition has no column list')

  const definition = definitionSegments(tokens, body)

  const columns = definition.segments
    .map((segment) => definitionColumnEvidence(segment))
    .filter((column): column is NativeColumnEvidence => column !== null)

  const collations = new Map(
    columns.map((column) => [asciiFoldSqliteIdentifier(column.name), column.collation]),
  )

  const result: NativeDefinitionEvidence = {
    kind,
    ...definitionTableOptions(tokens, definition.end),
    columns,
    primaryKey: null,
    keys: [],
    foreignKeys: [],
  }

  for (const segment of definition.segments) {
    const part = decodeDefinitionSegment(segment, collations)

    if (part.primaryKey && result.primaryKey)
      throw new SqliteTableMetadataError(
        'SQLite native definition has multiple primary keys',
      )

    result.primaryKey ??= part.primaryKey
    result.keys.push(...part.keys)
    result.foreignKeys.push(...part.foreignKeys)
  }

  return result
}

/** Reads STRICT and WITHOUT ROWID from the suffix after the table body. */
function definitionTableOptions(tokens: readonly DefinitionToken[], bodyEnd: number) {
  const suffix = tokens.slice(bodyEnd + 1)

  return {
    strict: suffix.some((token) => definitionWord(token, 'STRICT')),
    withoutRowid: suffix.some(
      (token, index) =>
        definitionWord(token, 'WITHOUT') && definitionWord(suffix[index + 1], 'ROWID'),
    ),
  }
}

/** Tests for an unquoted SQL token outside strings and comments. */
function hasSqlToken(sql: string, wanted: string): boolean {
  return hasSqlTokens(sql, [wanted])
}

/** Checks reservation-only definitions with the same native SQL scanner as table proof. */
export function containsNamedSqliteConstraint(sql: string): boolean {
  return hasSqlToken(sql, 'CONSTRAINT')
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

  throw new SqliteTableMetadataError(
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

/** Establishes local management before proving table members. */
function initialRelationManagement(
  row: TableRow,
  schema: SchemaRow | undefined,
  nativeDefinition: CatalogRelation['nativeDefinition'],
) {
  let initialManaged =
    row.type === 'table' &&
    row.wr === 0 &&
    row.strict === 0 &&
    schema?.sql !== null &&
    schema !== undefined
  const opaque: OpaqueCatalogObject[] = []

  initialManaged = classifySqliteRelationManagement(
    row,
    initialManaged,
    opaque,
    nativeDefinition,
  )

  return { managed: initialManaged, opaque }
}

/** Marks unsupported native relation kinds and table options as unmanaged. */
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
      throw new SqliteTableMetadataError(
        `Duplicate SQLite table_xinfo cid for ${JSON.stringify(row.name)}`,
      )

    const columnKey = identities.member('column', column.name).comparisonKey

    if (seenColumnNames.has(columnKey))
      throw new SqliteTableMetadataError(
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
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} table_list ncol does not match table_xinfo`,
    )

  if (columns.some((column, index) => column.cid !== index))
    throw new SqliteTableMetadataError(
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

function validateAuxiliaryEntries(info: IndexInfoRow[], index: IndexListRow): void {
  for (const auxiliary of info.filter((entry) => entry.key === 0)) {
    if (
      auxiliary.cid < -2 ||
      auxiliary.cid === -2 ||
      (auxiliary.cid === -1 && auxiliary.name !== null) ||
      (auxiliary.cid >= 0 && auxiliary.name === null)
    )
      throw new SqliteTableMetadataError(
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
      throw new SqliteTableMetadataError(
        `SQLite index ${JSON.stringify(index.name)} has a rowid auxiliary marked as a key term`,
      )

    if (entry.cid === -2 && entry.name !== null)
      throw new SqliteTableMetadataError(
        `SQLite index ${JSON.stringify(index.name)} has a malformed expression term`,
      )

    if (entry.cid < -2)
      throw new SqliteTableMetadataError(
        `SQLite index ${JSON.stringify(index.name)} has an invalid column id`,
      )

    if (entry.cid < 0 || entry.name === null) {
      simple = false
      continue
    }

    const referencedColumn = columns.find((column) => column.cid === entry.cid)

    if (referencedColumn === undefined || referencedColumn.name !== entry.name)
      throw new SqliteTableMetadataError(
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
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has non-contiguous index_list sequences`,
    )

  if (
    new Set(indexes.map((index) => identities.member('index', index.name).comparisonKey))
      .size !== indexes.length
  )
    throw new SqliteTableMetadataError(
      `Duplicate SQLite index_list name on ${JSON.stringify(row.name)}`,
    )

  const pkIndexes = indexes.filter((index) => index.origin === 'pk')

  if (pkIndexes.length > 1)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has multiple primary-key indexes`,
    )

  const pkIndex = pkIndexes.at(0)

  if (pkIndex && (pkIndex.unique !== 1 || pkIndex.partial !== 0))
    throw new SqliteTableMetadataError(
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

export const compareSqliteOpaque = byOpaque

function relationKind(row: TableRow): CatalogRelation['kind'] {
  if (row.type === 'view') return 'view'
  if (row.type === 'virtual') return 'virtualTable'
  if (row.type === 'shadow') return 'shadowTable'

  return 'table'
}

function relationDefinition(row: TableRow, schema: SchemaRow | undefined) {
  /** Rejects native relation rows outside the supported catalog representation. */
  function assertSupportedRow(): void {
    if (
      row.type !== 'table' &&
      row.type !== 'view' &&
      row.type !== 'virtual' &&
      row.type !== 'shadow'
    ) {
      throw new SqliteTableMetadataError(
        `Malformed SQLite table_list row: unsupported type ${JSON.stringify(row.type)}`,
      )
    }

    if (row.type === 'table' && schema === undefined) {
      throw new SqliteTableMetadataError(
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

  assertSupportedRow()
  const nativeDefinition = relationNativeDefinition()
  const tableKind = relationKind(row)

  return { nativeDefinition, tableKind }
}

/** Decodes primary-key semantics and applies rowid generation to its column. */
function createPrimaryKey(
  row: TableRow,
  indexInfos: Map<string, IndexInfoRow[]>,
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
  native: NativeProof,
): SqliteIndexEvidence {
  const keyEntries = validateIndexSequence(info, index)

  const indexSql =
    schemaRows.find(
      (entry) =>
        entry.type === 'index' &&
        identities.member('index', entry.name).comparisonKey ===
          identities.member('index', index.name).comparisonKey,
    )?.sql ?? null

  if (index.origin === 'c') {
    if (indexSql === null)
      throw new SqliteTableMetadataError(
        `SQLite user index ${JSON.stringify(index.name)} is missing sqlite_schema definition`,
      )

    const { columnsForIndex, simple } = decodeIndexColumns(keyEntries, index, columns)
    verifyNativeIndexAgainstTable(index, indexSql, simple, createSql, native)

    return {
      managed: simple,
      catalogIndex: decodeSqliteUserIndex(index, columnsForIndex, simple, indexSql),
    }
  } else if (index.origin === 'u') {
    const { columnsForIndex, simple } = decodeIndexColumns(keyEntries, index, columns)

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

/** Cross-checks a user index using collations retained in its table definition. */
function verifyNativeIndexAgainstTable(
  index: IndexListRow,
  indexSql: string,
  observedSimple: boolean,
  tableSql: string | null,
  native: NativeProof,
): void {
  if (tableSql === null)
    throw new SqliteTableMetadataError(
      `SQLite user index ${JSON.stringify(index.name)} is missing native table definition`,
    )

  const nativeColumns = native(tableSql).columns
  const columnCollations = new Map(
    nativeColumns.map((column) => [
      asciiFoldSqliteIdentifier(column.name),
      column.collation,
    ]),
  )

  verifyNativeIndexSemantics(index, indexSql, observedSimple, columnCollations)
}

/** Cross-checks user-index simplicity and partiality against CREATE INDEX SQL. */
function verifyNativeIndexSemantics(
  index: IndexListRow,
  sql: string,
  observedSimple: boolean,
  columnCollations: ReadonlyMap<string, string>,
): void {
  const tokens = definitionTokens(sql)
  const on = tokens.findIndex((token) => definitionWord(token, 'ON'))
  const open = tokens.findIndex(
    (token, position) => position > on && token.kind === 'symbol' && token.value === '(',
  )

  if (on < 0 || open < 0)
    throw new SqliteTableMetadataError(
      `SQLite user index ${JSON.stringify(index.name)} has malformed native definition`,
    )

  const terms = definitionSegments(tokens, open)
  const end = terms.end
  const partial = tokens.slice(end + 1).some((token) => definitionWord(token, 'WHERE'))

  if (partial !== (index.partial === 1))
    throw new SqliteTableMetadataError(
      `SQLite user index ${JSON.stringify(index.name)} has inconsistent native partial-index evidence`,
    )

  const simple =
    !partial &&
    terms.segments.every((term) => definitionIndexTermIsSimple(term, columnCollations))

  if (simple !== observedSimple)
    throw new SqliteTableMetadataError(
      `SQLite user index ${JSON.stringify(index.name)} has inconsistent native index-semantics evidence`,
    )
}

/** Recognizes one ascending column term whose effective native collation is BINARY. */
function definitionIndexTermIsSimple(
  term: readonly DefinitionToken[],
  columnCollations: ReadonlyMap<string, string>,
): boolean {
  if (term.length === 0) return false

  const head = term[0]!

  if (head.kind !== 'identifier' && head.kind !== 'word' && head.kind !== 'string')
    return false

  if (
    head.kind === 'word' &&
    !/^[A-Za-z_$\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*$/.test(head.value)
  )
    return false

  const nativeCollation = columnCollations.get(asciiFoldSqliteIdentifier(head.value))

  if (nativeCollation === undefined) return false

  let collation = nativeCollation

  for (let index = 1; index < term.length; index++) {
    if (definitionWord(term[index], 'ASC')) continue

    if (definitionWord(term[index], 'COLLATE')) {
      collation = definitionIdentifier(term[index + 1])
      index++
      continue
    }

    return false
  }

  return asciiFoldSqliteIdentifier(collation) === 'binary'
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
    throw new SqliteTableMetadataError(
      `SQLite index ${JSON.stringify(index.name)} has non-contiguous index_xinfo seqnos`,
    )

  const keyEntries = info
    .filter((entry) => entry.key === 1)
    .sort((a, b) => a.seqno - b.seqno)

  if (keyEntries.some((entry, position) => entry.seqno !== position))
    throw new SqliteTableMetadataError(
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
  evidence: SqliteTableObservations,
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
    throw new SqliteTableMetadataError(
      `SQLite foreign-key group on ${JSON.stringify(row.name)} has non-contiguous sequence`,
    )

  const first = group[0]!
  const onDelete = action(first.on_delete, 'foreign_key_list', 0)
  const onUpdate = action(first.on_update, 'foreign_key_list', 0)

  if (!foreignGroupIsConsistent(group, first))
    throw new SqliteTableMetadataError(
      `SQLite foreign-key group on ${JSON.stringify(row.name)} is inconsistent`,
    )

  const sourceColumns = group.map((entry) => {
    const source = columns.find(
      (column) =>
        identities.member('column', column.name).comparisonKey ===
        identities.member('column', entry.from).comparisonKey,
    )

    if (source === undefined)
      throw new SqliteTableMetadataError(
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
  const { row, evidence, identities, initial, decisions } = input
  const { indexInfos, foreignKeys } = evidence
  const tableOpaque = initial.opaque
  const structure = decodeTableStructure({
    ...input,
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

  if (row.type === 'table')
    verifyNativeConstraintEvidence(row, createSql, evidence, columns, decisions.native)

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
    decisions.options(),
    tableOpaque,
    identities,
  )

  return { table, managed }
}

/** Requires each native constraint to have matching structured observations. */
function verifyNativeConstraintEvidence(
  row: TableRow,
  sql: string | null,
  evidence: SqliteTableObservations,
  columns: XInfoRow[],
  parseNative: NativeProof,
): void {
  if (sql === null)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has no native constraint evidence`,
    )

  const native = parseNative(sql)
  verifyNativeColumns(row, native, columns)
  const rowidAlias = verifyNativePrimaryKey(row, native, evidence, columns)
  verifyNativeKeyIndexes(row, native, evidence, rowidAlias)
  verifyNativeForeignKeys(row, native, evidence)
}

/** Finds a closing type-name quote without interpreting its contents as SQL. */
function nativeTypeQuoteEnd(
  type: string,
  index: number,
  close: string,
  doubledEscape: boolean,
): number {
  for (let cursor = index + 1; cursor < type.length; cursor++) {
    if (type[cursor] !== close) continue

    if (doubledEscape && type[cursor + 1] === close) cursor++
    else return cursor
  }

  return -1
}

type NativeTypePart = { kind: 'literal' | 'symbol' | 'word'; value: string }

/** Parses retained type SQL while preserving decoded quoted contents as one literal. */
function nativeTypeParts(type: string): NativeTypePart[] {
  const parts: NativeTypePart[] = []
  let word = ''
  const flush = () => {
    if (word.length > 0) parts.push({ kind: 'word', value: word })

    word = ''
  }

  for (let index = 0; index < type.length; index++) {
    const character = type[index]!

    const close =
      character === '[' ? ']' : character === '"' || character === '`' ? character : null

    const end =
      close === null ? -1 : nativeTypeQuoteEnd(type, index, close, close !== ']')

    if (close !== null && end >= 0) {
      flush()
      const raw = type.slice(index + 1, end)
      const value = close === ']' ? raw : raw.replaceAll(close + close, close)
      parts.push({ kind: 'literal', value })
      index = end
      continue
    }

    if (/[A-Za-z0-9_$\u0080-\uFFFF]/.test(character)) word += character
    else if (/\s/.test(character)) flush()
    else {
      flush()
      parts.push({ kind: 'symbol', value: character })
    }
  }

  flush()
  return parts
}

/** Escapes one literal retained type part for exact comparison with PRAGMA text. */
function nativeTypePatternLiteral(value: string): string {
  return asciiFoldSqliteIdentifier(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compares retained type SQL with SQLite's already-decoded table_xinfo value. */
function nativeTypeMatches(type: string, observed: string): boolean {
  const parts = nativeTypeParts(type)
  let pattern = '^'
  let previous: NativeTypePart | undefined

  for (const part of parts) {
    if (previous !== undefined)
      pattern += previous.kind === 'symbol' || part.kind === 'symbol' ? '\\s*' : '\\s+'

    pattern += nativeTypePatternLiteral(part.value)
    previous = part
  }

  return new RegExp(pattern + '$').test(asciiFoldSqliteIdentifier(observed))
}

/** Ignores insignificant whitespace and comments in equivalent SQLite defaults. */
function nativeDefaultSignature(sql: string): string {
  return definitionTokens(normalizeSqliteDefaultExpression(sql))
    .map((token) =>
      token.kind === 'word' || token.kind === 'identifier'
        ? `${token.kind}:${asciiFoldSqliteIdentifier(token.value)}`
        : `${token.kind}:${token.value}`,
    )
    .join('\0')
}

/** Cross-checks table_xinfo column facts against native column clauses. */
function verifyNativeColumns(
  row: TableRow,
  native: NativeDefinitionEvidence,
  columns: readonly XInfoRow[],
): void {
  const primary = new Set(
    (native.primaryKey?.columns ?? []).map(asciiFoldSqliteIdentifier),
  )

  if (
    native.columns.length !== columns.length ||
    native.columns.some(
      (column, index) =>
        asciiFoldSqliteIdentifier(column.name) !==
        asciiFoldSqliteIdentifier(columns[index]?.name ?? ''),
    )
  )
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has inconsistent native column evidence`,
    )

  for (const [index, column] of native.columns.entries()) {
    const observed = columns[index]!
    const columnLabel = `SQLite table ${JSON.stringify(row.name)} column ${JSON.stringify(observed.name)}`

    if (!nativeTypeMatches(column.type, observed.type))
      throw new SqliteTableMetadataError(
        `${columnLabel} has inconsistent native declared-type evidence`,
      )

    const notNull =
      column.notNull ||
      (native.withoutRowid && primary.has(asciiFoldSqliteIdentifier(column.name)))

    if (notNull !== (observed.notnull === 1))
      throw new SqliteTableMetadataError(
        `${columnLabel} has inconsistent native NOT NULL evidence`,
      )

    const nativeDefault =
      column.default === null ? null : nativeDefaultSignature(column.default)

    const observedDefault =
      observed.dflt_value === null ? null : nativeDefaultSignature(observed.dflt_value)

    if (nativeDefault !== observedDefault)
      throw new SqliteTableMetadataError(
        `${columnLabel} has inconsistent native default evidence`,
      )

    if (column.hidden !== observed.hidden)
      throw new SqliteTableMetadataError(
        `${columnLabel} has inconsistent native generated-column evidence`,
      )
  }
}

function sameNativeColumns(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (name, index) =>
        asciiFoldSqliteIdentifier(name) === asciiFoldSqliteIdentifier(right[index]!),
    )
  )
}

function sameNativeTerms(
  left: readonly NativeIndexTerm[],
  right: readonly NativeIndexTerm[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (term, index) =>
        asciiFoldSqliteIdentifier(term.name) ===
          asciiFoldSqliteIdentifier(right[index]!.name) &&
        asciiFoldSqliteIdentifier(term.coll) ===
          asciiFoldSqliteIdentifier(right[index]!.coll) &&
        term.desc === right[index]!.desc,
    )
  )
}

function sameNativeKeyIdentity(
  left: readonly NativeIndexTerm[],
  right: readonly NativeIndexTerm[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (term, index) =>
        asciiFoldSqliteIdentifier(term.name) ===
          asciiFoldSqliteIdentifier(right[index]!.name) &&
        asciiFoldSqliteIdentifier(term.coll) ===
          asciiFoldSqliteIdentifier(right[index]!.coll),
    )
  )
}

function verifyNativePrimaryKey(
  row: TableRow,
  native: NativeConstraintEvidence,
  evidence: SqliteTableObservations,
  columns: XInfoRow[],
): boolean {
  const pkColumns = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)

  if (
    native.primaryKey === null
      ? pkColumns.length > 0
      : !sameNativeColumns(
          native.primaryKey.columns,
          pkColumns.map((column) => column.name),
        )
  )
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has inconsistent native primary-key evidence`,
    )

  const rowidAlias =
    row.wr === 0 &&
    native.primaryKey?.rowidAlias === true &&
    pkColumns.length === 1 &&
    pkColumns[0]!.type.toUpperCase() === 'INTEGER'

  const pkIndex = (evidence.indexLists.get(row.name) ?? []).find(
    (index) => index.origin === 'pk',
  )

  if (pkColumns.length > 0 && !rowidAlias && !pkIndex)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} is missing primary-key index evidence`,
    )

  if (rowidAlias && pkIndex)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has contradictory rowid index evidence`,
    )

  return rowidAlias
}

function verifyNativeKeyIndexes(
  row: TableRow,
  native: NativeConstraintEvidence,
  evidence: SqliteTableObservations,
  rowidAlias: boolean,
): void {
  const groups: { origin: 'pk' | 'u'; terms: NativeIndexTerm[] }[] = []
  for (const clause of native.keys) {
    if (clause.origin === 'pk' && rowidAlias) continue

    const shared = groups.find((group) =>
      sameNativeKeyIdentity(group.terms, clause.terms),
    )

    if (shared) shared.origin = clause.origin === 'pk' ? 'pk' : shared.origin
    else groups.push({ ...clause })
  }

  const indexes = (evidence.indexLists.get(row.name) ?? [])
    .filter((index) => index.origin === 'u' || index.origin === 'pk')
    .map((index) => ({
      origin: index.origin,
      terms: (evidence.indexInfos.get(`${row.name}\0${index.name}`) ?? [])
        .filter((term) => term.key === 1)
        .sort((a, b) => a.seqno - b.seqno)
        .map((term) => ({
          name: term.name ?? '',
          coll: term.coll ?? '',
          desc: term.desc === 1,
        })),
    }))

  for (const group of groups) {
    const match = indexes.findIndex(
      (index) =>
        index.origin === group.origin && sameNativeTerms(index.terms, group.terms),
    )

    if (match < 0) {
      const contradictory = indexes.some(
        (index) =>
          index.origin === group.origin &&
          sameNativeKeyIdentity(index.terms, group.terms),
      )

      throw new SqliteTableMetadataError(
        `SQLite table ${JSON.stringify(row.name)} ${contradictory ? 'has inconsistent' : 'is missing'} ${group.origin === 'pk' ? 'primary-key' : 'UNIQUE'} index evidence`,
      )
    }

    indexes.splice(match, 1)
  }

  if (indexes.length > 0)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has inconsistent native constraint index evidence`,
    )
}

function verifyNativeForeignKeys(
  row: TableRow,
  native: NativeConstraintEvidence,
  evidence: SqliteTableObservations,
): void {
  const observedForeignKeys = new Map<number, ForeignKeyRow[]>()
  for (const key of evidence.foreignKeys.get(row.name) ?? []) {
    const group = observedForeignKeys.get(key.id) ?? []
    group.push(key)
    observedForeignKeys.set(key.id, group)
  }

  const remaining = [...observedForeignKeys.values()].map((group) => ({
    columns: group.sort((a, b) => a.seq - b.seq).map((key) => key.from),
    table: group[0]!.table,
    referencedColumns: group.map((key) => key.to),
    onDelete: group[0]!.on_delete,
    onUpdate: group[0]!.on_update,
  }))

  for (const key of native.foreignKeys) {
    const index = remaining.findIndex(
      (observed) =>
        sameNativeColumns(key.columns, observed.columns) &&
        asciiFoldSqliteIdentifier(key.table) ===
          asciiFoldSqliteIdentifier(observed.table) &&
        (key.referencedColumns === null
          ? observed.referencedColumns.every((name) => name === null)
          : sameNativeColumns(
              key.referencedColumns,
              observed.referencedColumns.map((name) => name ?? ''),
            )) &&
        asciiFoldSqliteIdentifier(key.onDelete) ===
          asciiFoldSqliteIdentifier(observed.onDelete) &&
        asciiFoldSqliteIdentifier(key.onUpdate) ===
          asciiFoldSqliteIdentifier(observed.onUpdate),
    )

    if (index < 0)
      throw new SqliteTableMetadataError(
        `SQLite table ${JSON.stringify(row.name)} is missing foreign-key evidence`,
      )

    remaining.splice(index, 1)
  }

  if (remaining.length > 0)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has inconsistent native foreign-key evidence`,
    )
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
  const {
    indexes,
    indexInfos,
    row,
    columns,
    schemaRows,
    identities,
    constraintName,
    createSql,
  } = input

  let managed = input.managed

  const uniqueConstraints: CatalogKeyConstraint[] = []
  const catalogIndexes: CatalogIndex[] = []

  for (const index of indexes) {
    const members = indexInfos.get(`${row.name}\0${index.name}`)

    if (!members)
      throw new SqliteTableMetadataError(
        `SQLite index ${JSON.stringify(index.name)} has no index_xinfo evidence`,
      )

    const decoded = decodeCatalogIndex(
      index,
      members,
      columns,
      schemaRows,
      identities,
      constraintName,
      createSql,
      input.decisions.native,
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
  const {
    foreignKeys,
    row,
    columns,
    mainTables,
    evidence,
    identities,
    createSql,
    constraintName,
  } = input

  let managed = input.managed

  const fks: CatalogForeignKey[] = []
  const grouped = new Map<number, ForeignKeyRow[]>()
  const observed = foreignKeys.get(row.name)

  if (!observed)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has no foreign_key_list evidence`,
    )

  for (const fk of observed) {
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
 * @param decisions - Shared lazy native, column, and option proof for this relation.
 *
 * @returns Native identity, table evidence, and dependency-based management status.
 */
function buildCatalogRelation(
  row: TableRow,
  mainTables: readonly TableRow[],
  schemaRows: readonly SchemaRow[],
  evidence: SqliteTableObservations,
  identities: ReturnType<typeof sqliteIdentity.create>,
  decisions: TableProofDecisions,
): CatalogRelation {
  const identity = identities.resolve(relationInput('main', row.name))
  const schema = schemaForTable(schemaRows, row.name)

  const { nativeDefinition, tableKind } = relationDefinition(row, schema)

  if (row.type === 'table' || row.type === 'virtual') decisions.options()

  const initial = initialRelationManagement(row, schema, nativeDefinition)

  const decoded =
    row.type === 'table' || row.type === 'virtual' || row.type === 'shadow'
      ? buildCatalogTable({
          row,
          mainTables,
          schemaRows,
          evidence,
          identities,
          schema,
          nativeDefinition,
          initial,
          decisions,
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
      throw new SqliteTableMetadataError(
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
      throw new SqliteTableMetadataError(
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
      throw new SqliteTableMetadataError(
        `SQLite sqlite_schema index ${JSON.stringify(schema.name)} is missing from index_list`,
      )
}

export type SqliteProofBatchInput = {
  scopeRows: readonly TableRow[]
  mainTables: readonly TableRow[]
  schemaRows: readonly SchemaRow[]
  evidence: SqliteTableObservations
  reservationIndexLists?: ReadonlyMap<string, IndexListRow[]>
  identities: CanonicalRelationIdentityModule
}

export type SqliteProofBatchResult = {
  relations: CatalogRelation[]
  errors: Map<string, string>
  acquisitionErrors: Map<string, string>
}

function orderedMap<T>(observations: ReadonlyMap<string, T[]>): Map<string, T[]> {
  return new Map([...observations].map(([name, rows]) => [name, stableSqliteRows(rows)]))
}

function orderedProofInput(input: SqliteProofBatchInput): SqliteProofBatchInput {
  const { evidence } = input
  return {
    ...input,
    scopeRows: stableSqliteRows(input.scopeRows),
    mainTables: stableSqliteRows(input.mainTables),
    schemaRows: stableSqliteRows(input.schemaRows),
    reservationIndexLists: input.reservationIndexLists
      ? orderedMap(input.reservationIndexLists)
      : undefined,
    evidence: {
      ...evidence,
      xinfo: orderedMap(evidence.xinfo),
      indexLists: orderedMap(evidence.indexLists),
      indexInfos: orderedMap(evidence.indexInfos),
      foreignKeys: orderedMap(evidence.foreignKeys),
    },
  }
}

function ownerIndexFailure(
  owner: TableRow,
  input: SqliteProofBatchInput,
): string | undefined {
  try {
    validateOwnerIndexes(
      owner,
      input.evidence.indexLists.get(owner.name) ??
        input.reservationIndexLists?.get(owner.name) ??
        [],
      input.schemaRows,
      input.identities,
    )
  } catch (error) {
    if (!(error instanceof SqliteTableMetadataError)) throw error

    return error.message
  }
}

function memoizedNativeProof(): NativeProof {
  const cache = new Map<string, () => NativeDefinitionEvidence>()
  return (sql) => {
    let decision = cache.get(sql)

    if (!decision) {
      decision = rememberMetadataDecision(() => nativeDefinitionEvidence(sql))
      cache.set(sql, decision)
    }

    return decision()
  }
}

function proveRelation(
  row: TableRow,
  input: SqliteProofBatchInput,
  errors: Map<string, string>,
  decisions: TableProofDecisions,
): CatalogRelation {
  const { mainTables, schemaRows, evidence, identities } = input
  const invalid = errors.get(row.name)

  if (invalid)
    return unknownSqliteRelation(
      row,
      schemaRows,
      evidence,
      identities,
      invalid,
      decisions,
    )

  try {
    return buildCatalogRelation(
      row,
      mainTables,
      schemaRows,
      evidence,
      identities,
      decisions,
    )
  } catch (error) {
    if (!(error instanceof SqliteTableMetadataError)) throw error

    errors.set(row.name, error.message)
    return unknownSqliteRelation(
      row,
      schemaRows,
      evidence,
      identities,
      error.message,
      decisions,
    )
  }
}

function downgradeInvalidParents(
  rows: readonly TableRow[],
  relations: CatalogRelation[],
  input: SqliteProofBatchInput,
  errors: Map<string, string>,
  decisionsByRow: ReadonlyMap<string, TableProofDecisions>,
): void {
  const { evidence, schemaRows, identities } = input
  for (const [index, row] of rows.entries()) {
    if (errors.has(row.name)) continue

    const dependency = evidence.foreignKeys
      .get(row.name)
      ?.find((key) =>
        [...errors.keys()].some(
          (name) =>
            asciiFoldSqliteIdentifier(name) === asciiFoldSqliteIdentifier(key.table),
        ),
      )

    if (!dependency) continue

    const reason = `SQLite foreign key on ${JSON.stringify(row.name)} references invalid parent metadata`
    relations[index] = unknownSqliteRelation(
      row,
      schemaRows,
      evidence,
      identities,
      reason,
      decisionsByRow.get(row.name)!,
    )
    errors.set(row.name, reason)
  }
}

/** Proves requested tables and applies the existing single-pass invalid-parent rule. */
export function proveSqliteTables(input: SqliteProofBatchInput): SqliteProofBatchResult {
  const ordered = orderedProofInput(input)
  const { scopeRows, schemaRows, evidence, identities } = ordered
  const errors = new Map(evidence.errors)
  for (const owner of scopeRows) {
    if (errors.has(owner.name)) continue

    const failure = ownerIndexFailure(owner, ordered)

    if (failure) errors.set(owner.name, failure)
  }

  const acquisitionErrors = new Map(errors)
  const native = memoizedNativeProof()
  const rows = scopeRows.filter((row) => !row.name.startsWith('sqlite_'))
  const decisionsByRow = new Map<string, TableProofDecisions>()
  const relations = rows.map((row) => {
    const decisions = relationProofDecisions(
      row,
      schemaForTable(schemaRows, row.name),
      evidence,
      identities,
      native,
    )

    decisionsByRow.set(row.name, decisions)
    return proveRelation(row, ordered, errors, decisions)
  })

  downgradeInvalidParents(rows, relations, ordered, errors, decisionsByRow)
  relations.sort((a, b) => identities.compare(a.identity, b.identity))
  return { relations, errors, acquisitionErrors }
}

/** Cross-checks table-list kind and options against retained CREATE TABLE SQL. */
function verifyNativeTableEvidence(
  row: TableRow,
  sql: string | null,
  parseNative: NativeProof,
): void {
  if (sql === null)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has no native table evidence`,
    )

  const native = parseNative(sql)
  const observedKind = row.type === 'virtual' ? 'virtual' : 'table'

  if (native.kind !== observedKind)
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has inconsistent native table-kind evidence`,
    )

  if (native.strict !== (row.strict === 1))
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has inconsistent native STRICT evidence`,
    )

  if (native.withoutRowid !== (row.wr === 1))
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has inconsistent native WITHOUT ROWID evidence`,
    )
}

/** Preserves a proven relation identity and definition without granting management. */
function unknownSqliteRelation(
  row: TableRow,
  schemaRows: readonly SchemaRow[],
  evidence: SqliteTableObservations,
  identities: CanonicalRelationIdentityModule,
  reason: string,
  decisions: TableProofDecisions,
): CatalogRelation {
  const schema = schemaForTable(schemaRows, row.name)
  const schemaValid =
    schema?.type === (row.type === 'view' ? 'view' : 'table') &&
    asciiFoldSqliteIdentifier(schema.tbl_name) === asciiFoldSqliteIdentifier(row.name)

  const nativeDefinition =
    schemaValid && schema.sql !== null ? present(schema.sql) : unknown(reason)

  const recoveredDecisions = schemaValid
    ? decisions
    : relationProofDecisions(row, undefined, evidence, identities, decisions.native)

  const columns = recoveredSqliteColumns(
    row,
    schemaValid ? schema : undefined,
    evidence,
    nativeDefinition,
    identities,
    reason,
    recoveredDecisions,
  )

  const unavailable = { items: [], coverage: unknown(reason) }
  return {
    identity: identities.resolve(relationInput('main', row.name)),
    kind: relationKind(row),
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
            options: recoverTableOptions(reason, recoveredDecisions),
            opaqueObjects: unavailable,
          }),
  }
}

/** Preserves table options only when the native definition proves them independently. */
function recoverTableOptions(
  reason: string,
  decisions: TableProofDecisions,
): CatalogTable['options'] {
  try {
    return { items: decisions.options(), coverage: complete }
  } catch (error) {
    if (!(error instanceof SqliteTableMetadataError)) throw error

    return { items: [], coverage: unknown(reason) }
  }
}

/** Keeps valid column observations when another member observation is invalid. */
function recoveredSqliteColumns(
  row: TableRow,
  schema: SchemaRow | undefined,
  evidence: SqliteTableObservations,
  nativeDefinition: CatalogRelation['nativeDefinition'],
  identities: CanonicalRelationIdentityModule,
  reason: string,
  decisions: TableProofDecisions,
): CatalogTable['columns'] {
  const observed = evidence.xinfo.get(row.name)

  if (!observed || !schema) return { items: [], coverage: unknown(reason) }

  try {
    const { columns, decodedColumns } = decisions.columns(nativeDefinition)

    if (row.type === 'table') {
      const native = decisions.native(schema.sql ?? '')
      verifyNativeColumns(row, native, columns)
    }

    return {
      items: recoverRowidColumnFacts(
        row,
        schema,
        observed,
        evidence,
        decodedColumns,
        identities,
        reason,
        decisions.native,
      ),
      coverage: complete,
    }
  } catch (error) {
    if (!(error instanceof SqliteTableMetadataError)) throw error

    return { items: [], coverage: unknown(reason) }
  }
}

/** Uses validated primary-key inventory before inferring INTEGER rowid facts. */
function nativeRowidAlias(
  sql: string | null,
  column: string,
  native: NativeProof,
): boolean {
  if (sql === null) return false

  const primary = native(sql).primaryKey
  return (
    primary?.rowidAlias === true &&
    primary.columns.length === 1 &&
    asciiFoldSqliteIdentifier(primary.columns[0]!) === asciiFoldSqliteIdentifier(column)
  )
}

/** Uses validated primary-key inventory before inferring INTEGER rowid facts. */
function recoverRowidColumnFacts(
  row: TableRow,
  schema: SchemaRow,
  observed: XInfoRow[],
  evidence: SqliteTableObservations,
  columns: CatalogColumn[],
  identities: CanonicalRelationIdentityModule,
  reason: string,
  native: NativeProof,
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
    if (!(error instanceof SqliteTableMetadataError)) throw error

    return ambiguous
  }

  if (!nativeRowidAlias(schema.sql, primary[0]!.name, native)) return ambiguous

  return columns.map((column) =>
    column.name === primary[0]!.name
      ? {
          ...column,
          nullable: present(false),
          generation: present({
            kind: 'rowidAlias',
            autoIncrement: hasSqlToken(schema.sql ?? '', 'AUTOINCREMENT'),
          }),
        }
      : column,
  )
}

/** Proves primary-key and rowid semantics from columns, indexes, and native SQL. */
function decodeTablePrimaryKey(
  row: TableRow,
  columns: XInfoRow[],
  evidence: SqliteTableObservations,
  identities: ReturnType<typeof sqliteIdentity.create>,
  schema: SchemaRow | undefined,
  nativeDefinition: CatalogRelation['nativeDefinition'],
  tableOpaque: ReturnType<typeof initialRelationManagement>['opaque'],
  decodedColumns: CatalogColumn[],
  managed: boolean,
  native: NativeProof,
) {
  const { indexLists, indexInfos } = evidence
  const pks = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk)

  if (pks.some((column, index) => column.pk !== index + 1))
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has non-contiguous primary-key ordinals`,
    )

  const indexes = indexLists.get(row.name)!
  const pkIndex = validateTableIndexes(row, indexes, identities)
  const rowidAlias =
    row.wr === 0 &&
    pks.length === 1 &&
    pks[0]!.type.toUpperCase() === 'INTEGER' &&
    pkIndex === undefined &&
    schema !== undefined &&
    nativeRowidAlias(schema.sql, pks[0]!.name, native)

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
      coverage: complete,
    },
  }
}

type TableForeignKeyDecoding = {
  foreignKeys: Map<string, ForeignKeyRow[]>
  row: TableRow
  columns: XInfoRow[]
  mainTables: readonly TableRow[]
  evidence: SqliteTableObservations
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
  const { row, schema, nativeDefinition, identities, tableOpaque, evidence, decisions } =
    input

  let managed = input.managed

  if (!evidence.xinfo.has(row.name))
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has no table_xinfo evidence`,
    )

  const columnEvidence = decisions.columns(nativeDefinition)

  if (!evidence.indexLists.has(row.name))
    throw new SqliteTableMetadataError(
      `SQLite table ${JSON.stringify(row.name)} has no index_list evidence`,
    )

  const { columns } = columnEvidence
  const decodedColumns = [...columnEvidence.decodedColumns]
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
    decisions.native,
  )

  const { indexes, createSql, constraintName, pk } = primaryKeyEvidence
  managed = primaryKeyEvidence.managed
  return { columns, decodedColumns, indexes, createSql, constraintName, pk, managed }
}

type SqliteTableAssembly = {
  row: TableRow
  mainTables: readonly TableRow[]
  schemaRows: readonly SchemaRow[]
  evidence: SqliteTableObservations
  identities: ReturnType<typeof sqliteIdentity.create>
  schema: SchemaRow | undefined
  nativeDefinition: CatalogRelation['nativeDefinition']
  initial: ReturnType<typeof initialRelationManagement>
  decisions: TableProofDecisions
}

type SqliteTableStructure = {
  row: TableRow
  schema: SchemaRow | undefined
  nativeDefinition: CatalogFact<string>
  identities: ReturnType<typeof sqliteIdentity.create>
  managed: boolean
  tableOpaque: OpaqueCatalogObject[]
  evidence: SqliteTableObservations
  decisions: TableProofDecisions
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
  decisions: TableProofDecisions
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

/** Builds native user-index evidence and classifies unsupported expressions or clauses. */
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
