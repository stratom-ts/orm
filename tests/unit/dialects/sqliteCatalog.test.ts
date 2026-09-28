import { describe, expect, it } from 'vitest'

import type {
  CatalogExecutor,
  CatalogRelation,
  CatalogRequest,
  CatalogSnapshot,
  CatalogTable,
} from '@/dialects'
import { sqliteCatalog } from '@/dialects'

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

// oxlint-disable-next-line complexity
function fixtureExecutor(options: FixtureOptions = {}): CatalogExecutor {
  const tables = [
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

  if (options.withoutOpaqueDependencies) {
    for (let index = tables.length - 1; index >= 0; index--)
      if (tables[index]!.type === 'view') tables.splice(index, 1)
  }

  if (options.quotedName !== undefined)
    tables.push({
      schema: 'main',
      name: options.quotedName,
      type: 'table',
      ncol: 1,
      wr: 0,
      strict: 0,
    })

  const schema = [
    {
      type: 'table',
      name: 'parent',
      tbl_name: 'parent',
      sql: "CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, v VARCHAR(12) DEFAULT 'safe', b BLOB DEFAULT TRUE, r DOUBLE, d DECIMAL(10,2) DEFAULT (lower('x')))",
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

  if (options.namedConstraint)
    schema[0]!.sql =
      'CREATE TABLE parent(id INTEGER, v TEXT, CONSTRAINT named_pk PRIMARY KEY(id), CONSTRAINT named_u UNIQUE(v))'

  if (options.namedConstraint)
    schema[1]!.sql =
      'CREATE TABLE child(id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER, CONSTRAINT named_fk FOREIGN KEY(pa,pb) REFERENCES parent(id,v))'

  if (options.simpleForeignKey)
    schema[1]!.sql =
      'CREATE TABLE child(id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER, FOREIGN KEY(pa) REFERENCES parent(id))'

  if (options.matchClause) schema[1]!.sql = `${schema[1]!.sql!.slice(0, -1)} MATCH FULL)`

  if (options.richUniqueIndex)
    schema.find((entry) => entry.name === 'simple')!.sql =
      'CREATE TABLE simple(id INTEGER PRIMARY KEY, value TEXT UNIQUE)'

  if (options.opaqueDefault)
    schema.find((entry) => entry.name === 'simple')!.sql =
      'CREATE TABLE simple(id INTEGER PRIMARY KEY, value TEXT DEFAULT (random()))'

  if (options.checkConstraint)
    schema[0]!.sql = `${schema[0]!.sql!.slice(0, -1)}, CHECK (b IS NULL OR b = 1))`

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

  if (options.withoutOpaqueDependencies) {
    for (let index = schema.length - 1; index >= 0; index--)
      if (schema[index]!.type === 'view' || schema[index]!.type === 'trigger')
        schema.splice(index, 1)
  }

  if (options.crossTableTrigger)
    schema.push({
      type: 'trigger',
      name: 'cross_table_trigger',
      tbl_name: 'parent',
      sql: 'CREATE TRIGGER cross_table_trigger AFTER UPDATE ON parent BEGIN UPDATE child SET pa = new.id; END',
    })

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

  const xinfo: Record<string, unknown[]> = {
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
        type: '',
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
        notnull: 0,
        dflt_value: null,
        pk: 1,
        hidden: 0,
      },
    ],
    wr_auto: [
      { cid: 0, name: 'a', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1, hidden: 0 },
      { cid: 1, name: 'b', type: 'TEXT', notnull: 0, dflt_value: null, pk: 2, hidden: 0 },
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

  const calls = new Map<string, number>()
  return {
    // oxlint-disable-next-line complexity
    execute: async (query) => {
      const p = query.params
      let rows: unknown[] = query.sql.includes('sqlite_version')
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
                  ? p[0] === options.quotedName && options.quotedIndexName !== undefined
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
                      ? [
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
                  : query.sql.includes('index_xinfo')
                    ? p[0] === options.quotedIndexName
                      ? [
                          {
                            seqno: 0,
                            cid: 0,
                            name: 'value',
                            desc: 0,
                            coll: 'BINARY',
                            key: 1,
                          },
                        ]
                      : p[0] === 'parent_n'
                        ? [
                            {
                              seqno: 0,
                              cid: 1,
                              name: 'v',
                              desc: 0,
                              coll: 'BINARY',
                              key: 1,
                            },
                          ]
                        : p[0] === 'rich_desc'
                          ? [
                              {
                                seqno: 0,
                                cid: 1,
                                name: 'v',
                                desc: 1,
                                coll: 'BINARY',
                                key: 1,
                              },
                            ]
                          : p[0] === 'rich_partial'
                            ? [
                                {
                                  seqno: 0,
                                  cid: 1,
                                  name: 'v',
                                  desc: 0,
                                  coll: 'BINARY',
                                  key: 1,
                                },
                              ]
                            : p[0] === 'rich_expr'
                              ? [
                                  {
                                    seqno: 0,
                                    cid: -2,
                                    name: null,
                                    desc: 0,
                                    coll: 'BINARY',
                                    key: 1,
                                  },
                                ]
                              : p[0] === 'rich_coll'
                                ? [
                                    {
                                      seqno: 0,
                                      cid: 1,
                                      name: 'v',
                                      desc: 0,
                                      coll: 'NOCASE',
                                      key: 1,
                                    },
                                  ]
                                : p[0] === 'u_auto'
                                  ? [
                                      {
                                        seqno: 0,
                                        cid: 1,
                                        name: 'v',
                                        desc: 0,
                                        coll: 'BINARY',
                                        key: 1,
                                      },
                                    ]
                                  : p[0] === 'u_auto2'
                                    ? [
                                        {
                                          seqno: 0,
                                          cid: 2,
                                          name: 'b',
                                          desc: 0,
                                          coll: 'BINARY',
                                          key: 1,
                                        },
                                      ]
                                    : p[0] === 'wr_auto_auto'
                                      ? [
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
                                        ]
                                      : p[0] === 'wr_auto'
                                        ? [
                                            {
                                              seqno: 0,
                                              cid: 0,
                                              name: 'id',
                                              desc: 0,
                                              coll: 'BINARY',
                                              key: 1,
                                            },
                                          ]
                                        : [
                                            {
                                              seqno: 0,
                                              cid: 0,
                                              name: 'id',
                                              desc: 1,
                                              coll: 'NOCASE',
                                              key: 1,
                                            },
                                          ]
                    : query.sql.includes('foreign_key_list')
                      ? p[0] === 'child'
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
                        : []
                      : []

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

      if (
        options.richUniqueIndex &&
        query.sql.includes('index_list') &&
        p[0] === 'simple'
      )
        rows = [{ seq: 0, name: 'simple_unique', unique: 1, origin: 'u', partial: 0 }]

      if (
        options.richUniqueIndex &&
        query.sql.includes('index_xinfo') &&
        p[0] === 'simple_unique'
      )
        rows = [{ seqno: 0, cid: 1, name: 'value', desc: 1, coll: 'BINARY', key: 1 }]

      if (
        options.malformed === 'index-invalid-origin' &&
        query.sql.includes('index_list')
      )
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

      if (
        options.malformed === 'index-xinfo-wrong-flag' &&
        query.sql.includes('index_xinfo') &&
        p[0] === 'parent_n'
      )
        rows = rows.map((row) => ({ ...(row as Record<string, unknown>), desc: 2 }))

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

      if (options.race && count > 1 && query.sql.includes(options.race))
        rows = [
          ...rows,
          ...(rows[0]
            ? [{ ...(rows[0] as Record<string, unknown>), name: 'race_added' }]
            : []),
        ]

      if (options.malformed === 'duplicate' && query.sql.includes('database_list'))
        rows = [...rows, ...rows]

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

      if (
        options.malformed === 'schema-unknown-type' &&
        query.sql.includes('sqlite_schema')
      )
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

      if (
        options.malformed === 'table-case-duplicate' &&
        query.sql.includes('table_list')
      )
        rows = [
          ...rows,
          { schema: 'MAIN', name: 'PARENT', type: 'table', ncol: 5, wr: 0, strict: 0 },
        ]

      if (
        options.malformed === 'table-unlisted-database' &&
        query.sql.includes('table_list')
      )
        rows = [
          ...rows,
          { schema: 'ghost', name: 'outside', type: 'table', ncol: 1, wr: 0, strict: 0 },
        ]

      if (
        options.malformed === 'database-wrong-type' &&
        query.sql.includes('database_list')
      )
        rows = rows.map((row) => ({ ...(row as Record<string, unknown>), name: 42 }))

      if (options.malformed === 'xinfo-missing-name' && query.sql.includes('table_xinfo'))
        rows = rows.map((row) => {
          const { name: _name, ...rest } = row as Record<string, unknown>

          return rest
        })

      if (
        options.malformed === 'fk-wrong-target' &&
        query.sql.includes('foreign_key_list')
      )
        rows = rows.map((row) => ({ ...(row as Record<string, unknown>), to: 42 }))

      if (options.malformed === 'xinfo-gap' && query.sql.includes('table_xinfo'))
        rows = rows.map((row) => ({ ...(row as Record<string, unknown>), cid: 1 }))

      if (options.malformed === 'ncol' && query.sql.includes('table_list'))
        rows = rows.map((row) => ({ ...(row as Record<string, unknown>), ncol: 99 }))

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

      if (options.reverse) rows = rows.slice().reverse()

      return rows
    },
  }
}

function relationNamed(snapshot: CatalogSnapshot, name: string): CatalogRelation {
  const relation = snapshot.namespaces.items[0]?.relations.items.find(
    (entry) => entry.identity.relation.spelling === name,
  )
  expect(relation).toBeDefined()

  if (relation === undefined) throw new Error(`Missing SQLite relation ${name}`)

  return relation
}

function tableOf(relation: CatalogRelation): CatalogTable {
  expect(relation.table.state).toBe('present')

  if (relation.table.state !== 'present')
    throw new Error(
      `Missing SQLite table evidence for ${relation.identity.relation.spelling}`,
    )

  return relation.table.value
}

describe('SQLite evidence-bearing catalog', () => {
  const emptyFixture = (version = '3.37.0'): CatalogExecutor => ({
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

  it('fixture decodes all affinity families and native spelling', async () => {
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

  it('fixture preserves defaults and rowid generation', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const columns = tableOf(relationNamed(s, 'parent')).columns.items
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

    const parentTable = tableOf(relationNamed(s, 'parent'))
    expect(parentTable.primaryKey).toMatchObject({
      state: 'present',
      value: { columns: ['id'], name: { state: 'absent' } },
    })

    expect(
      parentTable.uniqueConstraints.items.map(({ columns: names }) => names),
    ).toEqual([['b'], ['v']])

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

  it('fixture retains composite FK ordering and actions', async () => {
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

  it('fixture reversals are deeply equal', async () => {
    expect(
      await sqliteCatalog.introspectCatalog(fixtureExecutor({ reverse: true }), request),
    ).toEqual(await sqliteCatalog.introspectCatalog(fixtureExecutor(), request))
  })

  it('fixture marks strict and without-rowid unmanaged', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    expect(
      s.namespaces.items[0]!.relations.items.find(
        (r) => r.identity.relation.spelling === 'wr',
      )!.management,
    ).toBe('unmanaged')

    expect(
      s.namespaces.items[0]!.relations.items.find(
        (r) => r.identity.relation.spelling === 'strict_t',
      )!.management,
    ).toBe('unmanaged')
  })

  it('blocks main management when attached or temporary objects are present', async () => {
    const executeExternal = (reverse: boolean): CatalogExecutor => {
      const fixture = fixtureExecutor({ reverse })

      return {
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

    const snapshot = await sqliteCatalog.introspectCatalog(
      executeExternal(false),
      request,
    )
    const reversed = await sqliteCatalog.introspectCatalog(executeExternal(true), request)
    const parent = relationNamed(snapshot, 'parent')

    expect(reversed).toEqual(snapshot)
    expect(parent.management).toBe('unmanaged')

    expect(
      tableOf(parent).opaqueObjects.items.some((object) =>
        object.reason.includes('Attached or temporary'),
      ),
    ).toBe(true)

    expect(snapshot.diagnostics.map(({ code, message }) => [code, message])).toEqual([
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
    ])

    expect(snapshot.constraintNameReservations.coverage).toMatchObject({
      state: 'unknown',
    })
  })

  it('fixture emits view virtual and shadow kinds', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const rs = snapshot.namespaces.items[0]!.relations.items
    expect(rs.find((r) => r.identity.relation.spelling === 'v')!.kind).toBe('view')

    expect(rs.find((r) => r.identity.relation.spelling === 'virt')!.kind).toBe(
      'virtualTable',
    )

    expect(rs.find((r) => r.identity.relation.spelling === 'virt_shadow')!.kind).toBe(
      'shadowTable',
    )

    expect(
      tableOf(relationNamed(snapshot, 'virt')).columns.items[0]!.generation.state,
    ).toBe('unsupported')

    expect(
      tableOf(relationNamed(snapshot, 'virt_shadow')).columns.items[0]!.generation.state,
    ).toBe('unsupported')
  })

  it('preserves CHECK, generated-column, and rich-index evidence', async () => {
    const snapshot = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const generated = relationNamed(snapshot, 'generated_t')
    const generatedTable = tableOf(generated)

    expect(generated.management).toBe('unmanaged')
    expect(generatedTable.columns.items[1]!.generation.state).toBe('unsupported')

    expect(generatedTable.columns.items[1]!.nativeDefinition).toMatchObject({
      state: 'present',
      value: expect.stringContaining('GENERATED ALWAYS'),
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

  it('does not claim unknown constraint names or rowid planning support', async () => {
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
        expect.objectContaining({ name: expect.objectContaining({ state: 'unknown' }) }),
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

  it('fixture preserves trigger opaque evidence', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const parent = relationNamed(s, 'parent')
    expect(
      tableOf(parent).opaqueObjects.items.some((object) => object.kind === 'trigger'),
    ).toBe(true)
  })

  it('allows trigger names to share relation names without reserving trigger-only names', async () => {
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

  it('keeps rowid aliases and unnamed simple constraints in the managed profile', async () => {
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

  it('keeps uncomparable native defaults opaque and unmanaged', async () => {
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

  it('keeps rich auto-index UNIQUE constraints unmanaged', async () => {
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

  it('treats authored MATCH clauses as opaque despite PRAGMA match NONE', async () => {
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
          value: expect.stringContaining('MATCH FULL'),
        },
        reason: expect.stringContaining('MATCH'),
      }),
    )

    expect(tableOf(child).foreignKeys.items[0]!.semantics).toMatchObject({
      state: 'present',
    })
  })

  it('reports SQLite owner facts as unsupported by the engine', async () => {
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

  it('keeps trigger dependencies opaque across candidate tables', async () => {
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

  it('marks unrepresented table clauses opaque without false positives in literals or comments', async () => {
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
            value: expect.stringContaining('CREATE TABLE'),
          },
          reason: expect.stringContaining(
            'SQLite table clauses are not fully represented',
          ),
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

  it('preserves the INTEGER PRIMARY KEY DESC exception', async () => {
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

  it('blocks tables when view dependencies are unknown and preserves view triggers', async () => {
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

  it('reserves unrelated indexes and auto-indexes outside relation scope', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), {
      ...request,
      completeNamespaces: [],
      relations: [{ relation: { relation: 'child' }, shape: 'complete' }],
    })
    expect(s.nameReservations.coverage.state).toBe('complete')
    expect(s.nameReservations.items.map((n) => n.name)).toContain('parent_n')
    expect(s.nameReservations.items.map((n) => n.name)).toContain('u_auto')
  })

  it('fixture malformed database rows are tagged invariants', async () => {
    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'duplicate' }),
        request,
      ),
    ).rejects.toMatchObject({ _tag: 'InvariantError' })
  })

  it('observes requested absence without claiming complete namespace coverage', async () => {
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

  it('does not fabricate absence when the requested identity is present', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), {
      relations: [],
      absentRelations: [{ relation: 'child' }],
      completeNamespaces: [],
    })

    expect(s.request.absentRelations[0]!.relation.spelling).toBe('child')
    expect(relationNamed(s, 'child').table.state).toBe('present')
    expect(s.namespaces.items[0]!.relations.coverage.state).toBe('partial')
  })

  it('fixture rejects attached relation scopes', async () => {
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

  it('fixture gates exact minimum version', async () => {
    const executed: string[] = []
    const fixture = fixtureExecutor({ version: '3.37.0' })
    const snapshot = await sqliteCatalog.introspectCatalog(
      {
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

  it('gates versions before querying any PRAGMA', async () => {
    const calls: string[] = []
    const old = await sqliteCatalog.introspectCatalog(
      {
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

  it('resolves omitted namespace to main', async () => {
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

  it('emits complete empty main', async () => {
    expect(
      (await sqliteCatalog.introspectCatalog(emptyFixture(), request)).namespaces
        .items[0]!.relations.items,
    ).toEqual([])
  })

  it('emits partial empty main', async () => {
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

  it('deduplicates request identities', async () => {
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

  it('rejects attached registration defaults', async () => {
    await expect(
      sqliteCatalog.introspectCatalog(emptyFixture(), {
        ...request,
        registrationDefault: [{ role: 'database', spelling: 'aux' }],
      }),
    ).rejects.toMatchObject({ _tag: 'InvariantError' })
  })

  it('parameterizes and observes quoted table and index names', async () => {
    const calls: { sql: string; params: unknown[] }[] = []
    const tableName = 'odd"table'
    const indexName = 'odd"index'
    const fixture = fixtureExecutor({ quotedName: tableName, quotedIndexName: indexName })
    const snapshot = await sqliteCatalog.introspectCatalog(
      {
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

  it('reports unsupported old versions deterministically', async () => {
    expect(
      (await sqliteCatalog.introspectCatalog(emptyFixture('3.36.9'), request))
        .diagnostics[0]!.code,
    ).toBe('catalog.capability.version')
  })

  it('preserves resolved request shape', async () => {
    const result = await sqliteCatalog.introspectCatalog(emptyFixture(), {
      ...request,
      relations: [{ relation: { relation: 'x' }, shape: 'additive' }],
    })
    expect(result.request.relations[0]!.shape).toBe('additive')
  })

  it('rejects malformed cross-PRAGMA observations', async () => {
    for (const [malformed, message] of [
      ['xinfo-gap', 'SQLite table "parent" table_xinfo cids must be contiguous'],
      ['ncol', 'SQLite table "parent" table_list ncol does not match table_xinfo'],
      ['fk-duplicate', 'SQLite foreign-key group on "child" has non-contiguous sequence'],
      ['fk-source', 'SQLite foreign key on "child" references a missing source column'],
    ])
      await expect(
        sqliteCatalog.introspectCatalog(fixtureExecutor({ malformed }), request),
      ).rejects.toThrow(message)
  })

  it('rejects malformed and inconsistent index observations with stable messages', async () => {
    const cases = [
      ['index-invalid-origin', 'Malformed SQLite index_list row 0: invalid origin'],
      ['index-invalid-flags', 'SQLite UNIQUE index "u_auto" has invalid flags'],
      [
        'index-wrong-shape',
        'Malformed SQLite index_list row 0: "unique" must be an integer',
      ],
      [
        'index-xinfo-wrong-flag',
        'Malformed SQLite index_xinfo row 0: "desc" must be 0 or 1',
      ],
      [
        'index-xinfo-expression',
        'SQLite index "parent_n" has a malformed expression term',
      ],
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
    ] as const

    for (const [malformed, message] of cases)
      await expect(
        sqliteCatalog.introspectCatalog(fixtureExecutor({ malformed }), request),
      ).rejects.toThrow(message)
  })

  it('rejects malformed and ASCII-equivalent schema rows with stable errors', async () => {
    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'database-wrong-type' }),
        request,
      ),
    ).rejects.toThrow(
      'Malformed SQLite database_list row 0: "name" must be a non-empty string',
    )

    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'xinfo-missing-name' }),
        request,
      ),
    ).rejects.toThrow(
      'Malformed SQLite table_xinfo row 0: "name" must be a non-empty string',
    )

    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'fk-wrong-target' }),
        request,
      ),
    ).rejects.toThrow(
      'Malformed SQLite foreign_key_list row 0: "to" must be a string or null',
    )

    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'schema-case-duplicate' }),
        request,
      ),
    ).rejects.toThrow('Duplicate SQLite sqlite_schema relation name "PARENT"')

    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'table-case-duplicate' }),
        request,
      ),
    ).rejects.toThrow('Duplicate SQLite table_list relation "MAIN"."PARENT"')

    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'table-unlisted-database' }),
        request,
      ),
    ).rejects.toThrow(
      'SQLite table_list row "outside" references an unlisted database alias "ghost"',
    )

    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'schema-unknown-type' }),
        request,
      ),
    ).rejects.toThrow('Malformed SQLite sqlite_schema row: invalid type "mystery"')

    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'schema-relation-name-mismatch' }),
        request,
      ),
    ).rejects.toThrow(
      'SQLite sqlite_schema table row "parent" has mismatched tbl_name "other"',
    )

    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'schema-view-type-mismatch' }),
        request,
      ),
    ).rejects.toThrow(
      'SQLite table_list relation "v" type "view" disagrees with sqlite_schema type "table"',
    )
  })

  it('rejects catalog races including reservation-only indexes', async () => {
    for (const race of ['table_list', 'table_xinfo', 'sqlite_schema', 'index_list'])
      await expect(
        sqliteCatalog.introspectCatalog(fixtureExecutor({ race }), request),
      ).rejects.toThrow(/catalog changed during introspection/i)
  })

  it('keeps unresolved foreign keys fail-closed', async () => {
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

  it('matches explicit foreign-key targets by canonical column identity', async () => {
    const fixture = fixtureExecutor()
    const snapshot = await sqliteCatalog.introspectCatalog(
      {
        execute: async (query) => {
          const rows = await fixture.execute(query)

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

  it('totally orders tied foreign keys regardless of native row order', async () => {
    const execute = (reverse: boolean): CatalogExecutor => {
      const fixture = fixtureExecutor({ reverse })

      return {
        execute: async (query) => {
          if (query.sql.includes('foreign_key_list') && query.params[0] === 'child') {
            const rows = [
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

            return reverse ? rows.reverse() : rows
          }

          return fixture.execute(query)
        },
      }
    }

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

  it('orders unresolved FK targets with ASCII-case-equivalent identities deterministically', async () => {
    const executor = (reverse: boolean): CatalogExecutor => {
      const fixture = fixtureExecutor({ reverse })
      const rows = [
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
      ]

      return {
        execute: async (query) =>
          query.sql.includes('pragma_foreign_key_list') && query.params[0] === 'child'
            ? reverse
              ? [...rows].reverse()
              : rows
            : fixture.execute(query),
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

  it('preserves unsupported native evidence for rich objects', async () => {
    const result = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const virtual = result.namespaces.items[0]!.relations.items.find(
      (entry) => entry.identity.relation.spelling === 'virt',
    )!
    expect(virtual.kind).toBe('virtualTable')
    expect(virtual.management).toBe('unmanaged')
    expect(virtual.nativeDefinition.state).toBe('present')
  })

  it('rejects attached scopes before version gating', async () => {
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
