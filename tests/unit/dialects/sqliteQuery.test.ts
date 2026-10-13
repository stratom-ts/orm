import { number, pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { compileSqlite } from '@/dialects/sqlite/compile'
import { sqliteQuery } from '@/dialects/sqlite/query'
import { column, defineTable } from '@/index'
import { InvariantError, QueryError } from '@/utils/error'

const Records = defineTable(
  'Records',
  {
    id: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })),
    label: string(),
  },
  { primaryKey: 'id' },
)

const Events = defineTable(
  'events',
  {
    id: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })),
    recordId: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })),
  },
  { primaryKey: 'id' },
)

const main = [{ role: 'database' as const, spelling: 'main' }]
const records = { relation: 'records' } as const
const events = { relation: 'events' } as const

it('rejects registered wildcard joins whose output names collide', () => {
  const resolved = sqliteQuery.resolve([Records, Events])
  expect(() =>
    resolved.compile({
      kind: 'select',
      relation: records,
      selection: [{ kind: 'all' }],
      joins: [
        {
          type: 'left',
          relation: events,
          on: {
            kind: 'cmp',
            relation: records,
            column: 'id',
            op: 'eq',
            right: { relation: events, column: 'recordId' },
          },
        },
      ],
    }),
  ).toThrow('SQLite query output columns are ambiguous')
})

it('expands a relation-scoped wildcard join using authored names and preserves output aliases', () => {
  const resolved = sqliteQuery.resolve([Records, Events])
  expect(
    resolved.compile({
      kind: 'select',
      relation: records,
      selection: [
        { kind: 'all', relation: records },
        { kind: 'column', relation: events, column: 'id', alias: 'eventId' },
      ],
      joins: [
        {
          type: 'left',
          relation: events,
          on: {
            kind: 'cmp',
            relation: records,
            column: 'id',
            op: 'eq',
            right: { relation: events, column: 'recordId' },
          },
        },
      ],
    }),
  ).toEqual({
    sql: 'select "main.records"."id" as "id", "main.records"."label" as "label", "main.events"."id" as "eventId" from "main"."records" as "main.records" left join "main"."events" as "main.events" on "main.records"."id" = "main.events"."recordId"',
    params: [],
  })
})

describe('SQLite query facet', () => {
  it('shares main-defaulted ASCII-insensitive relation and member lookup with compilation', () => {
    const resolved = sqliteQuery.resolve([Records, Events], { registrationDefault: main })

    expect(resolved.findRelationMatches(records)).toEqual([Records])
    expect(resolved.findColumnMatches(Records, 'ID')).toEqual(['id'])

    expect(
      resolved.compile({
        kind: 'select',
        relation: records,
        selection: [{ kind: 'column', relation: records, column: 'id' }],
        where: { kind: 'cmp', relation: records, column: 'id', op: 'eq', value: 7 },
        offset: 3,
      }),
    ).toEqual({
      sql: 'select "main.records"."id" as "id" from "main"."records" as "main.records" where "main.records"."id" = ? limit -1 offset ?',
      params: [7, 3],
    })
  })

  it('compiles an empty selection as select-all', () => {
    expect(compileSqlite({ kind: 'select', relation: records, selection: [] })).toEqual({
      sql: 'select * from "main"."records" as "main.records"',
      params: [],
    })
  })
})

describe('SQLite query facet: compiles supported joins and write forms with anonymous placeholders', () => {
  it('compiles supported joins and write forms with anonymous placeholders', () => {
    assertSqliteJoin()

    assertSqliteInserts()

    expect(
      compileSqlite({
        kind: 'update',
        relation: records,
        set: [
          { column: 'label', value: 'updated' },
          { column: 'id', value: 2 },
        ],
        where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
        allowAll: false,
        returning: { kind: 'all' },
      }),
    ).toEqual({
      sql: 'update "main"."records" as "main.records" set "label" = ?, "id" = ? where "id" = ? returning *',
      params: ['updated', 2, 1],
    })

    expect(
      compileSqlite({
        kind: 'delete',
        relation: records,
        where: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
        allowAll: false,
        returning: { kind: 'columns', columns: ['id'] },
      }),
    ).toEqual({
      sql: 'delete from "main"."records" as "main.records" where "id" = ? returning "id" as "id"',
      params: [1],
    })
  })
})

describe('SQLite query validation', () => {
  it('rejects unsupported SQLite 3.37 forms synchronously', () => {
    assertUnsupportedSqliteJoinAndDateFunctions()

    /**
     * Compiles an undefined SQLite insert value to exercise unsupported-default
     * rejection.
     */
    const insertDefault = () =>
      compileSqlite({
        kind: 'insert',
        relation: records,
        columns: ['id'],
        values: [[undefined]],
      })

    expect(insertDefault).toThrow(QueryError)
    expect(insertDefault).toThrow(/DEFAULT as an individual VALUES/i)

    /**
     * Resolves a query with an attached-database registration default to exercise
     * rejection.
     */
    const invalidDefault = () =>
      sqliteQuery.resolve([Records], {
        registrationDefault: [{ role: 'database', spelling: 'archive' }],
      })

    expect(invalidDefault).toThrow(QueryError)
    expect(invalidDefault).toThrow(/database:main/i)

    /** Compiles an attached SQLite relation to exercise namespace rejection. */
    const attachedRelation = () =>
      compileSqlite({
        kind: 'select',
        relation: {
          namespace: [{ role: 'database', spelling: 'archive' }],
          relation: 'records',
        },
        selection: [],
      })

    expect(attachedRelation).toThrow(QueryError)
    expect(attachedRelation).toThrow(/database:main/i)
  })
})

describe('SQLite query validation: requires an explicit full-table opt-in for empty boolean predicate groups', () => {
  it('requires an explicit full-table opt-in for empty boolean predicate groups', () => {
    /** Starts an update operation for a registered table handle. */
    const update = () =>
      compileSqlite({
        kind: 'update',
        relation: records,
        set: [{ column: 'label', value: 'updated' }],
        where: { kind: 'and', preds: [] },
        allowAll: false,
      })

    /** Compiles an empty nested delete predicate to exercise write-safety rejection. */
    const nestedDelete = () =>
      compileSqlite({
        kind: 'delete',
        relation: records,
        where: { kind: 'not', pred: { kind: 'or', preds: [] } },
        allowAll: false,
      })

    expect(update).toThrow(InvariantError)
    expect(update).toThrow(/predicate must not be empty/i)
    expect(nestedDelete).toThrow(InvariantError)
    expect(nestedDelete).toThrow(/predicate must not be empty/i)
  })
})

describe('SQLite query validation: requires allowAll for writes without a predicate', () => {
  it('requires allowAll for writes without a predicate', () => {
    /** Compiles an unrestricted update to exercise write-safety rejection. */
    const blockedUpdate = () =>
      compileSqlite({
        kind: 'update',
        relation: records,
        set: [{ column: 'label', value: 'updated' }],
        allowAll: false,
      })

    /** Compiles an unrestricted delete to exercise write-safety rejection. */
    const blockedDelete = () =>
      compileSqlite({ kind: 'delete', relation: records, allowAll: false })

    expect(blockedUpdate).toThrow(QueryError)
    expect(blockedUpdate).toThrow(/full-table update requires allowAll/i)
    expect(blockedDelete).toThrow(QueryError)
    expect(blockedDelete).toThrow(/full-table delete requires allowAll/i)

    expect(
      compileSqlite({
        kind: 'update',
        relation: records,
        set: [{ column: 'label', value: 'updated' }],
        allowAll: true,
      }),
    ).toEqual({
      sql: 'update "main"."records" as "main.records" set "label" = ?',
      params: ['updated'],
    })

    expect(compileSqlite({ kind: 'delete', relation: records, allowAll: true })).toEqual({
      sql: 'delete from "main"."records" as "main.records"',
      params: [],
    })
  })
})

/** Checks unsupported sqlite join and date functions in the current test scenario. */
function assertUnsupportedSqliteJoinAndDateFunctions() {
  /** Adds a right join and its ON predicate to the current query. */
  const rightJoin = () =>
    compileSqlite({
      kind: 'select',
      relation: records,
      selection: [{ kind: 'all' }],
      joins: [
        {
          type: 'right',
          relation: events,
          on: { kind: 'cmp', column: 'id', op: 'eq', value: 1 },
        },
      ],
    })

  expect(rightJoin).toThrow(QueryError)
  expect(rightJoin).toThrow(/right joins/i)

  /**
   * Compiles PostgreSQL date truncation through SQLite to exercise unsupported-expression
   * rejection.
   */
  const dateTrunc = () =>
    compileSqlite({
      kind: 'select',
      relation: records,
      selection: [
        {
          kind: 'expr',
          alias: 'bucket',
          expr: {
            kind: 'date_trunc',
            unit: 'day',
            arg: { kind: 'column', column: 'id' },
          },
        },
      ],
    })

  expect(dateTrunc).toThrow(QueryError)
  expect(dateTrunc).toThrow(/date_trunc/i)
}

/**
 * Checks SQLite insert placeholders, parameter order, returning clauses, and DEFAULT
 * VALUES.
 */
function assertSqliteInserts() {
  expect(
    compileSqlite({
      kind: 'insert',
      relation: records,
      columns: ['id', 'label'],
      values: [
        [1, 'first'],
        [2, 'second'],
      ],
      returning: { kind: 'columns', columns: ['id'] },
    }),
  ).toEqual({
    sql: 'insert into "main"."records" ("id", "label") values (?, ?), (?, ?) returning "id" as "id"',
    params: [1, 'first', 2, 'second'],
  })

  expect(
    compileSqlite({
      kind: 'insert',
      relation: records,
      columns: [],
      values: [[]],
    }),
  ).toEqual({ sql: 'insert into "main"."records" default values', params: [] })
}

/** Checks SQLite join qualification, aliases, and result-column selection. */
function assertSqliteJoin() {
  expect(
    compileSqlite({
      kind: 'select',
      relation: records,
      selection: [
        { kind: 'column', relation: records, column: 'id' },
        { kind: 'column', relation: events, column: 'id', alias: 'eventId' },
      ],
      joins: [
        {
          type: 'left',
          relation: events,
          on: {
            kind: 'cmp',
            relation: records,
            column: 'id',
            op: 'eq',
            right: { relation: events, column: 'recordId' },
          },
        },
      ],
    }),
  ).toEqual({
    sql: 'select "main.records"."id" as "id", "main.events"."id" as "eventId" from "main"."records" as "main.records" left join "main"."events" as "main.events" on "main.records"."id" = "main.events"."recordId"',
    params: [],
  })
}
