import type {
  CatalogConstraintNameReservation,
  CatalogDiagnostic,
  CatalogExecutor,
  CatalogFact,
  CatalogNameReservation,
  CatalogNamespace,
  CatalogNoEvidence,
  CatalogRelation,
  CatalogRequest,
  CatalogSnapshot,
  OpaqueCatalogObject,
  ResolvedCatalogRequest,
} from '@/dialects/catalog'
import type {
  CanonicalNamespaceSegment,
  CanonicalRelationIdentity,
  CanonicalRelationIdentityModule,
} from '@/migrations/canonicalRelationIdentity'
import { InvariantError } from '@/utils/error'

import { asciiFoldSqliteIdentifier, sqliteIdentity } from './identity'
import {
  SqliteTableMetadataError,
  compareSqliteOpaque,
  containsNamedSqliteConstraint,
  proveSqliteTables,
  serializeSqliteObservation as stable,
  sortSqliteRows as stableRows,
} from './tableProof'
import type {
  ForeignKeyRow,
  IndexInfoRow,
  IndexListRow,
  SchemaRow,
  TableRow,
  XInfoRow,
} from './tableProof'

const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

type Row = Record<string, unknown>

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

  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    UNPAIRED_SURROGATE.test(value)
  ) {
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

  if (
    typeof value !== 'string' ||
    value.includes('\0') ||
    UNPAIRED_SURROGATE.test(value)
  ) {
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
    const a = left[index]
    const b = right[index]
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

/** Decodes and validates table_list observations. */
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
        containsNamedSqliteConstraint(entry.sql),
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

function readSqliteVersionEvidence(versionRows: unknown[]) {
  try {
    const decoded = decodeSqliteVersion(versionRows)
    return {
      version: decoded.version,
      versionLimited:
        decoded.actualVersion[0] < 3 ||
        (decoded.actualVersion[0] === 3 && decoded.actualVersion[1] < 37),
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
    const decoded = decodeNativeRowObservation(row.name, errors, () =>
      decodeIndexListRows(rows, row.name),
    )

    if (decoded) reservationIndexLists.set(row.name, decoded)
  }

  return { xinfo, indexLists, indexInfos, foreignKeys, reservationIndexLists, errors }
}

/** Keeps an owned proof failure local to its relation. */
function decodeTableObservation<T>(
  table: string,
  errors: Map<string, string>,
  decode: () => T,
): T | undefined {
  try {
    return decode()
  } catch (error) {
    if (!(error instanceof SqliteTableMetadataError)) throw error
    if (!errors.has(table)) errors.set(table, error.message)

    return undefined
  }
}

/** Keeps a malformed successful native row local to its relation. */
function decodeNativeRowObservation<T>(
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
  const decodedColumns = decodeNativeRowObservation(row.name, errors, () =>
    decodeXInfoRows(columns, row.name),
  )

  if (decodedColumns) xinfo.set(row.name, decodedColumns)

  const indexes = await executor.execute(queries.indexes(row.name))
  const decodedIndexes = decodeNativeRowObservation(row.name, errors, () =>
    decodeIndexListRows(indexes, row.name),
  )

  if (decodedIndexes) indexLists.set(row.name, decodedIndexes)

  const keys = await executor.execute(queries.foreignKeys(row.name))
  const decodedKeys = decodeNativeRowObservation(row.name, errors, () =>
    decodeForeignKeyRows(keys, row.name),
  )

  if (decodedKeys) foreignKeys.set(row.name, decodedKeys)

  for (const index of decodedIndexes ?? []) {
    const info = await executor.execute(queries.indexInfo(index.name))
    const decodedInfo = decodeNativeRowObservation(row.name, errors, () =>
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
async function introspectSqliteCatalog(
  executor: CatalogExecutor,
  request: CatalogRequest,
): Promise<CatalogSnapshot> {
  const queryErrors = new Set<unknown>()
  const trackedExecutor = trackSqliteExecutorErrors(executor, queryErrors)

  const context = await readCatalogContext(trackedExecutor, request)

  if (context.versionError) return invalidSqliteCatalog(context, context.versionError)
  if (context.versionLimited) return versionLimitedCatalog(context)

  let inventory: Awaited<ReturnType<typeof readSqliteInventory>>
  try {
    inventory = await readSqliteInventory(trackedExecutor, context.identities)
  } catch (error) {
    if (!(error instanceof InvariantError) || queryErrors.has(error)) throw error

    return invalidSqliteCatalog(context, error.message)
  }

  let evidence: Awaited<ReturnType<typeof prepareSqliteCatalogEvidence>>
  try {
    evidence = await prepareSqliteCatalogEvidence(trackedExecutor, context, inventory)
  } catch (error) {
    if (!(error instanceof SqliteTableMetadataError) || queryErrors.has(error))
      throw error

    return invalidSqliteCatalog(context, error.message)
  }

  let reservations: ReturnType<typeof collectNameReservations>
  try {
    reservations = await collectConsistentNameReservations(
      {
        ...context,
        ...inventory,
        ...evidence,
        executor: trackedExecutor,
        evidence: {
          ...evidence.tableEvidence,
          errors: evidence.proof.acquisitionErrors,
        },
      },
      inventory.mainTables,
      inventory.hasExternalNamespace,
    )
  } catch (error) {
    if (
      queryErrors.has(error) ||
      (!(error instanceof SqliteTableMetadataError) && !(error instanceof InvariantError))
    )
      throw error

    return invalidSqliteCatalog(context, error.message)
  }

  return buildSqliteSnapshot({ ...context, ...inventory, ...evidence, reservations })
}

/** Records executor rejections so acquisition guards preserve their identity. */
function trackSqliteExecutorErrors(
  executor: CatalogExecutor,
  queryErrors: Set<unknown>,
): CatalogExecutor {
  return {
    async execute(query) {
      try {
        return await executor.execute(query)
      } catch (error) {
        queryErrors.add(error)
        throw error
      }
    },
  }
}

/** Confirms the catalog is stable before proving global name reservations. */
async function collectConsistentNameReservations(
  consistency: SqliteCatalogConsistency,
  mainTables: readonly TableRow[],
  hasExternalNamespace: boolean,
) {
  await assertCatalogUnchanged(consistency)

  return collectNameReservations(
    consistency.schemaRows,
    mainTables,
    consistency.evidence.reservationIndexLists,
    consistency.identities,
    hasExternalNamespace,
  )
}

/**
 * Assembles the SQLite catalog snapshot after inventory and consistency checks.
 *
 * @param input - Sqlite snapshot assembly inputs and shared accumulators.
 *
 * @returns The SQLite catalog snapshot after inventory and consistency checks.
 */
function buildSqliteSnapshot(input: SqliteSnapshotAssembly) {
  const {
    resolvedRequest,
    identities,
    reservations,
    version,
    namespaceContext,
    diagnostics,
  } = input

  const { names: uniqueNames, constraintNameCoverage } = reservations

  const constraintReservations: CatalogConstraintNameReservation[] = []
  const { namespace, errors } = buildMainCatalogNamespace(input)
  for (const [name, reason] of errors)
    appendMetadataDiagnostic(diagnostics, identities, name, reason)
  const invalidEvidence = errors.size > 0
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
  assertUniqueSchemaNames(schemaRows)

  const mainTables = tableRows.filter(
    (row) => row.schema === 'main' && !row.name.startsWith('sqlite_'),
  )

  return { schemaRows, tableRows, mainTables }
}

/**
 * Builds the main namespace with relation evidence and requested coverage.
 *
 * @param input - Sqlite namespace assembly inputs and shared accumulators.
 *
 * @returns The main namespace with relation evidence and requested coverage.
 */
function buildMainCatalogNamespace(input: SqliteNamespaceAssembly) {
  const { identities, completeMain, proof } = input
  const relations = proof.relations.map((relation) =>
    proof.errors.has(relation.identity.relation.spelling)
      ? relation
      : applyExternalSqliteRestrictions(relation, input),
  )

  const namespace: CatalogNamespace = {
    identity: identities.resolveNamespace(mainNamespace),
    owner: unsupportedByEngine('SQLite has no namespace owner'),
    relations: {
      items: relations,
      coverage:
        proof.errors.size > 0
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

  return { namespace, errors: proof.errors }
}

/** Applies observed dependencies after local table proof. */
function applyExternalSqliteRestrictions(
  relation: CatalogRelation,
  input: SqliteNamespaceAssembly,
): CatalogRelation {
  const opaque =
    relation.table.state === 'present'
      ? [...relation.table.value.opaqueObjects.items]
      : []

  const managed = collectSqliteDependencyEvidence(
    input.hasExternalNamespace,
    relation.management === 'managed',
    opaque,
    [...input.viewObjects, ...input.triggerObjects],
  )

  if (relation.table.state !== 'present')
    return { ...relation, management: managed ? 'managed' : 'unmanaged' }

  return {
    ...relation,
    management: managed ? 'managed' : 'unmanaged',
    table: present({
      ...relation.table.value,
      opaqueObjects: {
        items: opaque.sort(compareSqliteOpaque),
        coverage: input.hasExternalNamespace
          ? {
              state: 'partial',
              remainder: unknown(
                'Attached and temporary SQLite opaque dependencies are not fully observable',
              ),
            }
          : complete,
      },
    }),
  }
}

/** Reports a relation-associated metadata failure in the public catalog. */
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
type SqliteSnapshotAssembly = {
  schemaRows: SchemaRow[]
  scopeRows: TableRow[]
  resolvedRequest: ResolvedCatalogRequest
  identities: CanonicalRelationIdentityModule
  tableEvidence: Awaited<ReturnType<typeof readTableEvidence>>
  proof: ReturnType<typeof proveSqliteTables>
  mainTables: TableRow[]
  reservations: ReturnType<typeof collectNameReservations>
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
  const { reservationIndexLists } = tableEvidence
  const proof = proveSqliteTables({
    scopeRows,
    mainTables,
    schemaRows,
    evidence: tableEvidence,
    reservationIndexLists,
    identities,
  })

  return { scopeRows, completeMain, tableEvidence, reservationIndexLists, proof }
}

type SqliteNamespaceAssembly = {
  scopeRows: TableRow[]
  mainTables: TableRow[]
  schemaRows: SchemaRow[]
  tableEvidence: Awaited<ReturnType<typeof readTableEvidence>>
  proof: ReturnType<typeof proveSqliteTables>
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
    throw new SqliteTableMetadataError(
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
    throw new SqliteTableMetadataError(
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
    throw new SqliteTableMetadataError(
      `SQLite sqlite_schema index ${JSON.stringify(schemaRow.name)} references a missing table`,
    )
}

/**
 * Builds native user-index evidence and classifies unsupported index expressions or
 * clauses.
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

/** SQLite catalog observation. */
export const sqliteCatalog = {
  introspectCatalog: introspectSqliteCatalog,
}
