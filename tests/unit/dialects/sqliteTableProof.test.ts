import { describe, expect, it } from 'vitest'

import { sqliteIdentity } from '@/dialects/sqlite/identity'
import { proveSqliteTables } from '@/dialects/sqlite/tableProof'
import type {
  IndexInfoRow,
  IndexListRow,
  SqliteProofBatchInput,
  TableRow,
  XInfoRow,
} from '@/dialects/sqlite/tableProof'
import { InvariantError } from '@/utils/error'

const identities = sqliteIdentity.create({
  context: { writableDefault: [{ role: 'database', spelling: 'main' }] },
})

const table = (name: string, ncol = 1): TableRow => ({
  schema: 'main',
  name,
  type: 'table',
  ncol,
  wr: 0,
  strict: 0,
})

const column = (name: string, cid = 0, pk = 0, type = 'INTEGER'): XInfoRow => ({
  cid,
  name,
  type,
  notnull: 0,
  dflt_value: null,
  pk,
  hidden: 0,
})

function fixture(): SqliteProofBatchInput {
  const row = table('t')
  return {
    scopeRows: [row],
    mainTables: [row],
    schemaRows: [
      {
        type: 'table',
        name: 't',
        tbl_name: 't',
        sql: 'CREATE TABLE t(id INTEGER PRIMARY KEY)',
      },
    ],
    evidence: {
      xinfo: new Map([['t', [column('id', 0, 1)]]]),
      indexLists: new Map([['t', []]]),
      indexInfos: new Map(),
      foreignKeys: new Map([['t', []]]),
      errors: new Map(),
    },
    identities,
  }
}

function provedTable(input: SqliteProofBatchInput) {
  const result = proveSqliteTables(input)
  const relation = result.relations[0]!
  expect(relation.table.state).toBe('present')

  if (relation.table.state !== 'present') throw new Error('Expected table facts')

  return { result, relation, facts: relation.table.value }
}

function registerTableProofGroup1() {
  it('should prove an ordinary rowid table, native SQL and valid empty member inventories', () => {
    const { result, relation, facts } = provedTable(fixture())
    expect(result.errors.size).toBe(0)
    expect(relation.management).toBe('managed')

    expect(relation.nativeDefinition).toEqual({
      state: 'present',
      value: 'CREATE TABLE t(id INTEGER PRIMARY KEY)',
    })

    expect(facts.primaryKey).toMatchObject({
      state: 'present',
      value: { columns: ['id'] },
    })

    expect(facts.columns.items[0]).toMatchObject({
      nullable: { state: 'present', value: false },
      generation: {
        state: 'present',
        value: { kind: 'rowidAlias', autoIncrement: false },
      },
    })

    expect(facts.indexes).toEqual({ items: [], coverage: { state: 'complete' } })
    expect(facts.foreignKeys).toEqual({ items: [], coverage: { state: 'complete' } })
  })
}

function registerTableProofGroup2() {
  it('should keep columns and proven rowid facts beside a damaged user index member', () => {
    const input = fixture()
    const index: IndexListRow = {
      seq: 0,
      name: 't_idx',
      origin: 'c',
      unique: 0,
      partial: 0,
    }

    input.evidence.indexLists.set('t', [index])
    input.schemaRows = [
      ...input.schemaRows,
      { type: 'index', name: 't_idx', tbl_name: 't', sql: 'CREATE INDEX t_idx ON t(id)' },
    ]
    const { result, facts } = provedTable(input)
    expect(result.errors.get('t')).toContain('no index_xinfo evidence')
    expect(facts.columns.coverage.state).toBe('complete')

    expect(facts.columns.items[0]!.generation).toMatchObject({
      state: 'present',
      value: { kind: 'rowidAlias' },
    })

    expect(facts.indexes.coverage.state).toBe('unknown')
  })
}

function registerTableProofGroup3() {
  it('should withhold possible rowid facts when index inventory is malformed or missing', () => {
    for (const indexes of [
      [{ seq: 1, name: 'bad', origin: 'u', unique: 1, partial: 0 }],
      undefined,
    ]) {
      const input = fixture()

      if (indexes) input.evidence.indexLists.set('t', indexes)
      else input.evidence.indexLists.delete('t')

      const { result, facts } = provedTable(input)
      expect(result.errors.has('t')).toBe(true)

      expect(facts.columns.items[0]).toMatchObject({
        nullable: { state: 'unknown' },
        generation: { state: 'unknown' },
      })
    }
  })
}

function registerTableProofGroup4() {
  it('should recover options and columns independently under contradictions', () => {
    const columnsBad = fixture()
    columnsBad.scopeRows = [table('t', 2)]
    columnsBad.mainTables = columnsBad.scopeRows
    const badColumns = provedTable(columnsBad)
    expect(badColumns.facts.columns.coverage.state).toBe('unknown')
    expect(badColumns.facts.options).toMatchObject({ coverage: { state: 'complete' } })

    const optionsBad = fixture()
    optionsBad.scopeRows = [{ ...optionsBad.scopeRows[0]!, strict: 1 }]
    optionsBad.mainTables = optionsBad.scopeRows
    const badOptions = provedTable(optionsBad)
    expect(badOptions.result.errors.get('t')).toContain('STRICT')
    expect(badOptions.facts.options.coverage.state).toBe('unknown')
    expect(badOptions.facts.columns.coverage.state).toBe('complete')
  })
}

function registerTableProofGroup5() {
  it('should keep view, virtual and shadow classifications in local proof', () => {
    const input = fixture()
    const view = { ...table('v'), type: 'view' }
    const virtual = { ...table('virt'), type: 'virtual' }
    const shadow = { ...table('shadow'), type: 'shadow' }
    input.scopeRows = [view, virtual, shadow]
    input.mainTables = input.scopeRows
    input.schemaRows = [
      { type: 'view', name: 'v', tbl_name: 'v', sql: 'CREATE VIEW v AS SELECT 1' },
      {
        type: 'table',
        name: 'virt',
        tbl_name: 'virt',
        sql: 'CREATE VIRTUAL TABLE virt USING fts5(value)',
      },
      {
        type: 'table',
        name: 'shadow',
        tbl_name: 'shadow',
        sql: 'CREATE TABLE shadow(value TEXT)',
      },
    ]

    for (const name of ['virt', 'shadow']) {
      input.evidence.xinfo.set(name, [{ ...column('value', 0, 0, 'TEXT'), hidden: 1 }])
      input.evidence.indexLists.set(name, [])
      input.evidence.foreignKeys.set(name, [])
    }

    const result = proveSqliteTables(input)
    expect(result.errors.size).toBe(0)

    expect(
      result.relations.map((relation) => [relation.kind, relation.management]),
    ).toEqual([
      ['shadowTable', 'unmanaged'],
      ['view', 'unmanaged'],
      ['virtualTable', 'unmanaged'],
    ])

    expect(
      result.relations.find((relation) => relation.kind === 'view')?.table.state,
    ).toBe('absent')

    for (const kind of ['virtualTable', 'shadowTable']) {
      const relation = result.relations.find((entry) => entry.kind === kind)!
      expect(relation.table.state).toBe('present')

      if (relation.table.state !== 'present') throw new Error('Expected table facts')

      expect(relation.table.value.columns.items[0]!.generation.state).toBe('unsupported')
    }
  })
}

function registerTableProofGroup6() {
  it('should apply the original single-pass invalid-parent downgrade and retain outside-scope failures', () => {
    const input = fixture()
    const child = table('child', 2)
    input.scopeRows = [child]
    input.mainTables = [input.mainTables[0]!, child]
    input.schemaRows = [
      ...input.schemaRows,
      {
        type: 'table',
        name: 'child',
        tbl_name: 'child',
        sql: 'CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY(parent_id) REFERENCES t(id))',
      },
    ]
    input.evidence.xinfo.set('child', [column('id', 0, 1), column('parent_id', 1)])
    input.evidence.indexLists.set('child', [])

    input.evidence.foreignKeys.set('child', [
      {
        id: 0,
        seq: 0,
        table: 't',
        from: 'parent_id',
        to: 'id',
        on_update: 'NO ACTION',
        on_delete: 'NO ACTION',
        match: 'NONE',
      },
    ])

    input.evidence.errors = new Map([['t', 'parent acquisition failed']])
    const { result, facts } = provedTable(input)
    expect(result.errors.get('t')).toBe('parent acquisition failed')
    expect(result.errors.get('child')).toContain('references invalid parent metadata')
    expect(facts.foreignKeys.coverage.state).toBe('unknown')
    expect(facts.columns.coverage.state).toBe('complete')
  })
}

function registerTableProofGroup7() {
  it.each(['healthy', 'damaged'])(
    'should preserve input observations and failure collections with %s evidence',
    (state) => {
      const input = fixture()

      if (state === 'damaged')
        input.evidence.indexLists.set('t', [
          { seq: 1, name: 'bad', origin: 'u', unique: 1, partial: 0 },
        ])

      const before = structuredClone({ ...input, identities: undefined })
      const result = proveSqliteTables(input)
      expect(result.errors.has('t')).toBe(state === 'damaged')
      expect({ ...input, identities: undefined }).toEqual(before)
    },
  )
}

function registerTableProofGroup8() {
  it('should rethrow unrelated errors, invariant errors and primitive defects by identity', () => {
    for (const defect of [
      new Error('defect'),
      new InvariantError('defect'),
      'primitive defect',
    ]) {
      const input = fixture()
      input.identities = new Proxy(identities, {
        get(target, key) {
          if (key === 'member')
            return () => {
              throw defect
            }

          return Reflect.get(target, key) as unknown
        },
      })
      let thrown: unknown
      try {
        proveSqliteTables(input)
      } catch (error) {
        thrown = error
      }

      expect(thrown).toBe(defect)
    }
  })
}

const member = (name: string, desc = 0): IndexInfoRow => ({
  seqno: 0,
  cid: 1,
  name,
  desc,
  coll: 'BINARY',
  key: 1,
})

function registerTableProofGroup9() {
  it('should prove UNIQUE and rich user-index semantics from native and member evidence', () => {
    const input = fixture()
    input.scopeRows = [table('t', 2)]
    input.mainTables = input.scopeRows
    input.schemaRows = [
      {
        type: 'table',
        name: 't',
        tbl_name: 't',
        sql: 'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT UNIQUE)',
      },
      {
        type: 'index',
        name: 't_desc',
        tbl_name: 't',
        sql: 'CREATE INDEX t_desc ON t(value DESC)',
      },
    ]
    input.evidence.xinfo.set('t', [column('id', 0, 1), column('value', 1, 0, 'TEXT')])

    input.evidence.indexLists.set('t', [
      { seq: 0, name: 't_unique', origin: 'u', unique: 1, partial: 0 },
      { seq: 1, name: 't_desc', origin: 'c', unique: 0, partial: 0 },
    ])

    input.evidence.indexInfos.set('t\0t_unique', [member('value')])
    input.evidence.indexInfos.set('t\0t_desc', [member('value', 1)])
    const { result, relation, facts } = provedTable(input)
    expect(result.errors.size).toBe(0)
    expect(relation.management).toBe('unmanaged')

    expect(facts.uniqueConstraints.items[0]).toMatchObject({
      columns: ['value'],
      semantics: { state: 'present' },
    })

    expect(facts.indexes.items[0]).toMatchObject({
      name: { state: 'present', value: 't_desc' },
      semantics: { state: 'unsupported' },
      nativeDefinition: {
        state: 'present',
        value: 'CREATE INDEX t_desc ON t(value DESC)',
      },
    })
  })
}

function registerTableProofGroup10() {
  it('should keep the first reason when independent observations are damaged', () => {
    const input = fixture()
    input.scopeRows = [{ ...input.scopeRows[0]!, strict: 1 }]
    input.mainTables = input.scopeRows

    input.evidence.indexLists.set('t', [
      { seq: 0, name: 'broken', origin: 'u', unique: 0, partial: 0 },
    ])

    input.evidence.xinfo.set('t', [column('id', 0, 1, 'TEXT')])
    const { result, facts } = provedTable(input)
    expect(result.errors.get('t')).toContain('invalid flags')
    expect(facts.columns.coverage.state).toBe('unknown')
    expect(facts.options.coverage.state).toBe('unknown')
  })
}

function registerTableProofGroup11() {
  it('should keep the same first failing index under reversed decoded inventories', () => {
    const input = fixture()
    const indexes: IndexListRow[] = [
      { seq: 0, name: 'a', origin: 'u', unique: 0, partial: 0 },
      { seq: 1, name: 'b', origin: 'u', unique: 0, partial: 0 },
    ]

    input.evidence.indexLists.set('t', indexes)
    const forward = proveSqliteTables(input)
    input.evidence.indexLists.set('t', [...indexes].reverse())
    const reversed = proveSqliteTables(input)
    expect(forward.errors.get('t')).toBe('SQLite UNIQUE index "a" has invalid flags')
    expect(reversed.errors).toEqual(forward.errors)
    expect(reversed.relations).toEqual(forward.relations)
  })
}

function registerTableProofGroup12() {
  it('should keep the single ordered invalid-parent pass under reversed scope rows', () => {
    const input = fixture()
    const rows = [table('a', 2), table('b', 2), table('c')]
    input.scopeRows = [...rows].reverse()
    input.mainTables = input.scopeRows
    input.schemaRows = rows.map((row) => ({
      type: 'table',
      name: row.name,
      tbl_name: row.name,
      sql:
        row.name === 'c'
          ? 'CREATE TABLE c(id INTEGER PRIMARY KEY)'
          : `CREATE TABLE ${row.name}(id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY(parent_id) REFERENCES ${row.name === 'a' ? 'b' : 'c'}(id))`,
    }))

    for (const row of rows) {
      input.evidence.xinfo.set(
        row.name,
        row.name === 'c'
          ? [column('id', 0, 1)]
          : [column('id', 0, 1), column('parent_id', 1)],
      )

      input.evidence.indexLists.set(row.name, [])

      input.evidence.foreignKeys.set(
        row.name,
        row.name === 'c'
          ? []
          : [
              {
                id: 0,
                seq: 0,
                table: row.name === 'a' ? 'b' : 'c',
                from: 'parent_id',
                to: 'id',
                on_update: 'NO ACTION',
                on_delete: 'NO ACTION',
                match: 'NONE',
              },
            ],
      )
    }

    input.evidence.errors = new Map([['c', 'damaged parent']])
    const reversed = proveSqliteTables(input)
    const forward = proveSqliteTables({ ...input, scopeRows: rows })
    expect(reversed.relations).toEqual(forward.relations)
    expect(reversed.errors).toEqual(forward.errors)
    expect(forward.errors.has('a')).toBe(false)
    expect(forward.errors.get('b')).toContain('references invalid parent metadata')
  })
}

function registerTableProofGroup13() {
  it('should canonicalize relation facts after the ordered parent recovery pass', () => {
    const input = fixture()
    const other = table('a')
    input.scopeRows = [input.scopeRows[0]!, other]
    input.mainTables = input.scopeRows
    input.schemaRows = [
      ...input.schemaRows,
      {
        type: 'table',
        name: 'a',
        tbl_name: 'a',
        sql: 'CREATE TABLE a(id INTEGER PRIMARY KEY)',
      },
    ]
    input.evidence.xinfo.set('a', [column('id', 0, 1)])
    input.evidence.indexLists.set('a', [])
    input.evidence.foreignKeys.set('a', [])
    const forward = proveSqliteTables(input)
    const reversed = proveSqliteTables({
      ...input,
      scopeRows: [...input.scopeRows].reverse(),
    })

    expect(reversed.relations).toEqual(forward.relations)

    expect(
      forward.relations.map((relation) => relation.identity.relation.spelling),
    ).toEqual(['a', 't'])
  })
}

function registerTableProofGroup14() {
  it('should prove a backed WITHOUT ROWID primary key', () => {
    const input = fixture()
    input.scopeRows = [{ ...table('wr'), wr: 1 }]
    input.mainTables = input.scopeRows
    input.schemaRows = [
      {
        type: 'table',
        name: 'wr',
        tbl_name: 'wr',
        sql: 'CREATE TABLE wr(id TEXT PRIMARY KEY) WITHOUT ROWID',
      },
    ]
    input.evidence.xinfo.set('wr', [{ ...column('id', 0, 1, 'TEXT'), notnull: 1 }])

    input.evidence.indexLists.set('wr', [
      { seq: 0, name: 'wr_auto', origin: 'pk', unique: 1, partial: 0 },
    ])

    input.evidence.indexInfos.set('wr\0wr_auto', [
      { seqno: 0, cid: 0, name: 'id', desc: 0, coll: 'BINARY', key: 1 },
    ])

    input.evidence.foreignKeys.set('wr', [])
    const { result, relation, facts } = provedTable(input)
    expect(result.errors.size).toBe(0)
    expect(relation.management).toBe('unmanaged')

    expect(facts.primaryKey).toMatchObject({
      state: 'present',
      value: { columns: ['id'], semantics: { state: 'present' } },
    })

    expect(facts.options.items).toEqual([
      { name: 'strict', value: 'false' },
      { name: 'withoutRowid', value: 'true' },
    ])
  })
}

function registerTableProofGroup15() {
  it('should keep a proven STRICT table unmanaged with retained options', () => {
    const input = fixture()
    input.scopeRows = [{ ...table('strict_t'), strict: 1 }]
    input.mainTables = input.scopeRows
    input.schemaRows = [
      {
        type: 'table',
        name: 'strict_t',
        tbl_name: 'strict_t',
        sql: 'CREATE TABLE strict_t(id INTEGER) STRICT',
      },
    ]
    input.evidence.xinfo.set('strict_t', [column('id')])
    input.evidence.indexLists.set('strict_t', [])
    input.evidence.foreignKeys.set('strict_t', [])
    const { result, relation, facts } = provedTable(input)
    expect(result.errors.size).toBe(0)
    expect(relation.management).toBe('unmanaged')

    expect(facts.options.items).toEqual([
      { name: 'strict', value: 'true' },
      { name: 'withoutRowid', value: 'false' },
    ])
  })
}

function registerTableProofGroup16() {
  it.each([
    { title: 'explicit', target: 'id', suffix: '(id)' },
    { title: 'implicit', target: null, suffix: '' },
  ])(
    'should prove an $title foreign-key target against the parent primary key',
    ({ target, suffix }) => {
      const input = fixture()
      const child = table('child', 2)
      input.scopeRows = [child]
      input.mainTables = [input.mainTables[0]!, child]
      input.schemaRows = [
        ...input.schemaRows,
        {
          type: 'table',
          name: 'child',
          tbl_name: 'child',
          sql: `CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY(parent_id) REFERENCES t${suffix})`,
        },
      ]
      input.evidence.xinfo.set('child', [column('id', 0, 1), column('parent_id', 1)])
      input.evidence.indexLists.set('child', [])

      input.evidence.foreignKeys.set('child', [
        {
          id: 0,
          seq: 0,
          table: 't',
          from: 'parent_id',
          to: target,
          on_update: 'NO ACTION',
          on_delete: 'NO ACTION',
          match: 'NONE',
        },
      ])

      const { result, relation, facts } = provedTable(input)
      expect(result.errors.size).toBe(0)
      expect(relation.management).toBe('managed')

      expect(facts.foreignKeys.items[0]).toMatchObject({
        columns: ['parent_id'],
        referencedColumns: ['id'],
        validity: { state: 'present', value: 'valid' },
      })
    },
  )
}

function registerTableProofGroup17() {
  it('should retain unsupported table clauses as opaque native evidence', () => {
    const input = fixture()
    input.scopeRows = [table('t', 2)]
    input.mainTables = input.scopeRows
    const sql =
      'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT COLLATE NOCASE, CHECK (value IS NOT NULL))'

    input.schemaRows = [{ type: 'table', name: 't', tbl_name: 't', sql }]
    input.evidence.xinfo.set('t', [column('id', 0, 1), column('value', 1, 0, 'TEXT')])
    const { result, relation, facts } = provedTable(input)
    expect(result.errors.size).toBe(0)
    expect(relation.management).toBe('unmanaged')
    expect(relation.nativeDefinition).toEqual({ state: 'present', value: sql })

    expect(facts.opaqueObjects.items.map((entry) => entry.reason)).toEqual([
      'SQLite CHECK constraint is preserved as opaque table SQL',
      'SQLite table clauses are not fully represented: COLLATE',
    ])
  })
}

function registerTableProofGroup18() {
  it('should keep index failure precedence and column recovery under reversed member arrays', () => {
    const input = fixture()
    input.scopeRows = [table('t', 2)]
    input.mainTables = input.scopeRows
    input.schemaRows = [
      {
        type: 'table',
        name: 't',
        tbl_name: 't',
        sql: 'CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT)',
      },
      {
        type: 'index',
        name: 't_idx',
        tbl_name: 't',
        sql: 'CREATE INDEX t_idx ON t(value)',
      },
    ]
    input.evidence.xinfo.set('t', [column('id', 0, 1), column('value', 1, 0, 'INTEGER')])

    input.evidence.indexLists.set('t', [
      { seq: 0, name: 't_idx', origin: 'c', unique: 0, partial: 0 },
    ])

    input.evidence.indexInfos.set('t\0t_idx', [
      { seqno: 2, cid: 1, name: 'value', desc: 0, coll: 'BINARY', key: 1 },
      { seqno: 0, cid: 0, name: 'id', desc: 0, coll: 'BINARY', key: 1 },
    ])

    const forward = proveSqliteTables(input)
    const reversed = proveSqliteTables({
      ...input,
      evidence: {
        ...input.evidence,
        xinfo: new Map([['t', [...input.evidence.xinfo.get('t')!].reverse()]]),
        indexInfos: new Map([
          ['t\0t_idx', [...input.evidence.indexInfos.get('t\0t_idx')!].reverse()],
        ]),
      },
    })

    expect(forward.errors.get('t')).toContain('non-contiguous index_xinfo seqnos')
    expect(reversed.errors).toEqual(forward.errors)
    expect(reversed.relations).toEqual(forward.relations)
    const facts = forward.relations[0]!.table
    expect(facts.state).toBe('present')

    if (facts.state !== 'present') throw new Error('Expected table facts')

    expect(facts.value.columns.coverage.state).toBe('unknown')
  })
}

describe('SQLite table proof', () => {
  registerTableProofGroup1()
  registerTableProofGroup2()
  registerTableProofGroup3()
  registerTableProofGroup4()
  registerTableProofGroup5()
  registerTableProofGroup6()
  registerTableProofGroup7()
  registerTableProofGroup8()
  registerTableProofGroup9()
  registerTableProofGroup10()
  registerTableProofGroup11()
  registerTableProofGroup12()
  registerTableProofGroup13()
  registerTableProofGroup14()
  registerTableProofGroup15()
  registerTableProofGroup16()
  registerTableProofGroup17()
  registerTableProofGroup18()
})
