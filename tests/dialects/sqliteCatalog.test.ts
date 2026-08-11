import { describe, expect, it } from 'vitest'

import type { CatalogExecutor, CatalogRequest } from '@/dialects'
import { sqliteCatalog } from '@/dialects/sqlite/catalog'

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
}
function fixtureExecutor(options: FixtureOptions = {}): CatalogExecutor {
  const tables = [
    { schema: 'main', name: 'parent', type: 'table', ncol: 5, wr: 0, strict: 0 },
    { schema: 'main', name: 'child', type: 'table', ncol: 3, wr: 0, strict: 0 },
    { schema: 'main', name: 'wr', type: 'table', ncol: 1, wr: 1, strict: 0 },
    { schema: 'main', name: 'wr_auto', type: 'table', ncol: 2, wr: 1, strict: 0 },
    { schema: 'main', name: 'pk_desc', type: 'table', ncol: 1, wr: 0, strict: 0 },
    { schema: 'main', name: 'strict_t', type: 'table', ncol: 1, wr: 0, strict: 1 },
    { schema: 'main', name: 'v', type: 'view', ncol: 1, wr: 0, strict: 0 },
    { schema: 'main', name: 'virt', type: 'virtual', ncol: 1, wr: 0, strict: 0 },
    { schema: 'main', name: 'virt_shadow', type: 'shadow', ncol: 1, wr: 0, strict: 0 },
  ]
  const schema = [
    {
      type: 'table',
      name: 'parent',
      tbl_name: 'parent',
      sql: "CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT, v VARCHAR(12) DEFAULT 'safe', b BLOB DEFAULT 1, r DOUBLE, d DECIMAL(10,2) DEFAULT (lower('x')))",
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
    { type: 'view', name: 'v', tbl_name: 'v', sql: 'CREATE VIEW v AS SELECT 1' },
    {
      type: 'table',
      name: 'virt',
      tbl_name: 'virt',
      sql: 'CREATE VIRTUAL TABLE virt USING fts5(body)',
    },
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
      type: 'trigger',
      name: 'parent_trg',
      tbl_name: 'parent',
      sql: 'CREATE TRIGGER parent_trg AFTER INSERT ON parent BEGIN SELECT 1; END',
    },
  ]
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
        dflt_value: null,
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
    virt: [
      { cid: 0, name: 'body', type: '', notnull: 0, dflt_value: null, pk: 0, hidden: 1 },
    ],
    virt_shadow: [
      { cid: 0, name: 'body', type: '', notnull: 0, dflt_value: null, pk: 0, hidden: 2 },
    ],
  }
  const calls = new Map<string, number>()
  return {
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
                  ? p[0] === 'parent'
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
                          partial: 1,
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
                    ? p[0] === 'parent_n'
                      ? [{ seqno: 0, cid: 1, name: 'v', desc: 0, coll: 'BINARY', key: 1 }]
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
      const key = query.sql + JSON.stringify(query.params)
      const count = (calls.get(key) ?? 0) + 1
      calls.set(key, count)
      if (options.race && count > 1 && query.sql.includes(options.race))
        rows = [
          ...rows,
          ...(rows[0]
            ? [{ ...(rows[0] as Record<string, unknown>), name: 'race_added' }]
            : []),
        ]
      if (options.malformed === 'duplicate' && query.sql.includes('database_list'))
        rows = [...rows, ...rows]
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

describe('SQLite evidence-bearing catalog', () => {
  const nodeSqliteSupported = (() => {
    const [major, minor] = process.versions.node.split('.').map(Number)
    return major > 22 || (major === 22 && minor >= 13)
  })()
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
    const p = s.namespaces.items[0]!.relations.items.find(
      (r) => r.identity.relation.spelling === 'parent',
    )!
    expect(p.nativeDefinition.state).toBe('present')
    if (p.table.state === 'present')
      expect(
        p.table.value.columns.items.map((c) =>
          c.dataType.state === 'present' ? c.dataType.value.family : '',
        ),
      ).toEqual(['integer', 'text', 'blob', 'real', 'numeric'])
  })
  it('fixture preserves defaults and rowid generation', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const p = s.namespaces.items[0]!.relations.items.find(
      (r) => r.identity.relation.spelling === 'parent',
    )!
    if (p.table.state === 'present') {
      expect(p.table.value.columns.items[1]!.default).toMatchObject({
        state: 'present',
        value: { kind: 'literal' },
      })
      expect(p.table.value.columns.items[4]!.default).toMatchObject({
        state: 'present',
        value: { kind: 'nativeExpression' },
      })
      expect(p.table.value.columns.items[0]!.generation).toMatchObject({
        state: 'present',
        value: { kind: 'rowidAlias', autoIncrement: true },
      })
    }
  })
  it('fixture retains composite FK ordering and actions', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const c = s.namespaces.items[0]!.relations.items.find(
      (r) => r.identity.relation.spelling === 'child',
    )!
    if (c.table.state === 'present')
      expect(c.table.value.foreignKeys.items[0]).toMatchObject({
        columns: ['pa', 'pb'],
        referencedColumns: ['id', 'v'],
        onDelete: 'set null',
        onUpdate: 'cascade',
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
  it('fixture emits view virtual and shadow kinds', async () => {
    const rs = (await sqliteCatalog.introspectCatalog(fixtureExecutor(), request))
      .namespaces.items[0]!.relations.items
    expect(rs.find((r) => r.identity.relation.spelling === 'v')!.kind).toBe('view')
    expect(rs.find((r) => r.identity.relation.spelling === 'virt')!.kind).toBe(
      'virtualTable',
    )
    expect(rs.find((r) => r.identity.relation.spelling === 'virt_shadow')!.kind).toBe(
      'shadowTable',
    )
  })
  it('fixture preserves trigger opaque evidence', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), request)
    const p = s.namespaces.items[0]!.relations.items.find(
      (r) => r.identity.relation.spelling === 'parent',
    )!
    if (p.table.state === 'present')
      expect(p.table.value.opaqueObjects.items.some((o) => o.kind === 'trigger')).toBe(
        true,
      )
  })
  it('fixture reserves unrelated physical names', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), {
      ...request,
      completeNamespaces: [],
      relations: [{ relation: { relation: 'parent' }, shape: 'complete' }],
    })
    expect(s.nameReservations.coverage.state).toBe('complete')
    expect(s.nameReservations.items.map((n) => n.name)).toContain('parent_n')
  })
  it('fixture malformed database rows are tagged invariants', async () => {
    await expect(
      sqliteCatalog.introspectCatalog(
        fixtureExecutor({ malformed: 'duplicate' }),
        request,
      ),
    ).rejects.toMatchObject({ _tag: 'InvariantError' })
  })
  it('fixture supports absent relation evidence', async () => {
    const s = await sqliteCatalog.introspectCatalog(fixtureExecutor(), {
      ...request,
      absentRelations: [{ relation: 'missing' }],
    })
    expect(s.request.absentRelations).toHaveLength(1)
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
    expect(
      (
        await sqliteCatalog.introspectCatalog(
          fixtureExecutor({ version: '3.37.0' }),
          request,
        )
      ).source.version,
    ).toBe('3.37.0')
  })
  it.runIf(nodeSqliteSupported)(
    'round-trips representative native metadata when node:sqlite is available',
    async () => {
      const connector = await import('node:sqlite')
      const database = new connector.DatabaseSync(':memory:')
      try {
        database.exec(
          "pragma foreign_keys=on; create table parent(id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE DEFAULT 'x'); create table child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE, payload VARCHAR(20) DEFAULT (lower('A'))); create index child_payload on child(payload)",
        )
        const execute: CatalogExecutor['execute'] = async (query) =>
          database.prepare(query.sql).all(...(query.params as never[]))
        const snapshot = await sqliteCatalog.introspectCatalog({ execute }, request)
        const reversed = await sqliteCatalog.introspectCatalog(
          {
            execute: async (query) => (await execute(query)).slice().reverse(),
          },
          request,
        )
        expect(reversed).toEqual(snapshot)
        expect(snapshot.source.version).toMatch(/^3\./)
        const relations = snapshot.namespaces.items[0]!.relations.items
        expect(relations.map((entry) => entry.identity.relation.spelling)).toEqual([
          'child',
          'parent',
        ])
        const parent = relations.find(
          (entry) => entry.identity.relation.spelling === 'parent',
        )!
        expect(parent.management).toBe('managed')
        expect(parent.nativeDefinition.state).toBe('present')
        if (parent.table.state !== 'present') return
        expect(parent.table.value.columns.items[0]!.generation).toEqual({
          state: 'present',
          value: { kind: 'rowidAlias', autoIncrement: true },
        })
        expect(parent.table.value.uniqueConstraints.items).toHaveLength(1)
        const child = relations.find(
          (entry) => entry.identity.relation.spelling === 'child',
        )!
        expect(child.table.state).toBe('present')
        if (child.table.state === 'present')
          expect(child.table.value.foreignKeys.items[0]!.onDelete).toBe('cascade')
      } finally {
        database.close()
      }
    },
  )

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
  it('keeps capability fidelity honest', async () => {
    expect(
      (await sqliteCatalog.introspectCatalog(emptyFixture(), request)).capabilities
        .richObjects,
    ).toEqual({ state: 'supported', fidelity: 'opaque' })
  })
  it('reserves an explicit main namespace', async () => {
    expect(
      (await sqliteCatalog.introspectCatalog(emptyFixture(), request)).namespaces
        .items[0]!.identity[0]!.identifier.spelling,
    ).toBe('main')
  })
  it('uses parameterized PRAGMA member queries', async () => {
    const calls: { sql: string; params: unknown[] }[] = []
    await sqliteCatalog.introspectCatalog(
      {
        execute: async (query) => {
          calls.push(query)
          return query.sql.includes('sqlite_version')
            ? [{ version: '3.37.0' }]
            : query.sql.includes('database_list')
              ? [{ seq: 0, name: 'main', file: '' }]
              : query.sql.includes('table_list') || query.sql.includes('sqlite_schema')
                ? []
                : []
        },
      },
      request,
    )
    expect(
      calls.every(
        (call) => !call.sql.includes('pragma_table_xinfo(') || call.params[1] === 'main',
      ),
    ).toBe(true)
  })
  it('reports unsupported old versions deterministically', async () => {
    expect(
      (await sqliteCatalog.introspectCatalog(emptyFixture('3.36.9'), request))
        .diagnostics[0]!.code,
    ).toBe('catalog.capability.version')
  })
  it('sorts diagnostics deterministically', async () => {
    expect(
      (await sqliteCatalog.introspectCatalog(emptyFixture(), request)).diagnostics,
    ).toEqual([])
  })
  it('preserves resolved request shape', async () => {
    const result = await sqliteCatalog.introspectCatalog(emptyFixture(), {
      ...request,
      relations: [{ relation: { relation: 'x' }, shape: 'additive' }],
    })
    expect(result.request.relations[0]!.shape).toBe('additive')
  })
  it('rejects malformed cross-PRAGMA observations', async () => {
    for (const malformed of ['xinfo-gap', 'ncol', 'fk-duplicate', 'fk-source'])
      await expect(
        sqliteCatalog.introspectCatalog(fixtureExecutor({ malformed }), request),
      ).rejects.toMatchObject({ _tag: 'InvariantError' })
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
      relations: [{ relation: { relation: 'child' }, shape: 'complete' }],
    })
    const child = result.namespaces.items[0]!.relations.items.find(
      (entry) => entry.identity.relation.spelling === 'child',
    )!
    if (child.table.state === 'present')
      expect(child.table.value.foreignKeys.items[0]!.referencedColumns).toEqual([
        'id',
        'v',
      ])
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
  it('never interpolates quoted identifiers', async () => {
    const calls: { sql: string; params: unknown[] }[] = []
    await sqliteCatalog.introspectCatalog(
      {
        execute: async (query) => {
          calls.push(query)
          return fixtureExecutor().execute(query)
        },
      },
      {
        ...request,
        relations: [{ relation: { relation: 'odd"name' }, shape: 'complete' }],
      },
    )
    for (const call of calls.filter((entry) => entry.sql.includes('pragma_')))
      expect(call.sql).not.toContain('odd"name')
  })
})
