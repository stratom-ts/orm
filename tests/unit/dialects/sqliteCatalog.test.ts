import { describe, expect, it, vi } from 'vitest'

import { planMigration } from '@/ddl/migrationPlan'
import type {
  CatalogExecutor,
  CatalogRelation,
  CatalogRequest,
  CatalogSnapshot,
  CatalogTable,
} from '@/dialects'
import type { CatalogColumn } from '@/dialects/catalog'
import { sqliteCatalog } from '@/dialects/sqlite/catalog'
import { sqliteDialect } from '@/dialects/sqlite/dialect'
import { InvariantError } from '@/utils/error'

const rejectsMalformedAndInconsistentIndexObservationsWithStableMessagesData = [
  ['index-invalid-origin', 'Malformed SQLite index_list row 0: invalid origin'],
  ['index-invalid-flags', 'SQLite UNIQUE index "u_auto" has invalid flags'],
  ['index-wrong-shape', 'Malformed SQLite index_list row 0: "unique" must be an integer'],
  ['index-xinfo-wrong-flag', 'Malformed SQLite index_xinfo row 0: "desc" must be 0 or 1'],
  ['index-xinfo-expression', 'SQLite index "parent_n" has a malformed expression term'],
  [
    'index-xinfo-auxiliary',
    'SQLite index "parent_n" has malformed auxiliary index_xinfo row',
  ],
  [
    'missing-index-schema',
    'SQLite user index "missing_schema_idx" has missing or mismatched sqlite_schema evidence',
  ],
  [
    'schema-index-missing-list',
    'SQLite sqlite_schema index "missing_list_idx" is missing from index_list',
  ],
]

/** Checks that invalid successful metadata has a diagnostic and cannot prove names. */
function expectUnknownMetadata(snapshot: CatalogSnapshot, message: string): void {
  expect(snapshot.diagnostics.some((entry) => entry.message.includes(message))).toBe(true)
  expect(snapshot.nameReservations.coverage.state).toBe('unknown')
}

const ordersUnresolvedFKTargetsWithASCIICaseEquivalentIdentitiesDeterministicallyRows = [
  {
    id: 0,
    seq: 0,
    table: 'Missing',
    from: 'pa',
    to: 'id',
    on_update: 'NO ACTION',
    on_delete: 'CASCADE',
    match: 'NONE',
  },
  {
    id: 1,
    seq: 0,
    table: 'missing',
    from: 'pa',
    to: 'id',
    on_update: 'NO ACTION',
    on_delete: 'CASCADE',
    match: 'NONE',
  },
] as const

const assertBlocksMainManagementWhenAttachedOrTemporaryObjectsAreData = [
  [
    'catalog.sqlite.attached',
    'SQLite attached database "aux" is observed but its schema dependencies are not managed',
  ],
  [
    'catalog.sqlite.temporary',
    'SQLite temporary schema is observed but its dependencies are not managed',
  ],
  [
    'catalog.sqlite.trigger-dependency',
    'SQLite trigger dependencies are not resolved and may affect other tables',
  ],
  [
    'catalog.sqlite.unmanaged-relation',
    'SQLite attached relation "attached_item" is observed but its schema dependencies are not managed',
  ],
  [
    'catalog.sqlite.unmanaged-relation',
    'SQLite temporary relation "temporary_item" is observed but its schema dependencies are not managed',
  ],
  [
    'catalog.sqlite.view-dependency',
    'SQLite view dependencies are not resolved and may affect ordinary tables',
  ],
]

const nativeDefinitionCrossCheckCases = [
  [
    'native-column-type',
    'parent',
    'columns',
    'column "v" has inconsistent native declared-type evidence',
  ],
  [
    'native-column-not-null',
    'parent',
    'columns',
    'column "v" has inconsistent native NOT NULL evidence',
  ],
  [
    'native-column-default',
    'parent',
    'columns',
    'column "v" has inconsistent native default evidence',
  ],
  [
    'native-column-generated',
    'generated_t',
    'columns',
    'column "derived" has inconsistent native generated-column evidence',
  ],
  [
    'native-table-strict',
    'strict_t',
    'options',
    'has inconsistent native STRICT evidence',
  ],
  [
    'native-table-without-rowid',
    'wr',
    'options',
    'has inconsistent native WITHOUT ROWID evidence',
  ],
  [
    'native-table-virtual',
    'virt',
    'options',
    'has inconsistent native table-kind evidence',
  ],
  [
    'native-index-partial',
    'parent',
    'indexes',
    'index "rich_partial" has inconsistent native partial-index evidence',
  ],
  [
    'native-index-semantics',
    'parent',
    'indexes',
    'index "rich_desc" has inconsistent native index-semantics evidence',
  ],
] as const

const executeSqliteCatalogFixtureRows = [
  {
    id: 0,
    seq: 0,
    table: 'PARENT',
    from: 'PA',
    to: 'ID',
    on_update: 'NO ACTION',
    on_delete: 'CASCADE',
    match: 'NONE',
  },
  {
    id: 1,
    seq: 0,
    table: 'parent',
    from: 'pa',
    to: 'V',
    on_update: 'RESTRICT',
    on_delete: 'SET NULL',
    match: 'NONE',
  },
]

const executeSqliteFixtureData = [
  {
    id: 0,
    seq: 0,
    table: 'parent',
    from: 'pa',
    to: 'id',
    on_update: 'CASCADE',
    on_delete: 'SET NULL',
    match: 'NONE',
  },
  {
    id: 0,
    seq: 1,
    table: 'parent',
    from: 'pb',
    to: 'v',
    on_update: 'CASCADE',
    on_delete: 'SET NULL',
    match: 'NONE',
  },
]

const fixtureIndexListData = [
  {
    seq: 0,
    name: 'parent_n',
    unique: 0,
    origin: 'c',
    partial: 0,
  },
  { seq: 1, name: 'u_auto', unique: 1, origin: 'u', partial: 0 },
  { seq: 2, name: 'u_auto2', unique: 1, origin: 'u', partial: 0 },
  {
    seq: 3,
    name: 'rich_desc',
    unique: 0,
    origin: 'c',
    partial: 0,
  },
  {
    seq: 4,
    name: 'rich_partial',
    unique: 0,
    origin: 'c',
    partial: 1,
  },
  {
    seq: 5,
    name: 'rich_expr',
    unique: 0,
    origin: 'c',
    partial: 0,
  },
  {
    seq: 6,
    name: 'rich_coll',
    unique: 0,
    origin: 'c',
    partial: 0,
  },
]

const fixtureSchemaRowsSchema = [
  {
    type: 'table',
    name: 'parent',
    tbl_name: 'parent',
    sql: "CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, v VARCHAR(12) DEFAULT 'safe' UNIQUE, b BLOB DEFAULT TRUE UNIQUE, r DOUBLE, d DECIMAL(10,2) DEFAULT (lower('x')))",
  },
  {
    type: 'table',
    name: 'child',
    tbl_name: 'child',
    sql: 'CREATE TABLE child(id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER, FOREIGN KEY(pa,pb) REFERENCES parent(id,v) ON UPDATE CASCADE ON DELETE SET NULL)',
  },
  {
    type: 'table',
    name: 'wr',
    tbl_name: 'wr',
    sql: 'CREATE TABLE wr(id TEXT PRIMARY KEY) WITHOUT ROWID',
  },
  {
    type: 'table',
    name: 'wr_auto',
    tbl_name: 'wr_auto',
    sql: 'CREATE TABLE wr_auto(a TEXT, b TEXT, PRIMARY KEY(a,b)) WITHOUT ROWID',
  },
  {
    type: 'table',
    name: 'pk_desc',
    tbl_name: 'pk_desc',
    sql: 'CREATE TABLE pk_desc(id INTEGER PRIMARY KEY DESC)',
  },
  {
    type: 'table',
    name: 'strict_t',
    tbl_name: 'strict_t',
    sql: 'CREATE TABLE strict_t(id INTEGER) STRICT',
  },
  {
    type: 'table',
    name: 'generated_t',
    tbl_name: 'generated_t',
    sql: 'CREATE TABLE generated_t(base INTEGER, derived INTEGER GENERATED ALWAYS AS (base * 2) VIRTUAL)',
  },
  { type: 'view', name: 'v', tbl_name: 'v', sql: 'CREATE VIEW v AS SELECT 1' },
  {
    type: 'table',
    name: 'simple',
    tbl_name: 'simple',
    sql: 'CREATE TABLE simple(id INTEGER PRIMARY KEY)',
  },
  {
    type: 'table',
    name: 'virt',
    tbl_name: 'virt',
    sql: 'CREATE VIRTUAL TABLE virt USING fts5(body)',
  },
  { type: 'table', name: 'virt_shadow', tbl_name: 'virt_shadow', sql: null },
  {
    type: 'index',
    name: 'parent_n',
    tbl_name: 'parent',
    sql: 'CREATE INDEX parent_n ON parent(v)',
  },
  {
    type: 'index',
    name: 'rich_desc',
    tbl_name: 'parent',
    sql: 'CREATE INDEX rich_desc ON parent(v DESC)',
  },
  {
    type: 'index',
    name: 'rich_partial',
    tbl_name: 'parent',
    sql: 'CREATE INDEX rich_partial ON parent(v) WHERE v IS NOT NULL',
  },
  {
    type: 'index',
    name: 'rich_expr',
    tbl_name: 'parent',
    sql: 'CREATE INDEX rich_expr ON parent(lower(v))',
  },
  {
    type: 'index',
    name: 'rich_coll',
    tbl_name: 'parent',
    sql: 'CREATE INDEX rich_coll ON parent(v COLLATE NOCASE)',
  },
  {
    type: 'trigger',
    name: 'parent_trg',
    tbl_name: 'parent',
    sql: 'CREATE TRIGGER parent_trg AFTER INSERT ON parent BEGIN SELECT 1; END',
  },
]

const fixtureColumnRowsXinfo = {
  parent: [
    {
      cid: 0,
      name: 'id',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 1,
      hidden: 0,
    },
    {
      cid: 1,
      name: 'v',
      type: 'VARCHAR(12)',
      notnull: 0,
      dflt_value: "'safe'",
      pk: 0,
      hidden: 0,
    },
    {
      cid: 2,
      name: 'b',
      type: 'BLOB',
      notnull: 0,
      dflt_value: 'TRUE',
      pk: 0,
      hidden: 0,
    },
    {
      cid: 3,
      name: 'r',
      type: 'DOUBLE',
      notnull: 0,
      dflt_value: null,
      pk: 0,
      hidden: 0,
    },
    {
      cid: 4,
      name: 'd',
      type: 'DECIMAL(10,2)',
      notnull: 0,
      dflt_value: "(lower('x'))",
      pk: 0,
      hidden: 0,
    },
  ],
  simple: [
    {
      cid: 0,
      name: 'id',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 1,
      hidden: 0,
    },
  ],
  child: [
    {
      cid: 0,
      name: 'id',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 1,
      hidden: 0,
    },
    {
      cid: 1,
      name: 'pa',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 0,
      hidden: 0,
    },
    {
      cid: 2,
      name: 'pb',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 0,
      hidden: 0,
    },
  ],
  wr: [
    {
      cid: 0,
      name: 'id',
      type: 'TEXT',
      notnull: 1,
      dflt_value: null,
      pk: 1,
      hidden: 0,
    },
  ],
  wr_auto: [
    { cid: 0, name: 'a', type: 'TEXT', notnull: 1, dflt_value: null, pk: 1, hidden: 0 },
    { cid: 1, name: 'b', type: 'TEXT', notnull: 1, dflt_value: null, pk: 2, hidden: 0 },
  ],
  pk_desc: [
    {
      cid: 0,
      name: 'id',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 1,
      hidden: 0,
    },
  ],
  strict_t: [
    {
      cid: 0,
      name: 'id',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 0,
      hidden: 0,
    },
  ],
  generated_t: [
    {
      cid: 0,
      name: 'base',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 0,
      hidden: 0,
    },
    {
      cid: 1,
      name: 'derived',
      type: 'INTEGER',
      notnull: 0,
      dflt_value: null,
      pk: 0,
      hidden: 2,
    },
  ],
  virt: [
    { cid: 0, name: 'body', type: '', notnull: 0, dflt_value: null, pk: 0, hidden: 1 },
  ],
  virt_shadow: [
    { cid: 0, name: 'body', type: '', notnull: 0, dflt_value: null, pk: 0, hidden: 2 },
  ],
}

const request: CatalogRequest = {
  relations: [],
  absentRelations: [],
  completeNamespaces: [[{ role: 'database', spelling: 'main' }]],
}

type FixtureOptions = {
  reverse?: boolean
  version?: string
  malformed?: string
  race?: string
  quotedName?: string
  quotedIndexName?: string
  namedConstraint?: boolean
  checkConstraint?: boolean
  triggerNameCollision?: boolean
  viewTrigger?: boolean
  withoutOpaqueDependencies?: boolean
  crossTableTrigger?: boolean
  richerClause?: 'collate' | 'conflict' | 'deferrable' | 'initially'
  scannerDecoys?: boolean
  simpleForeignKey?: boolean
  opaqueDefault?: boolean
  richUniqueIndex?: boolean
  matchClause?: boolean
}

/**
 * Builds native sqlite_schema rows with the requested table, index, and dependency
 * variations.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Native sqlite_schema rows with the requested table, index, and dependency
 *   variations.
 */
function fixtureSchemaRows(options: FixtureOptions) {
  let schema = createSqliteConstraintRows(options)

  if (options.triggerNameCollision)
    schema.push({
      type: 'trigger',
      name: 'parent',
      tbl_name: 'parent',
      sql: 'CREATE TRIGGER parent AFTER INSERT ON parent BEGIN SELECT 1; END',
    })

  if (options.viewTrigger)
    schema.push({
      type: 'trigger',
      name: 'view_trigger',
      tbl_name: 'v',
      sql: 'CREATE TRIGGER view_trigger INSTEAD OF INSERT ON v BEGIN SELECT 1; END',
    })

  if (options.withoutOpaqueDependencies)
    schema = schema.filter((entry) => entry.type !== 'view' && entry.type !== 'trigger')

  if (options.crossTableTrigger)
    schema.push({
      type: 'trigger',
      name: 'cross_table_trigger',
      tbl_name: 'parent',
      sql: 'CREATE TRIGGER cross_table_trigger AFTER UPDATE ON parent BEGIN UPDATE child SET pa = new.id; END',
    })

  applySqliteSchemaClauses(options, schema)

  return schema
}

/**
 * Builds SQLite constraint definitions and applies requested reference and default
 * variations.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns SQLite constraint definitions and applies requested reference and default
 *   variations.
 */
function createSqliteConstraintRows(options: FixtureOptions) {
  const schema = structuredClone(fixtureSchemaRowsSchema)

  if (options.namedConstraint)
    schema[0]!.sql =
      "CREATE TABLE parent(id INTEGER, v VARCHAR(12) DEFAULT 'safe', b BLOB DEFAULT TRUE, r DOUBLE, d DECIMAL(10,2) DEFAULT (lower('x')), CONSTRAINT named_pk PRIMARY KEY(id), CONSTRAINT named_u UNIQUE(v), UNIQUE(b))"

  if (options.namedConstraint)
    schema[1]!.sql =
      'CREATE TABLE child(id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER, CONSTRAINT named_fk FOREIGN KEY(pa,pb) REFERENCES parent(id,v) ON UPDATE CASCADE ON DELETE SET NULL)'

  if (options.simpleForeignKey)
    schema[1]!.sql =
      'CREATE TABLE child(id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER, FOREIGN KEY(pa) REFERENCES parent(id) ON UPDATE CASCADE ON DELETE SET NULL)'

  if (options.matchClause) schema[1]!.sql = `${schema[1]!.sql!.slice(0, -1)} MATCH FULL)`

  if (options.richUniqueIndex)
    schema.find((entry) => entry.name === 'simple')!.sql =
      'CREATE TABLE simple(id INTEGER PRIMARY KEY, value TEXT, UNIQUE(value DESC))'

  if (options.opaqueDefault)
    schema.find((entry) => entry.name === 'simple')!.sql =
      'CREATE TABLE simple(id INTEGER PRIMARY KEY, value TEXT DEFAULT (random()))'

  if (options.checkConstraint)
    schema[0]!.sql = `${schema[0]!.sql!.slice(0, -1)}, CHECK (b IS NULL OR b = 1))`

  return schema
}

/**
 * Applies quoted names and richer native clauses used to check unsupported catalog
 * semantics.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param schema - Valibot schema used to read validation, storage, and metadata facts.
 */
function applySqliteSchemaClauses(
  options: FixtureOptions,
  schema: (
    | { type: string; name: string; tbl_name: string; sql: string }
    | { type: string; name: string; tbl_name: string; sql: null }
  )[],
) {
  if (options.richerClause === 'collate')
    schema.find((entry) => entry.name === 'simple')!.sql =
      'CREATE TABLE simple(id INTEGER COLLATE NOCASE PRIMARY KEY)'

  if (options.richerClause === 'conflict')
    schema.find((entry) => entry.name === 'simple')!.sql =
      'CREATE TABLE simple(id INTEGER PRIMARY KEY ON CONFLICT REPLACE)'

  if (options.richerClause === 'deferrable')
    schema[1]!.sql = `${schema[1]!.sql!.slice(0, -1)} DEFERRABLE)`

  if (options.richerClause === 'initially')
    schema[1]!.sql = `${schema[1]!.sql!.slice(0, -1)} DEFERRABLE INITIALLY DEFERRED)`

  if (options.scannerDecoys) {
    schema.find((entry) => entry.name === 'simple')!.sql =
      "CREATE TABLE simple(id INTEGER PRIMARY KEY DEFAULT 'COLLATE ON CONFLICT DEFERRABLE INITIALLY') /* COLLATE ON CONFLICT DEFERRABLE INITIALLY */"
  }

  if (options.quotedName !== undefined)
    schema.push({
      type: 'table',
      name: options.quotedName,
      tbl_name: options.quotedName,
      sql: `CREATE TABLE "${options.quotedName.replaceAll('"', '""')}" ("value" TEXT)`,
    })

  if (options.quotedName !== undefined && options.quotedIndexName !== undefined)
    schema.push({
      type: 'index',
      name: options.quotedIndexName,
      tbl_name: options.quotedName,
      sql: `CREATE INDEX "${options.quotedIndexName.replaceAll('"', '""')}" ON "${options.quotedName.replaceAll('"', '""')}" ("value")`,
    })
}

/**
 * Builds native column observations with the selected schema variations.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Native column observations with the selected schema variations.
 */
function fixtureColumnRows(options: FixtureOptions): Record<string, unknown[]> {
  const xinfo: Record<string, unknown[]> = structuredClone(fixtureColumnRowsXinfo)

  if (options.quotedName !== undefined)
    xinfo[options.quotedName] = [
      {
        cid: 0,
        name: 'value',
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
        pk: 0,
        hidden: 0,
      },
    ]

  if (options.opaqueDefault || options.richUniqueIndex)
    xinfo.simple!.push({
      cid: 1,
      name: 'value',
      type: 'TEXT',
      notnull: 0,
      dflt_value: options.opaqueDefault ? '(random())' : null,
      pk: 0,
      hidden: 0,
    })

  if (options.scannerDecoys) {
    const simpleColumn = xinfo.simple![0] as Record<string, unknown>
    simpleColumn.dflt_value = "'COLLATE ON CONFLICT DEFERRABLE INITIALLY'"
  }

  return xinfo
}

/**
 * Builds SQLite table-list observations with the requested native options.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns SQLite table-list observations with the requested native options.
 */
function fixtureTableRows(options: FixtureOptions) {
  let tables = [
    { schema: 'main', name: 'parent', type: 'table', ncol: 5, wr: 0, strict: 0 },
    { schema: 'main', name: 'child', type: 'table', ncol: 3, wr: 0, strict: 0 },
    { schema: 'main', name: 'wr', type: 'table', ncol: 1, wr: 1, strict: 0 },
    { schema: 'main', name: 'wr_auto', type: 'table', ncol: 2, wr: 1, strict: 0 },
    { schema: 'main', name: 'pk_desc', type: 'table', ncol: 1, wr: 0, strict: 0 },
    { schema: 'main', name: 'strict_t', type: 'table', ncol: 1, wr: 0, strict: 1 },
    { schema: 'main', name: 'generated_t', type: 'table', ncol: 2, wr: 0, strict: 0 },
    { schema: 'main', name: 'v', type: 'view', ncol: 1, wr: 0, strict: 0 },
    { schema: 'main', name: 'virt', type: 'virtual', ncol: 1, wr: 0, strict: 0 },
    { schema: 'main', name: 'virt_shadow', type: 'shadow', ncol: 1, wr: 0, strict: 0 },
    {
      schema: 'main',
      name: 'simple',
      type: 'table',
      ncol: options.opaqueDefault || options.richUniqueIndex ? 2 : 1,
      wr: 0,
      strict: 0,
    },
  ]

  if (options.withoutOpaqueDependencies)
    tables = tables.filter((table) => table.type !== 'view')

  if (options.quotedName !== undefined)
    tables.push({
      schema: 'main',
      name: options.quotedName,
      type: 'table',
      ncol: 1,
      wr: 0,
      strict: 0,
    })

  return tables
}

/**
 * Builds native index-list rows for the requested table and test variation.
 *
 * @param p - Parameters supplied to the native fixture SQL call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Native index-list rows for the requested table and test variation.
 */
function fixtureIndexList(p: readonly unknown[], options: FixtureOptions): unknown[] {
  return p[0] === options.quotedName && options.quotedIndexName !== undefined
    ? [
        {
          seq: 0,
          name: options.quotedIndexName,
          unique: 0,
          origin: 'c',
          partial: 0,
        },
      ]
    : p[0] === 'parent'
      ? structuredClone(fixtureIndexListData)
      : p[0] === 'pk_desc'
        ? [
            {
              seq: 0,
              name: 'pk_desc_auto',
              unique: 1,
              origin: 'pk',
              partial: 0,
            },
          ]
        : p[0] === 'wr' || p[0] === 'wr_auto'
          ? [
              {
                seq: 0,
                name: `${p[0]}_auto`,
                unique: 1,
                origin: 'pk',
                partial: 0,
              },
            ]
          : []
}

/**
 * Builds native index-member rows for the requested index and test variation.
 *
 * @param p - Parameters supplied to the native fixture SQL call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Native index-member rows for the requested index and test variation.
 */
function fixtureIndexInfo(p: readonly unknown[], options: FixtureOptions): unknown[] {
  const name = p[0]

  if (name === options.quotedIndexName) return structuredClone(quotedIndexInfoRows)

  return structuredClone(
    typeof name === 'string'
      ? ((Object.hasOwn(indexInfoRows, name) ? indexInfoRows[name] : undefined) ??
          defaultIndexInfoRows)
      : defaultIndexInfoRows,
  )
}

/**
 * Injects malformed column and foreign-key fields into otherwise valid native
 * observations.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Native rows after injecting the requested malformed member fields.
 */
function malformedMemberRows(
  rows: unknown[],
  query: Parameters<CatalogExecutor['execute']>[0],
  options: FixtureOptions,
): unknown[] {
  if (options.malformed === 'xinfo-missing-name' && query.sql.includes('table_xinfo'))
    rows = rows.map((row) => {
      const { name: _name, ...rest } = row as Record<string, unknown>

      return rest
    })

  if (options.malformed === 'fk-wrong-target' && query.sql.includes('foreign_key_list'))
    rows = rows.map((row) => ({ ...(row as Record<string, unknown>), to: 42 }))

  if (options.malformed === 'xinfo-gap' && query.sql.includes('table_xinfo'))
    rows = rows.map((row) => ({ ...(row as Record<string, unknown>), cid: 1 }))

  if (options.malformed === 'ncol' && query.sql.includes('table_list'))
    rows = rows.map((row) => ({ ...(row as Record<string, unknown>), ncol: 99 }))

  if (query.sql.includes('table_xinfo') && query.params[0] === 'parent')
    rows = rows.map((row) => {
      const column = row as Record<string, unknown>

      if (column.name !== 'v') return row

      if (options.malformed === 'native-column-type') return { ...column, type: 'TEXT' }

      if (options.malformed === 'native-column-not-null')
        return { ...column, column_notnull: 1 }

      if (options.malformed === 'native-column-default')
        return { ...column, dflt_value: "'changed'" }

      return row
    })

  if (
    options.malformed === 'native-column-generated' &&
    query.sql.includes('table_xinfo') &&
    query.params[0] === 'generated_t'
  )
    rows = rows.map((row) =>
      (row as Record<string, unknown>).name === 'derived'
        ? { ...(row as Record<string, unknown>), hidden: 3 }
        : row,
    )

  if (options.malformed === 'fk-duplicate' && query.sql.includes('foreign_key_list'))
    rows = [
      ...rows,
      ...(rows as Record<string, unknown>[]).map((row) => ({ ...row, seq: 0 })),
    ]

  if (options.malformed === 'fk-source' && query.sql.includes('foreign_key_list'))
    rows = rows.map((row) => ({
      ...(row as Record<string, unknown>),
      from: 'missing_source',
    }))

  return rows
}

/**
 * Injects malformed database, relation, or member evidence for fail-closed catalog tests.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Native rows after injecting the requested invalid catalog evidence.
 */
function malformedFixtureRows(
  rows: unknown[],
  query: Parameters<CatalogExecutor['execute']>[0],
  options: FixtureOptions,
): unknown[] {
  if (options.malformed === 'duplicate' && query.sql.includes('database_list'))
    rows = [...rows, ...rows]

  rows = malformedSchemaRows(options, query, rows)

  if (options.malformed === 'table-case-duplicate' && query.sql.includes('table_list'))
    rows = [
      ...rows,
      { schema: 'MAIN', name: 'PARENT', type: 'table', ncol: 5, wr: 0, strict: 0 },
    ]

  if (options.malformed === 'table-unlisted-database' && query.sql.includes('table_list'))
    rows = [
      ...rows,
      { schema: 'ghost', name: 'outside', type: 'table', ncol: 1, wr: 0, strict: 0 },
    ]

  if (query.sql.includes('table_list'))
    rows = rows.map((row) => {
      const table = row as Record<string, unknown>

      if (table.name === 'parent' && options.malformed === 'table-name-nul')
        return { ...table, name: 'parent\0bad' }

      if (table.name === 'parent' && options.malformed === 'table-name-surrogate')
        return { ...table, name: 'parent\ud800bad' }

      if (options.malformed === 'native-table-strict' && table.name === 'strict_t')
        return { ...table, strict: 0 }

      if (options.malformed === 'native-table-without-rowid' && table.name === 'wr')
        return { ...table, wr: 0 }

      if (options.malformed === 'native-table-virtual' && table.name === 'virt')
        return { ...table, type: 'table' }

      return row
    })

  if (options.malformed === 'database-wrong-type' && query.sql.includes('database_list'))
    rows = rows.map((row) => ({ ...(row as Record<string, unknown>), name: 42 }))

  return malformedMemberRows(rows, query, options)
}

it.each(['table-name-nul', 'table-name-surrogate'])(
  'should keep malformed SQLite returned identifiers as unknown evidence: %s',
  async (malformed) => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ malformed }),
      request,
    )

    expectUnknownMetadata(snapshot, 'Malformed SQLite table_list row')
    expect(snapshot.namespaces.coverage.state).toBe('unknown')
  },
)

/**
 * Injects conflicting relation names, kinds, and definitions into native schema
 * observations.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param rows - Ordered native observations or result rows to process.
 *
 * @returns Native rows after injecting schema inventory conflicts.
 */
function malformedSchemaRows(
  options: FixtureOptions,
  query: { sql: string; params: unknown[] },
  rows: unknown[],
) {
  if (
    options.malformed === 'schema-case-duplicate' &&
    query.sql.includes('sqlite_schema')
  )
    rows = [
      ...rows,
      {
        type: 'table',
        name: 'PARENT',
        tbl_name: 'PARENT',
        sql: 'CREATE TABLE PARENT(id INTEGER)',
      },
    ]

  if (options.malformed === 'schema-unknown-type' && query.sql.includes('sqlite_schema'))
    rows = rows.map((row, index) =>
      index === 0 ? { ...(row as Record<string, unknown>), type: 'mystery' } : row,
    )

  if (
    options.malformed === 'schema-relation-name-mismatch' &&
    query.sql.includes('sqlite_schema')
  )
    rows = rows.map((row) =>
      (row as Record<string, unknown>).name === 'parent'
        ? { ...(row as Record<string, unknown>), tbl_name: 'other' }
        : row,
    )

  if (
    options.malformed === 'schema-view-type-mismatch' &&
    query.sql.includes('sqlite_schema')
  )
    rows = rows.map((row) =>
      (row as Record<string, unknown>).name === 'v'
        ? { ...(row as Record<string, unknown>), type: 'table' }
        : row,
    )

  return rows
}

/**
 * Injects invalid native index-member and inventory evidence.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Native rows after injecting invalid index-member evidence.
 */
function malformedIndexDetails(
  rows: unknown[],
  query: Parameters<CatalogExecutor['execute']>[0],
  options: FixtureOptions,
): unknown[] {
  const p = query.params

  if (
    options.malformed === 'index-xinfo-wrong-flag' &&
    query.sql.includes('index_xinfo') &&
    p[0] === 'parent_n'
  )
    rows = rows.map((row) => ({ ...(row as Record<string, unknown>), desc: 2 }))

  if (
    options.malformed === 'native-index-semantics' &&
    query.sql.includes('index_xinfo') &&
    p[0] === 'rich_desc'
  )
    rows = rows.map((row) => ({ ...(row as Record<string, unknown>), desc: 0 }))

  if (
    options.malformed === 'index-xinfo-expression' &&
    query.sql.includes('index_xinfo') &&
    p[0] === 'parent_n'
  )
    rows = rows.map((row) => ({
      ...(row as Record<string, unknown>),
      cid: -2,
      name: 'not-null-for-expression',
    }))

  if (
    options.malformed === 'index-xinfo-auxiliary' &&
    query.sql.includes('index_xinfo') &&
    p[0] === 'parent_n'
  )
    rows = [...rows, { seqno: 1, cid: -2, name: null, desc: 0, coll: null, key: 0 }]

  rows = malformedIndexInventory(options, query, p, rows)

  return rows
}

/**
 * Injects schema and index-list disagreements into native index inventory.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param p - Parameters supplied to the native fixture SQL call.
 * @param rows - Ordered native observations or result rows to process.
 *
 * @returns Native rows after injecting index inventory disagreements.
 */
function malformedIndexInventory(
  options: FixtureOptions,
  query: { sql: string; params: unknown[] },
  p: unknown[],
  rows: unknown[],
) {
  if (
    options.malformed === 'missing-index-schema' &&
    query.sql.includes('index_list') &&
    p[0] === 'parent'
  )
    rows = [
      ...rows,
      { seq: 7, name: 'missing_schema_idx', unique: 0, origin: 'c', partial: 0 },
    ]

  if (
    options.malformed === 'schema-index-missing-list' &&
    query.sql.includes('sqlite_schema')
  )
    rows = [
      ...rows,
      {
        type: 'index',
        name: 'missing_list_idx',
        tbl_name: 'parent',
        sql: 'CREATE INDEX missing_list_idx ON parent(v)',
      },
    ]

  return rows
}

/**
 * Injects invalid index flags, origins, or member fields into native observations.
 *
 * @param rows - Ordered native observations or result rows to process.
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns Native rows after injecting invalid index metadata.
 */
function malformedIndexRows(
  rows: unknown[],
  query: Parameters<CatalogExecutor['execute']>[0],
  options: FixtureOptions,
): unknown[] {
  if (options.malformed === 'index-invalid-origin' && query.sql.includes('index_list'))
    rows = rows.map((row) =>
      (row as Record<string, unknown>).name === 'parent_n'
        ? { ...(row as Record<string, unknown>), origin: 'unknown' }
        : row,
    )

  if (options.malformed === 'index-invalid-flags' && query.sql.includes('index_list'))
    rows = rows.map((row) =>
      (row as Record<string, unknown>).name === 'u_auto'
        ? { ...(row as Record<string, unknown>), unique: 0 }
        : row,
    )

  if (options.malformed === 'index-wrong-shape' && query.sql.includes('index_list'))
    rows = rows.map((row) =>
      (row as Record<string, unknown>).name === 'parent_n'
        ? { ...(row as Record<string, unknown>), unique: 'true' }
        : row,
    )

  if (options.malformed === 'native-index-partial' && query.sql.includes('index_list'))
    rows = rows.map((row) =>
      (row as Record<string, unknown>).name === 'rich_partial'
        ? { ...(row as Record<string, unknown>), partial: 0 }
        : row,
    )

  return malformedIndexDetails(rows, query, options)
}

/**
 * Creates a catalog executor with controlled native rows, ordering, malformed evidence,
 * and race behavior.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A catalog executor with controlled native rows, ordering, malformed evidence,
 *   and race behavior.
 */
function fixtureExecutor(options: FixtureOptions = {}): CatalogExecutor {
  const tables = fixtureTableRows(options)

  const schema = fixtureSchemaRows(options)

  const xinfo = fixtureColumnRows(options)

  const calls = new Map<string, number>()
  return {
    // oxlint-disable-next-line complexity
    /** Executes fixture SQL with the configured native observations. */
    execute: (query) =>
      executeSqliteFixture(query, options, tables, schema, xinfo, calls),
  }
}

/**
 * Finds the named relation in the observed SQLite catalog or fails the fixture check.
 *
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 * @param name - Physical identifier or dialect label used by this operation.
 *
 * @returns The named relation in the observed SQLite catalog or fails the fixture check.
 */
function relationNamed(snapshot: CatalogSnapshot, name: string): CatalogRelation {
  const relation = snapshot.namespaces.items[0]?.relations.items.find(
    (entry) => entry.identity.relation.spelling === name,
  )

  expect(relation).toBeDefined()

  if (relation === undefined) throw new Error(`Missing SQLite relation ${name}`)

  return relation
}

/**
 * Requires present table evidence before an integration assertion reads its members.
 *
 * @param relation - Authored or canonical relation addressed by this operation.
 *
 * @returns Present table evidence; absent or unsupported table evidence fails the
 *   assertion.
 */
function tableOf(relation: CatalogRelation): CatalogTable {
  expect(relation.table.state).toBe('present')

  if (relation.table.state !== 'present')
    throw new Error(
      `Missing SQLite table evidence for ${relation.identity.relation.spelling}`,
    )

  return relation.table.value
}

/**
 * Creates an empty SQLite catalog executor with the selected native version.
 *
 * @param version - Native server-version spelling used to choose catalog capabilities.
 *
 * @returns An empty SQLite catalog executor with the selected native version.
 */
const emptyFixture = (version = '3.37.0'): CatalogExecutor => ({
  /** Executes fixture SQL with the configured native observations. */
  execute: async (query) =>
    query.sql.includes('sqlite_version')
      ? [{ version }]
      : query.sql.includes('database_list')
        ? [{ seq: 0, name: 'main', file: '' }]
        : query.sql.includes('table_list')
          ? []
          : query.sql.includes('sqlite_schema')
            ? []
            : [],
})

describe('SQLite catalog', () => {
  it('should decode all affinity families and native spelling in the fixture', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const parent = relationNamed(s, 'parent')
    expect(parent.nativeDefinition.state).toBe('present')

    expect(
      tableOf(parent).columns.items.map((column) =>
        column.dataType.state === 'present' ? column.dataType.value.family : '',
      ),
    ).toEqual(['integer', 'text', 'blob', 'real', 'numeric'])

    expect(tableOf(parent).columns.items[1]!.dataType).toMatchObject({
      state: 'present',
      value: { native: 'VARCHAR(12)', comparisonKey: 'text' },
    })
  })
})

describe('SQLite catalog', () => {
  it('should preserve defaults and rowid generation in the fixture', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const columns = tableOf(relationNamed(s, 'parent')).columns.items
    assertSqliteColumnEvidence(columns)

    assertParentKeysAndIndexes(s)

    expect(relationNamed(s, 'parent').management).toBe('unmanaged')

    expect(tableOf(relationNamed(s, 'wr_auto')).primaryKey).toMatchObject({
      state: 'present',
      value: { columns: ['a', 'b'], semantics: { state: 'present' } },
    })

    expect(tableOf(relationNamed(s, 'wr_auto')).options.items).toEqual([
      { name: 'strict', value: 'false' },
      { name: 'withoutRowid', value: 'true' },
    ])

    expect(tableOf(relationNamed(s, 'strict_t')).options.items).toEqual([
      { name: 'strict', value: 'true' },
      { name: 'withoutRowid', value: 'false' },
    ])
  })
})

describe('SQLite catalog', () => {
  it('should retain composite FK ordering and actions in the fixture', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const child = relationNamed(s, 'child')
    expect(tableOf(child).foreignKeys.items[0]).toMatchObject({
      columns: ['pa', 'pb'],
      referencedColumns: ['id', 'v'],
      onDelete: 'set null',
      onUpdate: 'cascade',
      validity: { state: 'present', value: 'invalid' },
    })
  })

  it('should produce deeply equal fixture reversals', async () => {
    expect(
      await sqliteCatalog.introspectCatalog(fixtureExecutor({ reverse: true }), request),
    ).toEqual(await sqliteCatalog.introspectCatalog(fixtureExecutor(), request))
  })
})

describe('SQLite catalog', () => {
  it('should block main management when attached or temporary objects are present', async () => {
    const executeExternal = createExternalSqliteExecutor

    const snapshot = await sqliteCatalog.introspectCatalog(
      executeExternal(false),
      request,
    )

    const reversed = await sqliteCatalog.introspectCatalog(executeExternal(true), request)
    const parent = relationNamed(snapshot, 'parent')

    assertExternalNamespaceDiagnostics(reversed, snapshot, parent)
  })
})

describe('SQLite catalog', () => {
  it('should preserve CHECK, generated-column, and rich-index evidence', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const generated = relationNamed(snapshot, 'generated_t')
    const generatedTable = tableOf(generated)

    expect(generated.management).toBe('unmanaged')
    expect(generatedTable.columns.items[1]!.generation.state).toBe('unsupported')

    expect(generatedTable.columns.items[1]!.nativeDefinition).toMatchObject({
      state: 'present',
      value: expect.stringContaining('GENERATED ALWAYS') as unknown,
    })

    const parent = relationNamed(snapshot, 'parent')
    const indexes = new Map(
      tableOf(parent).indexes.items.map((index) => [
        index.name.state === 'present' ? index.name.value : '',
        index,
      ]),
    )

    for (const name of ['rich_desc', 'rich_partial', 'rich_expr', 'rich_coll']) {
      expect(indexes.get(name)?.semantics.state).toBe('unsupported')
      expect(indexes.get(name)?.nativeDefinition.state).toBe('present')
    }

    const checked = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ checkConstraint: true }),
      request,
    )

    const checkedParent = relationNamed(checked, 'parent')

    expect(checkedParent.management).toBe('unmanaged')

    expect(
      tableOf(checkedParent).opaqueObjects.items.some((object) =>
        object.reason.includes('CHECK constraint'),
      ),
    ).toBe(true)
  })
})

describe('SQLite catalog', () => {
  it('should not claim unknown constraint names or rowid planning support', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ namedConstraint: true, withoutOpaqueDependencies: true }),
      request,
    )

    const parent = relationNamed(snapshot, 'parent')
    const parentTable = tableOf(parent)

    expect(parent.management).toBe('unmanaged')

    expect(parentTable.primaryKey).toMatchObject({
      state: 'present',
      value: { name: { state: 'unknown' } },
    })

    expect(parentTable.uniqueConstraints.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: expect.objectContaining({ state: 'unknown' }) as unknown,
        }),
      ]),
    )

    expect(
      tableOf(relationNamed(snapshot, 'child')).foreignKeys.items[0]!.name,
    ).toMatchObject({
      state: 'unknown',
    })

    expect(snapshot.constraintNameReservations).toMatchObject({
      items: [],
      coverage: { state: 'unknown' },
    })

    expect(parentTable.columns.items[0]!.generation).toMatchObject({
      state: 'present',
      value: { kind: 'rowidAlias', autoIncrement: false },
    })

    expect(relationNamed(snapshot, 'simple').management).toBe('managed')
  })
})

describe('SQLite catalog', () => {
  it('should preserve trigger opaque evidence in the fixture', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const parent = relationNamed(s, 'parent')
    expect(
      tableOf(parent).opaqueObjects.items.some((object) => object.kind === 'trigger'),
    ).toBe(true)
  })

  it('should allow trigger names to share relation names without reserving trigger-only names', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ triggerNameCollision: true }),
      request,
    )

    expect(relationNamed(snapshot, 'parent')).toBeDefined()

    expect(
      snapshot.nameReservations.items.filter(({ name }) => name === 'parent'),
    ).toHaveLength(1)

    expect(snapshot.nameReservations.items).not.toContainEqual(
      expect.objectContaining({ name: 'parent_trg' }),
    )
  })
})

describe('SQLite catalog', () => {
  it('should keep rowid aliases and unnamed simple constraints in the managed profile', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ withoutOpaqueDependencies: true, simpleForeignKey: true }),
      request,
    )

    const simple = relationNamed(snapshot, 'simple')
    expect(simple.management).toBe('managed')

    expect(tableOf(simple).primaryKey).toMatchObject({
      state: 'present',
      value: { name: { state: 'absent' }, columns: ['id'] },
    })

    expect(tableOf(simple).columns.items[0]!.generation).toMatchObject({
      state: 'present',
      value: { kind: 'rowidAlias', autoIncrement: false },
    })

    expect(relationNamed(snapshot, 'child').management).toBe('managed')
  })
})

describe('SQLite catalog', () => {
  it('should keep uncomparable native defaults opaque and unmanaged', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ withoutOpaqueDependencies: true, opaqueDefault: true }),
      request,
    )

    const relation = relationNamed(snapshot, 'simple')
    const table = tableOf(relation)

    expect(relation.management).toBe('unmanaged')

    expect(table.columns.items[1]!.default).toMatchObject({
      state: 'present',
      value: {
        kind: 'nativeExpression',
        native: '(random())',
        comparisonKey: { state: 'unsupported' },
      },
    })

    expect(table.opaqueObjects.items).toContainEqual(
      expect.objectContaining({
        kind: 'other',
        name: { state: 'present', value: 'value' },
        nativeDefinition: { state: 'present', value: '(random())' },
      }),
    )
  })
})

describe('SQLite catalog', () => {
  it('should keep rich auto-index UNIQUE constraints unmanaged', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ withoutOpaqueDependencies: true, richUniqueIndex: true }),
      request,
    )

    const relation = relationNamed(snapshot, 'simple')
    const table = tableOf(relation)

    expect(relation.management).toBe('unmanaged')

    expect(table.uniqueConstraints.items).toMatchObject([
      {
        columns: ['value'],
        semantics: { state: 'unsupported' },
      },
    ])
  })
})

describe('SQLite catalog', () => {
  it('should treat authored MATCH clauses as opaque despite PRAGMA match NONE', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({
        withoutOpaqueDependencies: true,
        simpleForeignKey: true,
        matchClause: true,
      }),
      request,
    )

    const child = relationNamed(snapshot, 'child')

    expect(child.management).toBe('unmanaged')

    expect(tableOf(child).opaqueObjects.items).toContainEqual(
      expect.objectContaining({
        kind: 'other',
        nativeDefinition: {
          state: 'present',
          value: expect.stringContaining('MATCH FULL') as unknown,
        },
        reason: expect.stringContaining('MATCH') as unknown,
      }),
    )

    expect(tableOf(child).foreignKeys.items[0]!.semantics).toMatchObject({
      state: 'present',
    })
  })
})

describe('SQLite catalog', () => {
  it('should report SQLite owner facts as unsupported by the engine', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)

    expect(snapshot.namespaces.items[0]!.owner).toEqual({
      state: 'unsupported',
      by: 'engine',
      reason: 'SQLite has no namespace owner',
    })

    expect(relationNamed(snapshot, 'parent').owner).toEqual({
      state: 'unsupported',
      by: 'engine',
      reason: 'SQLite has no relation owner',
    })
  })

  it('should keep trigger dependencies opaque across candidate tables', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ withoutOpaqueDependencies: true, crossTableTrigger: true }),
      request,
    )

    const child = relationNamed(snapshot, 'child')

    expect(child.management).toBe('unmanaged')

    expect(tableOf(child).opaqueObjects.items).toContainEqual(
      expect.objectContaining({
        kind: 'trigger',
        name: { state: 'present', value: 'cross_table_trigger' },
        nativeDefinition: {
          state: 'present',
          value:
            'CREATE TRIGGER cross_table_trigger AFTER UPDATE ON parent BEGIN UPDATE child SET pa = new.id; END',
        },
      }),
    )

    expect(snapshot.diagnostics.map(({ code }) => code)).toContain(
      'catalog.sqlite.trigger-dependency',
    )
  })
})

describe('SQLite catalog', () => {
  it('should mark unrepresented table clauses opaque without false positives in literals or comments', async () => {
    for (const richerClause of [
      'collate',
      'conflict',
      'deferrable',
      'initially',
    ] as const) {
      const snapshot = await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ withoutOpaqueDependencies: true, richerClause }),
        request,
      )

      const relation = relationNamed(
        snapshot,
        richerClause === 'deferrable' || richerClause === 'initially'
          ? 'child'
          : 'simple',
      )

      const table = tableOf(relation)

      expect(relation.management).toBe('unmanaged')

      expect(table.opaqueObjects.items).toContainEqual(
        expect.objectContaining({
          kind: 'other',
          nativeDefinition: {
            state: 'present',
            value: expect.stringContaining('CREATE TABLE') as unknown,
          },
          reason: expect.stringContaining(
            'SQLite table clauses are not fully represented',
          ) as unknown,
        }),
      )
    }

    const decoy = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ withoutOpaqueDependencies: true, scannerDecoys: true }),
      request,
    )

    expect(relationNamed(decoy, 'simple').management).toBe('managed')

    expect(
      tableOf(relationNamed(decoy, 'simple')).opaqueObjects.items.some((object) =>
        object.reason.includes('table clauses are not fully represented'),
      ),
    ).toBe(false)
  })
})

describe('SQLite catalog', () => {
  it('should preserve the INTEGER PRIMARY KEY DESC exception', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ withoutOpaqueDependencies: true }),
      request,
    )

    const relation = relationNamed(snapshot, 'pk_desc')
    const table = tableOf(relation)

    expect(table.columns.items[0]!.generation).toEqual({ state: 'absent' })

    expect(table.primaryKey).toMatchObject({
      state: 'present',
      value: {
        columns: ['id'],
        semantics: { state: 'unsupported' },
      },
    })

    expect(relation.management).toBe('unmanaged')
  })
})

describe('SQLite catalog', () => {
  it('should block tables when view dependencies are unknown and preserve view triggers', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ viewTrigger: true }),
      request,
    )

    const parent = relationNamed(snapshot, 'parent')
    expect(parent.management).toBe('unmanaged')

    expect(tableOf(parent).opaqueObjects.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'other',
          name: { state: 'present', value: 'v' },
        }),
        expect.objectContaining({
          kind: 'trigger',
          name: { state: 'present', value: 'view_trigger' },
        }),
      ]),
    )

    expect(snapshot.diagnostics.map(({ code }) => code)).toContain(
      'catalog.sqlite.view-dependency',
    )
  })
})

describe('SQLite catalog', () => {
  it('should reserve unrelated indexes and auto-indexes outside relation scope', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), {
      ...request,
      completeNamespaces: [],
      relations: [{ relation: { relation: 'child' }, shape: 'complete' }],
    })

    expect(s.nameReservations.coverage.state).toBe('complete')
    expect(s.nameReservations.items.map((n) => n.name)).toContain('parent_n')
    expect(s.nameReservations.items.map((n) => n.name)).toContain('u_auto')
  })

  it('should mark duplicate database rows as unknown inventory', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ malformed: 'duplicate' }),
      request,
    )

    expectUnknownMetadata(snapshot, 'database_list sequence values must be unique')
    expect(snapshot.namespaces.coverage.state).toBe('unknown')
  })
})

describe('SQLite catalog', () => {
  it('should observe requested absence without claiming complete namespace coverage', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), {
      relations: [],
      absentRelations: [{ relation: 'missing' }],
      completeNamespaces: [],
    })

    expect(s.request.absentRelations).toHaveLength(1)

    expect(
      s.namespaces.items[0]!.relations.items.some(
        (relation) => relation.identity.relation.comparisonKey === 'missing',
      ),
    ).toBe(false)

    expect(s.namespaces.items[0]!.relations.coverage.state).toBe('partial')
  })

  it('should not fabricate absence when the requested identity is present', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), {
      relations: [],
      absentRelations: [{ relation: 'child' }],
      completeNamespaces: [],
    })

    expect(s.request.absentRelations[0]!.relation.spelling).toBe('child')
    expect(relationNamed(s, 'child').table.state).toBe('present')
    expect(s.namespaces.items[0]!.relations.coverage.state).toBe('partial')
  })
})

describe('SQLite catalog', () => {
  it('should reject attached relation scopes in the fixture', async () => {
    await expect(
      sqliteCatalog.introspectCatalog(fixtureExecutor(), {
        ...request,
        relations: [
          {
            relation: {
              namespace: [{ role: 'database', spelling: 'aux' }],
              relation: 'x',
            },
            shape: 'complete',
          },
        ],
      }),
    ).rejects.toMatchObject({ _tag: 'InvariantError' })
  })
})

describe('SQLite catalog', () => {
  it('should gate exact minimum version in the fixture', async () => {
    const executed: string[] = []
    const fixture = fixtureExecutor({ version: '3.37.0' })
    const snapshot = await sqliteCatalog.introspectCatalog(
      {
        /** Executes fixture SQL with the configured native observations. */
        execute: async (query) => {
          executed.push(query.sql)
          return fixture.execute(query)
        },
      },
      request,
    )

    expect(snapshot.source.version).toBe('3.37.0')

    expect(snapshot.capabilities.identity).toEqual({
      state: 'supported',
      fidelity: 'native',
    })

    expect(snapshot.capabilities.namespaces).toEqual({
      state: 'supported',
      fidelity: 'native',
    })

    expect(executed.some((sql) => sql.includes('pragma_table_list'))).toBe(true)
  })
})

describe('SQLite catalog', () => {
  it('should gate versions before querying any PRAGMA', async () => {
    const calls: string[] = []
    const old = await sqliteCatalog.introspectCatalog(
      {
        /** Executes fixture SQL with the configured native observations. */
        execute: async (query) => {
          calls.push(query.sql)
          return [{ version: '3.36.0' }]
        },
      },
      request,
    )

    expect(calls).toHaveLength(1)

    expect(old.capabilities.identity).toEqual({
      state: 'unavailable',
      cause: 'version',
      actual: '3.36.0',
      requires: '3.37.0',
    })

    expect(old.namespaces.coverage).toMatchObject({
      state: 'unavailable',
      cause: 'version',
    })
  })
})

describe('SQLite catalog', () => {
  it('should resolve omitted namespace to main', async () => {
    expect(
      (
        await sqliteCatalog.introspectCatalog(emptyFixture(), {
          relations: [],
          absentRelations: [],
          completeNamespaces: [],
        })
      ).namespaceContext.writableDefault[0]!.spelling,
    ).toBe('main')
  })

  it('should emit complete empty main', async () => {
    expect(
      (await sqliteCatalog.introspectCatalog(emptyFixture(), request)).namespaces
        .items[0]!.relations.items,
    ).toEqual([])
  })

  it('should emit partial empty main', async () => {
    expect(
      (
        await sqliteCatalog.introspectCatalog(emptyFixture(), {
          relations: [],
          absentRelations: [],
          completeNamespaces: [],
        })
      ).namespaces.items[0]!.relations.coverage.state,
    ).toBe('partial')
  })

  it('should deduplicate request identities', async () => {
    const result = await sqliteCatalog.introspectCatalog(emptyFixture(), {
      relations: [
        { relation: { relation: 'x' }, shape: 'complete' },
        { relation: { relation: 'X' }, shape: 'complete' },
      ],
      absentRelations: [],
      completeNamespaces: [],
    })

    expect(result.request.relations).toHaveLength(1)
  })
})

describe('SQLite catalog', () => {
  it('should reject attached registration defaults', async () => {
    await expect(
      sqliteCatalog.introspectCatalog(emptyFixture(), {
        ...request,
        registrationDefault: [{ role: 'database', spelling: 'aux' }],
      }),
    ).rejects.toMatchObject({ _tag: 'InvariantError' })
  })
})

describe('SQLite catalog', () => {
  it('should parameterize and observe quoted table and index names', async () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const tableName = 'odd"table'
    const indexName = 'odd"index'
    const fixture = fixtureExecutor({ quotedName: tableName, quotedIndexName: indexName })
    const snapshot = await sqliteCatalog.introspectCatalog(
      {
        /** Executes fixture SQL with the configured native observations. */
        execute: async (query) => {
          calls.push(query)
          return fixture.execute(query)
        },
      },
      {
        relations: [{ relation: { relation: tableName }, shape: 'complete' }],
        absentRelations: [],
        completeNamespaces: [],
      },
    )

    const table = tableOf(relationNamed(snapshot, tableName))
    expect(table.indexes.items.map((index) => index.name)).toContainEqual({
      state: 'present',
      value: indexName,
    })

    expect(
      calls.some(
        (call) => call.params.includes(tableName) && call.sql.includes('pragma_'),
      ),
    ).toBe(true)

    expect(
      calls.some(
        (call) => call.params.includes(indexName) && call.sql.includes('pragma_'),
      ),
    ).toBe(true)

    expect(
      calls.every(
        (call) => !call.sql.includes(tableName) && !call.sql.includes(indexName),
      ),
    ).toBe(true)
  })
})

describe('SQLite catalog', () => {
  it('should report unsupported old versions deterministically', async () => {
    expect(
      (await sqliteCatalog.introspectCatalog(emptyFixture('3.36.9'), request))
        .diagnostics[0]!.code,
    ).toBe('catalog.capability.version')
  })

  it('should preserve resolved request shape', async () => {
    const result = await sqliteCatalog.introspectCatalog(emptyFixture(), {
      ...request,
      relations: [{ relation: { relation: 'x' }, shape: 'additive' }],
    })

    expect(result.request.relations[0]!.shape).toBe('additive')
  })
})

describe('SQLite catalog', () => {
  it('should return unknown evidence for malformed cross-PRAGMA observations', async () => {
    for (const [malformed, message] of [
      ['xinfo-gap', 'SQLite table "parent" table_xinfo cids must be contiguous'],
      ['ncol', 'SQLite table "parent" table_list ncol does not match table_xinfo'],
      ['fk-duplicate', 'SQLite foreign-key group on "child" has non-contiguous sequence'],
      ['fk-source', 'SQLite foreign key on "child" references a missing source column'],
    ]) {
      const snapshot = await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed }),
        request,
      )

      expect(snapshot.diagnostics.length).toBeGreaterThan(0)
      expectUnknownMetadata(snapshot, message)
    }
  })
})

describe('SQLite catalog', () => {
  it('should return unknown evidence and stable diagnostics', async () => {
    const cases = structuredClone(
      rejectsMalformedAndInconsistentIndexObservationsWithStableMessagesData,
    )

    for (const [malformed, message] of cases) {
      const snapshot = await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed }),
        request,
      )

      expect(snapshot.diagnostics.length).toBeGreaterThan(0)
      expectUnknownMetadata(snapshot, message)
    }
  })
})

describe('SQLite catalog', () => {
  it('should return unknown evidence for malformed schema rows', async () => {
    await assertMalformedSqliteIdentityRows()

    expectUnknownMetadata(
      await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'table-unlisted-database' }),
        request,
      ),
      'references an unlisted database alias "ghost"',
    )

    expectUnknownMetadata(
      await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'schema-unknown-type' }),
        request,
      ),
      'invalid type "mystery"',
    )

    expectUnknownMetadata(
      await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'schema-relation-name-mismatch' }),
        request,
      ),
      'has mismatched tbl_name "other"',
    )

    expectUnknownMetadata(
      await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'schema-view-type-mismatch' }),
        request,
      ),
      'disagrees with sqlite_schema type "table"',
    )
  })
})

describe('SQLite catalog', () => {
  it('should return unknown evidence for catalog races including reservation-only indexes', async () => {
    for (const race of ['table_list', 'table_xinfo', 'sqlite_schema', 'index_list']) {
      const snapshot = await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ race }),
        request,
      )

      expect(snapshot.diagnostics.length).toBeGreaterThan(0)
      expectUnknownMetadata(snapshot, 'catalog changed during introspection')
    }
  })
})

describe('SQLite catalog', () => {
  it('should keep a sound relation and column facts alongside a damaged index', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({
        malformed: 'index-xinfo-wrong-flag',
        withoutOpaqueDependencies: true,
      }),
      request,
    )

    const parent = relationNamed(snapshot, 'parent')
    const child = relationNamed(snapshot, 'child')
    const simple = relationNamed(snapshot, 'simple')
    expect(parent.management).toBe('unmanaged')
    expect(parent.nativeDefinition.state).toBe('present')
    expect(tableOf(parent).columns.coverage.state).toBe('complete')
    expect(tableOf(parent).primaryKey.state).toBe('unknown')
    expect(tableOf(parent).indexes.coverage.state).toBe('unknown')
    const id = tableOf(parent).columns.items.find((column) => column.name === 'id')!
    expect(id.nullable).toEqual({ state: 'present', value: false })

    expect(id.generation).toEqual({
      state: 'present',
      value: { kind: 'rowidAlias', autoIncrement: true },
    })

    expect(child.management).toBe('unmanaged')
    expect(tableOf(child).columns.coverage.state).toBe('complete')
    expect(tableOf(child).foreignKeys.coverage.state).toBe('unknown')
    const childDiagnostic = snapshot.diagnostics.find(
      (entry) =>
        entry.target?.relation.comparisonKey === child.identity.relation.comparisonKey,
    )

    expect(childDiagnostic?.message).toContain('references invalid parent metadata')
    expect(simple.management).toBe('managed')
    expect(tableOf(simple).columns.coverage.state).toBe('complete')
    expect(snapshot.namespaces.items[0]!.relations.coverage.state).toBe('partial')
    expect(snapshot.nameReservations.coverage.state).toBe('unknown')
  })
})

describe('SQLite catalog', () => {
  it('should keep unrelated relations when one schema definition disagrees', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({
        malformed: 'schema-relation-name-mismatch',
        withoutOpaqueDependencies: true,
      }),
      request,
    )

    expect(relationNamed(snapshot, 'parent').nativeDefinition.state).toBe('unknown')

    expect(tableOf(relationNamed(snapshot, 'parent')).columns.coverage.state).toBe(
      'unknown',
    )

    expect(relationNamed(snapshot, 'simple').management).toBe('managed')
    expect(snapshot.nameReservations.coverage.state).toBe('unknown')
  })
})

describe('SQLite catalog', () => {
  it('should return the same invalid evidence when native rows are reversed', async () => {
    for (const malformed of [
      'schema-case-duplicate',
      'index-xinfo-wrong-flag',
      'fk-duplicate',
    ]) {
      const forward = await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed }),
        request,
      )

      const reversed = await sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed, reverse: true }),
        request,
      )

      expect(reversed).toEqual(forward)
    }
  })
})

describe('SQLite catalog', () => {
  it.each(nativeDefinitionCrossCheckCases)(
    'should reject stable %s observations before planning',
    async (malformed, relationName, affected, message) => {
      const observe = (reverse: boolean) =>
        sqliteCatalog.introspectCatalog(
          fixtureExecutor({ malformed, reverse, withoutOpaqueDependencies: true }),
          request,
        )

      const snapshot = await observe(false)
      expect(await observe(true)).toEqual(snapshot)

      const relation = relationNamed(snapshot, relationName)
      const table = tableOf(relation)

      expect(relation.management).toBe('unmanaged')
      expect(table[affected].coverage.state).toBe('unknown')

      const preservedCoverage =
        affected === 'columns'
          ? table.options.coverage.state
          : affected === 'options' && malformed !== 'native-table-virtual'
            ? table.columns.coverage.state
            : 'complete'

      expect(preservedCoverage).toBe('complete')

      const unrelated = relationNamed(snapshot, 'simple')
      expect(unrelated.management).toBe('managed')
      expect(tableOf(unrelated).columns.coverage.state).toBe('complete')
      expect(tableOf(unrelated).options.coverage.state).toBe('complete')

      expect(snapshot.diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'catalog.sqlite.metadata',
          message: expect.stringContaining(message) as unknown,
          target: relation.identity,
        }),
      )

      expect(() =>
        planMigration([], snapshot, sqliteDialect.migration.planning, {
          migrationOwnership: [
            { kind: 'completeNamespace', namespace: request.completeNamespaces[0]! },
          ],
        }),
      ).toThrow(/catalog|unknown|incomplete/i)
    },
  )
})

describe('SQLite catalog', () => {
  it('should treat successful malformed version rows as unknown catalog evidence', async () => {
    for (const rows of [[], [{ version: 42 }], [{ version: '3.bad.0' }]]) {
      const executor = emptyFixture()
      const snapshot = await sqliteCatalog.introspectCatalog(
        {
          execute: (query) =>
            query.sql.includes('sqlite_version')
              ? Promise.resolve(rows)
              : executor.execute(query),
        },
        request,
      )

      expect(snapshot.source.version).toBe('unknown')
      expect(snapshot.namespaces.coverage.state).toBe('unknown')

      expect(snapshot.diagnostics).toEqual([
        expect.objectContaining({ code: 'catalog.sqlite.metadata' }),
      ])
    }
  })

  it('should not infer a main namespace when database_list omits it', async () => {
    const executor = fixtureExecutor()
    const snapshot = await sqliteCatalog.introspectCatalog(
      {
        async execute(query) {
          const rows = await executor.execute(query)
          return query.sql.includes('database_list')
            ? rows.filter((row) => (row as { name: string }).name !== 'main')
            : rows
        },
      },
      request,
    )

    expect(snapshot.namespaces.items).toEqual([])
    expect(snapshot.namespaces.coverage.state).toBe('unknown')
    expectUnknownMetadata(snapshot, 'must contain exactly one main database')
  })
})

it('should report malformed reservation-only metadata for a narrow relation request', async () => {
  const snapshot = await sqliteCatalog.introspectCatalog(
    fixtureExecutor({ malformed: 'index-wrong-shape', withoutOpaqueDependencies: true }),
    {
      ...request,
      completeNamespaces: [],
      relations: [{ relation: { relation: 'simple' }, shape: 'complete' }],
    },
  )

  expect(relationNamed(snapshot, 'simple').management).toBe('managed')
  expect(snapshot.nameReservations.coverage.state).toBe('unknown')
  const diagnostic = snapshot.diagnostics.find(
    (entry) => entry.target?.relation.spelling === 'parent',
  )

  expect(diagnostic?.code).toBe('catalog.sqlite.metadata')
  expect(diagnostic?.message).toContain('index_list')

  expect(
    snapshot.diagnostics.filter((entry) => entry.target?.relation.spelling === 'parent'),
  ).toHaveLength(1)
})

it('should give final database-list decoding the same diagnostic in either row order', async () => {
  const observe = (reverse: boolean) => {
    const executor = fixtureExecutor()
    let reads = 0
    return sqliteCatalog.introspectCatalog(
      {
        async execute(query) {
          if (!query.sql.includes('database_list')) return executor.execute(query)

          const rows = await executor.execute(query)
          reads++

          if (reads === 1) return rows

          const malformed = [...rows, { seq: 1, name: 42, file: '' }]
          return reverse ? malformed.reverse() : malformed
        },
      },
      request,
    )
  }

  const forward = await observe(false)
  const reversed = await observe(true)
  expect(reversed).toEqual(forward)
  expectUnknownMetadata(forward, '"name" must be a non-empty string')
  expect(forward.namespaces.coverage.state).toBe('unknown')
})

it('should keep shared SQL parser failures at their reservation or relation scope', async () => {
  for (const [sql, message, global] of [
    [
      'CREATE TABLE parent /*',
      'Malformed SQLite schema SQL: unterminated block comment',
      true,
    ],
    ['CREATE TABLE parent', 'SQLite table definition has no column list', false],
  ] as const) {
    const fixture = fixtureExecutor({ withoutOpaqueDependencies: true })
    const snapshot = await sqliteCatalog.introspectCatalog(
      {
        execute: async (query) => {
          const rows = await fixture.execute(query)
          return query.sql.includes('sqlite_schema')
            ? rows.map((row) =>
                (row as { name?: string }).name === 'parent'
                  ? { ...(row as Record<string, unknown>), sql }
                  : row,
              )
            : rows
        },
      },
      global
        ? {
            ...request,
            completeNamespaces: [],
            relations: [{ relation: { relation: 'child' }, shape: 'complete' }],
          }
        : request,
    )

    const diagnostic = snapshot.diagnostics.find((entry) => entry.message === message)
    expect(diagnostic?.code).toBe('catalog.sqlite.metadata')
    expect(diagnostic?.target?.relation.spelling).toBe(global ? undefined : 'parent')
    expect(snapshot.namespaces.coverage.state).toBe(global ? 'unknown' : 'complete')
  }
})

it('should keep invalid foreign-key actions as relation-local metadata failures', async () => {
  const fixture = fixtureExecutor({ withoutOpaqueDependencies: true })
  const snapshot = await sqliteCatalog.introspectCatalog(
    {
      execute: async (query) => {
        const rows = await fixture.execute(query)
        return query.sql.includes('foreign_key_list') && query.params[0] === 'child'
          ? rows.map((row) => ({
              ...(row as Record<string, unknown>),
              on_delete: 'UNSUPPORTED',
            }))
          : rows
      },
    },
    request,
  )

  const child = relationNamed(snapshot, 'child')

  expect(child.management).toBe('unmanaged')

  expect(snapshot.diagnostics).toContainEqual(
    expect.objectContaining({
      code: 'catalog.sqlite.metadata',
      message: 'Malformed SQLite foreign_key_list row 0: invalid referential action',
      target: child.identity,
    }),
  )
})

it.each([
  ['normal assembly', undefined],
  ['recovery', 'index-wrong-shape'],
] as const)(
  'should let unrelated proof failures escape %s unchanged',
  async (_, malformed) => {
    const sqliteNormalize = await import('@/dialects/sqlite/normalize')

    for (const failure of [
      new InvariantError('proof defect'),
      new Error('proof defect'),
      'proof defect',
    ]) {
      const stack = failure instanceof Error ? failure.stack : undefined

      const spy = vi
        .spyOn(sqliteNormalize, 'normalizeSqliteDataType')
        .mockImplementation(() => {
          throw failure
        })

      try {
        await expect(
          sqliteCatalog.introspectCatalog(
            fixtureExecutor({ malformed, withoutOpaqueDependencies: true }),
            request,
          ),
        ).rejects.toBe(failure)

        expect(failure instanceof Error ? failure.stack : undefined).toBe(stack)
      } finally {
        spy.mockRestore()
      }
    }
  },
)

describe('SQLite catalog', () => {
  it('should preserve the exact executor failure, including an invariant error', async () => {
    for (const queryPart of ['sqlite_version', 'table_xinfo']) {
      const failure = new InvariantError(`query failed: ${queryPart}`)
      const executor = fixtureExecutor()
      await expect(
        sqliteCatalog.introspectCatalog(
          {
            execute: (query) =>
              query.sql.includes(queryPart)
                ? Promise.reject(failure)
                : executor.execute(query),
          },
          request,
        ),
      ).rejects.toBe(failure)
    }
  })

  it('should reject planning with damaged relation evidence before a plan exists', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ malformed: 'index-xinfo-wrong-flag' }),
      request,
    )

    expect(() =>
      planMigration([], snapshot, sqliteDialect.migration.planning, {
        migrationOwnership: [
          { kind: 'completeNamespace', namespace: request.completeNamespaces[0]! },
        ],
      }),
    ).toThrow(/catalog|unknown|incomplete/i)
  })
})

describe('SQLite catalog', () => {
  it('should keep unresolved foreign keys fail-closed', async () => {
    const result = await sqliteCatalog.introspectCatalog(fixtureExecutor(), {
      ...request,
      completeNamespaces: [],
      relations: [{ relation: { relation: 'child' }, shape: 'complete' }],
    })

    const child = result.namespaces.items[0]!.relations.items.find(
      (entry) => entry.identity.relation.spelling === 'child',
    )!

    expect(tableOf(child).foreignKeys.items[0]!.validity.state).toBe('unknown')
  })
})

describe('SQLite catalog', () => {
  it('should match explicit foreign-key targets by canonical column identity', async () => {
    const fixture = fixtureExecutor()
    const snapshot = await sqliteCatalog.introspectCatalog(
      {
        /** Executes fixture SQL with the configured native observations. */
        execute: async (query) => {
          const rows = await fixture.execute(query)

          if (query.sql.includes('sqlite_schema'))
            return rows.map((row) =>
              (row as { name?: string }).name === 'child'
                ? {
                    ...(row as Record<string, unknown>),
                    sql: 'CREATE TABLE child(id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER, FOREIGN KEY(pa) REFERENCES parent(v) ON DELETE CASCADE)',
                  }
                : row,
            )

          if (query.sql.includes('foreign_key_list') && query.params[0] === 'child')
            return [
              {
                id: 0,
                seq: 0,
                table: 'PARENT',
                from: 'PA',
                to: 'V',
                on_update: 'NO ACTION',
                on_delete: 'CASCADE',
                match: 'NONE',
              },
            ]

          return rows
        },
      },
      request,
    )

    const child = relationNamed(snapshot, 'child')
    expect(tableOf(child).foreignKeys.items[0]).toMatchObject({
      columns: ['pa'],
      referencedColumns: ['v'],
      validity: { state: 'present', value: 'valid' },
    })
  })
})

describe('SQLite catalog', () => {
  it('should totally order tied foreign keys regardless of native row order', async () => {
    const execute = executeSqliteCatalogFixture

    const snapshot = await sqliteCatalog.introspectCatalog(execute(false), request)
    const reversed = await sqliteCatalog.introspectCatalog(execute(true), request)
    const foreignKeys = tableOf(relationNamed(snapshot, 'child')).foreignKeys.items

    expect(reversed).toEqual(snapshot)

    expect(foreignKeys).toMatchObject([
      {
        columns: ['pa'],
        referencedColumns: ['id'],
        onDelete: 'cascade',
        onUpdate: 'no action',
        validity: { state: 'present', value: 'valid' },
      },
      {
        columns: ['pa'],
        referencedColumns: ['v'],
        onDelete: 'set null',
        onUpdate: 'restrict',
        validity: { state: 'present', value: 'valid' },
      },
    ])
  })
})

describe('SQLite catalog', () => {
  it('should order unresolved FK targets with ASCII-case-equivalent identities deterministically', async () => {
    /**
     * Creates a catalog executor with configurable native observations and query-order
     * tracking.
     *
     * @param reverse - Whether fixture rows should reverse their order to test canonical
     *   normalization.
     *
     * @returns A catalog executor with configurable native observations and query-order
     *   tracking.
     */
    const executor = (reverse: boolean): CatalogExecutor => {
      const fixture = fixtureExecutor({ reverse })
      const rows = [
        ...structuredClone(
          ordersUnresolvedFKTargetsWithASCIICaseEquivalentIdentitiesDeterministicallyRows,
        ),
      ]

      return {
        /** Executes fixture SQL with the configured native observations. */
        execute: async (query) => {
          if (
            query.sql.includes('pragma_foreign_key_list') &&
            query.params[0] === 'child'
          )
            return reverse ? [...rows].reverse() : rows

          const observed = await fixture.execute(query)
          return query.sql.includes('sqlite_schema')
            ? observed.map((row) =>
                (row as { name?: string }).name === 'child'
                  ? {
                      ...(row as Record<string, unknown>),
                      sql: 'CREATE TABLE child(id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER, FOREIGN KEY(pa) REFERENCES Missing(id) ON DELETE CASCADE, FOREIGN KEY(pa) REFERENCES missing(id) ON DELETE CASCADE)',
                    }
                  : row,
              )
            : observed
        },
      }
    }

    const forward = await sqliteCatalog.introspectCatalog(executor(false), request)
    const reverse = await sqliteCatalog.introspectCatalog(executor(true), request)
    const foreignKeys = tableOf(relationNamed(forward, 'child')).foreignKeys.items

    expect(reverse).toEqual(forward)

    expect(
      foreignKeys.map(({ referencedRelation }) => referencedRelation.relation.spelling),
    ).toEqual(['Missing', 'missing'])
  })
})

describe('SQLite catalog', () => {
  it('should preserve unsupported native evidence for rich objects', async () => {
    const result = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const virtual = result.namespaces.items[0]!.relations.items.find(
      (entry) => entry.identity.relation.spelling === 'virt',
    )!

    expect(virtual.kind).toBe('virtualTable')
    expect(virtual.management).toBe('unmanaged')
    expect(virtual.nativeDefinition.state).toBe('present')
  })

  it('should reject attached scopes before version gating', async () => {
    for (const variant of [
      {
        relations: [
          {
            relation: {
              namespace: [{ role: 'database' as const, spelling: 'aux' }],
              relation: 'x',
            },
            shape: 'complete' as const,
          },
        ],
      },
      {
        absentRelations: [
          { namespace: [{ role: 'database' as const, spelling: 'aux' }], relation: 'x' },
        ],
      },
      { completeNamespaces: [[{ role: 'database' as const, spelling: 'aux' }]] },
      { registrationDefault: [{ role: 'database' as const, spelling: 'aux' }] },
    ])
      await expect(
        sqliteCatalog.introspectCatalog(fixtureExecutor({ version: '3.36.0' }), {
          ...request,
          ...variant,
        }),
      ).rejects.toMatchObject({ _tag: 'InvariantError' })
  })
})

const quotedIndexInfoRows = [
  {
    seqno: 0,
    cid: 0,
    name: 'value',
    desc: 0,
    coll: 'BINARY',
    key: 1,
  },
]

const indexInfoRows: Record<string, unknown[]> = {
  pk_desc_auto: [{ seqno: 0, cid: 0, name: 'id', desc: 1, coll: 'BINARY', key: 1 }],
  parent_n: [
    {
      seqno: 0,
      cid: 1,
      name: 'v',
      desc: 0,
      coll: 'BINARY',
      key: 1,
    },
  ],
  rich_desc: [
    {
      seqno: 0,
      cid: 1,
      name: 'v',
      desc: 1,
      coll: 'BINARY',
      key: 1,
    },
  ],
  rich_partial: [
    {
      seqno: 0,
      cid: 1,
      name: 'v',
      desc: 0,
      coll: 'BINARY',
      key: 1,
    },
  ],
  rich_expr: [
    {
      seqno: 0,
      cid: -2,
      name: null,
      desc: 0,
      coll: 'BINARY',
      key: 1,
    },
  ],
  rich_coll: [
    {
      seqno: 0,
      cid: 1,
      name: 'v',
      desc: 0,
      coll: 'NOCASE',
      key: 1,
    },
  ],
  u_auto: [
    {
      seqno: 0,
      cid: 1,
      name: 'v',
      desc: 0,
      coll: 'BINARY',
      key: 1,
    },
  ],
  u_auto2: [
    {
      seqno: 0,
      cid: 2,
      name: 'b',
      desc: 0,
      coll: 'BINARY',
      key: 1,
    },
  ],
  wr_auto_auto: [
    {
      seqno: 0,
      cid: 0,
      name: 'a',
      desc: 0,
      coll: 'BINARY',
      key: 1,
    },
    {
      seqno: 1,
      cid: 1,
      name: 'b',
      desc: 0,
      coll: 'BINARY',
      key: 1,
    },
  ],
  wr_auto: [
    {
      seqno: 0,
      cid: 0,
      name: 'id',
      desc: 0,
      coll: 'BINARY',
      key: 1,
    },
  ],
}

const defaultIndexInfoRows = [
  {
    seqno: 0,
    cid: 0,
    name: 'id',
    desc: 1,
    coll: 'NOCASE',
    key: 1,
  },
]

/** Checks stable errors for malformed native rows and duplicate SQLite identity keys. */
async function assertMalformedSqliteIdentityRows() {
  expectUnknownMetadata(
    await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ malformed: 'database-wrong-type' }),
      request,
    ),
    '"name" must be a non-empty string',
  )

  expectUnknownMetadata(
    await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ malformed: 'xinfo-missing-name' }),
      request,
    ),
    '"name" must be a non-empty string',
  )

  expectUnknownMetadata(
    await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ malformed: 'fk-wrong-target' }),
      request,
    ),
    '"to" must be a string or null',
  )

  expectUnknownMetadata(
    await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ malformed: 'schema-case-duplicate' }),
      request,
    ),
    'Duplicate SQLite sqlite_schema relation name',
  )

  expectUnknownMetadata(
    await sqliteCatalog.introspectCatalog(
      fixtureExecutor({ malformed: 'table-case-duplicate' }),
      request,
    ),
    'Duplicate SQLite table_list relation',
  )
}

/**
 * Checks that attached and temporary objects prevent complete main-database management.
 *
 * @param reversed - Whether native observation order is reversed for determinism checks.
 * @param snapshot - Observed catalog snapshot whose evidence is checked or projected.
 * @param parent - Parent relation or syntax node used by the fixture scenario.
 */
function assertExternalNamespaceDiagnostics(
  reversed: CatalogSnapshot,
  snapshot: CatalogSnapshot,
  parent: CatalogRelation,
) {
  expect(reversed).toEqual(snapshot)
  expect(parent.management).toBe('unmanaged')

  expect(
    tableOf(parent).opaqueObjects.items.some((object) =>
      object.reason.includes('Attached or temporary'),
    ),
  ).toBe(true)

  expect(snapshot.diagnostics.map(({ code, message }) => [code, message])).toEqual(
    structuredClone(assertBlocksMainManagementWhenAttachedOrTemporaryObjectsAreData),
  )

  expect(snapshot.constraintNameReservations.coverage).toMatchObject({
    state: 'unknown',
  })
}

/**
 * Checks decoded defaults, nullability, and rowid generation without inventing
 * unsupported facts.
 *
 * @param columns - Ordered column names, references, or observations used by this
 *   operation.
 */
function assertSqliteColumnEvidence(columns: readonly CatalogColumn[]) {
  expect(columns[1]!.default).toMatchObject({
    state: 'present',
    value: {
      kind: 'literal',
      native: "'safe'",
      comparisonKey: { state: 'present', value: "'safe'" },
    },
  })

  expect(columns[4]!.default).toMatchObject({
    state: 'present',
    value: {
      kind: 'portableExpression',
      native: "(lower('x'))",
      comparisonKey: { state: 'present', value: "lower('x')" },
    },
  })

  expect(columns[2]!.default).toMatchObject({
    state: 'present',
    value: {
      kind: 'literal',
      native: 'TRUE',
      comparisonKey: { state: 'present', value: '1' },
    },
  })

  expect(columns[0]!.generation).toMatchObject({
    state: 'present',
    value: { kind: 'rowidAlias', autoIncrement: true },
  })
}

/**
 * Checks primary, unique, and index evidence decoded for the parent relation.
 *
 * @param s - Catalog snapshot being projected into the fixture assertion shape.
 */
function assertParentKeysAndIndexes(s: CatalogSnapshot) {
  const parentTable = tableOf(relationNamed(s, 'parent'))
  expect(parentTable.primaryKey).toMatchObject({
    state: 'present',
    value: { columns: ['id'], name: { state: 'absent' } },
  })

  expect(parentTable.uniqueConstraints.items.map(({ columns: names }) => names)).toEqual([
    ['b'],
    ['v'],
  ])

  expect(parentTable.uniqueConstraints.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        columns: ['b'],
        semantics: { state: 'present', value: { kind: 'simple' } },
        validity: { state: 'present', value: 'valid' },
        name: { state: 'absent' },
      }),
    ]),
  )

  expect(parentTable.indexes.items.map((index) => index.name)).toContainEqual({
    state: 'present',
    value: 'parent_n',
  })

  expect(parentTable.indexes.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        name: { state: 'present', value: 'parent_n' },
        origin: 'user',
        unique: false,
        semantics: { state: 'present', value: { kind: 'simple' } },
        validity: { state: 'present', value: 'valid' },
        nativeDefinition: {
          state: 'present',
          value: 'CREATE INDEX parent_n ON parent(v)',
        },
      }),
    ]),
  )

  expect(parentTable.options.items).toEqual([
    { name: 'strict', value: 'false' },
    { name: 'withoutRowid', value: 'false' },
  ])
}

/**
 * Creates catalog observations whose requested row order can be reversed.
 *
 * @param reverse - Whether fixture rows should reverse their order to test canonical
 *   normalization.
 *
 * @returns Catalog observations whose requested row order can be reversed.
 */
function executeSqliteCatalogFixture(reverse: boolean): CatalogExecutor {
  const fixture = fixtureExecutor({ reverse })

  return {
    /** Executes fixture SQL with the configured native observations. */
    execute: async (query) => {
      if (query.sql.includes('sqlite_schema')) {
        const rows = await fixture.execute(query)
        return rows.map((row) =>
          (row as { name?: string }).name === 'child'
            ? {
                ...(row as Record<string, unknown>),
                sql: 'CREATE TABLE child(id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER, FOREIGN KEY(pa) REFERENCES parent(id) ON DELETE CASCADE, FOREIGN KEY(pa) REFERENCES parent(v) ON UPDATE RESTRICT ON DELETE SET NULL)',
              }
            : row,
        )
      }

      if (query.sql.includes('foreign_key_list') && query.params[0] === 'child') {
        const rows = structuredClone(executeSqliteCatalogFixtureRows)

        return reverse ? rows.reverse() : rows
      }

      return fixture.execute(query)
    },
  }
}

// oxlint-disable-next-line complexity
/**
 * Dispatches native SQLite catalog queries and applies configured races or malformed-row
 * variations.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param tables - Observed table definitions used to build fixture catalog evidence.
 * @param schema - Valibot schema used to read validation, storage, and metadata facts.
 * @param xinfo - Native table-column observations indexed by table name.
 * @param calls - Recorded SQL, lifecycle, or hook calls used by the test assertions.
 *
 * @returns Native catalog rows with configured races and malformed observations.
 */
async function executeSqliteFixture(
  query: Parameters<CatalogExecutor['execute']>[0],
  options: FixtureOptions,
  tables: unknown[],
  schema: unknown[],
  xinfo: ReturnType<typeof fixtureColumnRows>,
  calls: Map<string, number>,
): Promise<unknown[]> {
  const p = query.params
  let rows: unknown[] = readSqliteFixtureRows(query, options, tables, schema, xinfo, p)

  if (options.simpleForeignKey && query.sql.includes('foreign_key_list'))
    rows =
      p[0] === 'child'
        ? [
            {
              id: 0,
              seq: 0,
              table: 'parent',
              from: 'pa',
              to: 'id',
              on_update: 'CASCADE',
              on_delete: 'SET NULL',
              match: 'NONE',
            },
          ]
        : []

  const key = query.sql + JSON.stringify(query.params)
  const count = (calls.get(key) ?? 0) + 1
  calls.set(key, count)

  rows = applyRichUniqueIndexRows(options, query, p, rows)

  rows = malformedIndexRows(rows, query, options)

  if (options.race && count > 1 && query.sql.includes(options.race))
    rows = [
      ...rows,
      ...(rows[0]
        ? [{ ...(rows[0] as Record<string, unknown>), name: 'race_added' }]
        : []),
    ]

  rows = malformedFixtureRows(rows, query, options)

  if (options.reverse) rows = rows.slice().reverse()

  return rows
}

/**
 * Injects richer native unique-index semantics into the selected fixture query result.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param p - Parameters supplied to the native fixture SQL call.
 * @param rows - Ordered native observations or result rows to process.
 *
 * @returns Native rows with richer unique-index semantics injected into the selected
 *   query.
 */
function applyRichUniqueIndexRows(
  options: FixtureOptions,
  query: { sql: string; params: unknown[] },
  p: unknown[],
  rows: unknown[],
) {
  if (options.richUniqueIndex && query.sql.includes('index_list') && p[0] === 'simple')
    rows = [{ seq: 0, name: 'simple_unique', unique: 1, origin: 'u', partial: 0 }]

  if (
    options.richUniqueIndex &&
    query.sql.includes('index_xinfo') &&
    p[0] === 'simple_unique'
  )
    rows = [{ seqno: 0, cid: 1, name: 'value', desc: 1, coll: 'BINARY', key: 1 }]

  return rows
}

/**
 * Selects native SQLite fixture rows for the requested PRAGMA or inventory query.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param tables - Observed table definitions used to build fixture catalog evidence.
 * @param schema - Valibot schema used to read validation, storage, and metadata facts.
 * @param xinfo - Native table-column observations indexed by table name.
 * @param p - Parameters supplied to the native fixture SQL call.
 *
 * @returns The configured native observations for the requested SQLite catalog query.
 */
function readSqliteFixtureRows(
  query: { sql: string; params: unknown[] },
  options: FixtureOptions,
  tables: unknown[],
  schema: unknown[],
  xinfo: Record<string, unknown[]>,
  p: unknown[],
): unknown[] {
  return query.sql.includes('sqlite_version')
    ? [{ version: options.version ?? '3.37.0' }]
    : query.sql.includes('database_list')
      ? [{ seq: 0, name: 'main', file: '' }]
      : query.sql.includes('table_list')
        ? tables
        : query.sql.includes('sqlite_schema')
          ? schema
          : query.sql.includes('table_xinfo')
            ? (xinfo[String(p[0])] ?? []).map((row) => ({
                ...(row as Record<string, unknown>),
                column_notnull: (row as Record<string, unknown>).notnull,
              }))
            : query.sql.includes('index_list')
              ? fixtureIndexList(p, options)
              : query.sql.includes('index_xinfo')
                ? fixtureIndexInfo(p, options)
                : query.sql.includes('foreign_key_list')
                  ? p[0] === 'child'
                    ? structuredClone(executeSqliteFixtureData)
                    : []
                  : []
}

/**
 * Adds attached and temporary database observations to the ordinary SQLite catalog
 * fixture.
 *
 * @param reverse - Whether fixture rows should reverse their order to test canonical
 *   normalization.
 *
 * @returns A catalog executor adding attached and temporary namespace observations.
 */
function createExternalSqliteExecutor(reverse: boolean): CatalogExecutor {
  const fixture = fixtureExecutor({ reverse })

  return {
    /** Executes fixture SQL with the configured native observations. */
    execute: async (query) => {
      const rows = await fixture.execute(query)

      if (query.sql.includes('database_list')) {
        const databases = [
          { seq: 0, name: 'main', file: '' },
          { seq: 1, name: 'aux', file: 'aux.db' },
          { seq: 2, name: 'temp', file: '' },
        ]

        return reverse ? databases.reverse() : databases
      }

      if (query.sql.includes('table_list')) {
        const relations = [
          ...rows,
          {
            schema: 'aux',
            name: 'attached_item',
            type: 'table',
            ncol: 1,
            wr: 0,
            strict: 0,
          },
          {
            schema: 'temp',
            name: 'temporary_item',
            type: 'table',
            ncol: 1,
            wr: 0,
            strict: 0,
          },
        ]

        return reverse ? relations.reverse() : relations
      }

      return rows
    },
  }
}
