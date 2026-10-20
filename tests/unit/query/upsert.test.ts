import { number, optional, pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { compilePostgresQuery } from '@/dialects/postgres/compile'
import { compileSqliteQuery } from '@/dialects/sqlite/compile'
import type { Dialect, InsertAst } from '@/index'
import {
  QueryError,
  ValidationError,
  column,
  createDatabase,
  defineTable,
  excluded,
  postgresDialect,
} from '@/index'
import { createInsertBuilder } from '@/query'

import { createMockPostgresConnector } from '../helpers/nativePostgresClient'

const Records = defineTable(
  'upsert_records',
  {
    id: pipe(number(), column({ generation: { kind: 'identity', mode: 'byDefault' } })),
    tenant: string(),
    externalId: string(),
    email: pipe(string(), column({ unique: true })),
    name: pipe(string(), column({ mapParam: (value) => `mapped:${String(value)}` })),
    locked: optional(
      pipe(
        string(),
        column({
          readonly: true,
          databaseDefault: { kind: 'literal', value: 'locked' },
        }),
      ),
    ),
    generated: pipe(
      string(),
      column({
        generation: {
          kind: 'computed',
          expression: { kind: 'portableExpression', expression: 'currentDate' },
          storage: 'stored',
        },
      }),
    ),
  },
  {
    primaryKey: 'id',
    indexes: [
      { columns: ['tenant', 'externalId'], unique: true },
      { columns: ['tenant'] },
    ],
  },
)

const ForeignRecords = defineTable(
  'foreign_upsert_records',
  { id: number(), name: string() },
  { primaryKey: 'id' },
)

const CompositePrimaryRecords = defineTable(
  'composite_primary_upsert_records',
  { tenant: string(), key: string(), value: string() },
  { primaryKey: ['tenant', 'key'] },
)

const row = {
  tenant: 'tenant-a',
  externalId: 'external-a',
  email: 'a@example.test',
  name: 'first',
}

describe('insert upsert builder compilation', () => {
  it('compiles candidate-key conflict actions before returning with stable parameters', async () => {
    const db = createDatabase({
      connector: createMockPostgresConnector(),
      schemas: [Records],
    })

    const doNothing = db
      .insert(Records)
      .values(row)
      .onConflict([Records.tenant, Records.externalId])

    expect(doNothing).not.toHaveProperty('compile')

    const ignored = doNothing.doNothing().compile()

    expect(ignored.sql).toContain(
      'on conflict ("tenant", "externalId") do nothing returning *',
    )

    expect(ignored.params).toEqual([
      'tenant-a',
      'external-a',
      'a@example.test',
      'mapped:first',
    ])

    const updated = db
      .insert(Records)
      .values([row, { ...row, externalId: 'external-b' }])
      .onConflict([Records.email])
      .doUpdate({ name: 'replacement', email: excluded(Records.email) })
      .returning([Records.id, Records.name])
      .compile()

    expect(updated.sql).toContain(
      'on conflict ("email") do update set "name" = $9, "email" = excluded."email" returning "id", "name"',
    )

    expect(updated.params).toEqual([
      'tenant-a',
      'external-a',
      'a@example.test',
      'mapped:first',
      'tenant-a',
      'external-b',
      'a@example.test',
      'mapped:first',
      'mapped:replacement',
    ])

    expect(
      db.insert(Records).values(row).onConflict([Records.id]).doNothing().compile().sql,
    ).toContain('on conflict ("id") do nothing')

    await db.close()
  })
})

describe('insert upsert target validation', () => {
  it('rejects targets that are not exact authored candidate keys', async () => {
    const db = createDatabase({
      connector: createMockPostgresConnector(),
      schemas: [Records, ForeignRecords],
    })

    const insert = db.insert(Records).values(row)

    expect(() => insert.onConflict([] as never)).toThrow(/at least one column/i)

    expect(() => insert.onConflict([Records.tenant, Records.tenant])).toThrow(
      /duplicate/i,
    )

    expect(() => insert.onConflict([Records.externalId, Records.tenant])).toThrow(
      /candidate key/i,
    )

    expect(() => insert.onConflict([Records.tenant])).toThrow(/candidate key/i)

    expect(() => insert.onConflict(['missing'] as never)).toThrow(/unknown/i)

    expect(() => insert.onConflict([ForeignRecords.id] as never)).toThrow(/foreign/i)

    await db.close()
  })

  it('accepts a composite primary key only in authored order', async () => {
    const db = createDatabase({
      connector: createMockPostgresConnector(),
      schemas: [CompositePrimaryRecords],
    })

    const insert = db
      .insert(CompositePrimaryRecords)
      .values({ tenant: 'a', key: 'one', value: 'first' })

    expect(
      insert
        .onConflict([CompositePrimaryRecords.tenant, CompositePrimaryRecords.key])
        .doNothing()
        .compile().sql,
    ).toContain('on conflict ("tenant", "key") do nothing')

    expect(() =>
      insert.onConflict([CompositePrimaryRecords.key, CompositePrimaryRecords.tenant]),
    ).toThrow(/candidate key.*order/i)

    await db.close()
  })
})

describe('insert upsert update validation', () => {
  it('applies update writable rules and validates excluded column ownership', async () => {
    const db = createDatabase({
      connector: createMockPostgresConnector(),
      schemas: [Records, ForeignRecords],
    })

    const conflict = db.insert(Records).values(row).onConflict([Records.email])

    const assertExcludedTypes = () => {
      conflict.doUpdate({ name: excluded(Records.email) })

      // @ts-expect-error A numeric excluded source cannot update a string column.
      conflict.doUpdate({ name: excluded(Records.id) })
    }

    void assertExcludedTypes

    expect(() => conflict.doUpdate({})).toThrow(ValidationError)

    expect(() => conflict.doUpdate({ name: 1 } as never)).toThrow(ValidationError)

    expect(() => conflict.doUpdate({ locked: 'changed' } as never)).toThrow(
      /non-updatable/i,
    )

    expect(() => conflict.doUpdate({ generated: 'changed' } as never)).toThrow(
      /non-updatable/i,
    )

    expect(() => conflict.doUpdate({ missing: 'changed' } as never)).toThrow(
      /unknown|non-updatable/i,
    )

    expect(() =>
      conflict.doUpdate({ name: excluded(ForeignRecords.name) } as never),
    ).toThrow(QueryError)

    expect(() =>
      conflict.doUpdate({ name: excluded(Records.generated) } as never),
    ).toThrow(/insertable column/i)

    await db.close()
  })
})

describe('insert upsert structured AST', () => {
  it('passes a structured target and action through the shared builder seam', () => {
    let compiledAst: InsertAst | undefined
    const resolvedQuery = postgresDialect.query.resolve([Records])
    const dialect: Dialect = {
      ...postgresDialect,
      query: {
        ...postgresDialect.query,
        resolve: () => ({
          ...resolvedQuery,
          compile(node) {
            compiledAst = node as InsertAst
            return { sql: 'captured insert', params: [] }
          },
        }),
      },
    }

    createInsertBuilder({
      handle: Records,
      dialect,
      executor: {
        execute: async () => [],
        run: async () => undefined,
      },
      rows: [row],
    })
      .onConflict([Records.email])
      .doUpdate({ name: excluded(Records.email), id: 42 })
      .compile()

    expect(compiledAst?.conflict).toEqual({
      target: ['email'],
      action: {
        kind: 'doUpdate',
        set: [
          { column: 'name', value: { kind: 'excluded', column: 'email' } },
          { column: 'id', value: { kind: 'value', value: 42 } },
        ],
      },
    })

    expect(compiledAst?.conflict).not.toHaveProperty('sql')
  })
})

describe('SQLite insert upsert compilation', () => {
  it('quotes excluded columns and appends literal patch parameters after insert values', () => {
    const ast: InsertAst = {
      kind: 'insert',
      relation: { relation: 'records' },
      columns: ['key', 'value'],
      values: [['a', 'first']],
      conflict: {
        target: ['key'],
        action: {
          kind: 'doUpdate',
          set: [
            { column: 'value', value: { kind: 'excluded', column: 'value' } },
            { column: 'note"quoted', value: { kind: 'value', value: 'changed' } },
          ],
        },
      },
      returning: { kind: 'all' },
    }

    expect(compileSqliteQuery(ast)).toEqual({
      sql: 'insert into "main"."records" ("key", "value") values (?, ?) on conflict ("key") do update set "value" = excluded."value", "note""quoted" = ? returning *',
      params: ['a', 'first', 'changed'],
    })
  })

  it('rejects a conflict clause combined with DEFAULT VALUES', () => {
    expect(() =>
      compileSqliteQuery({
        kind: 'insert',
        relation: { relation: 'records' },
        columns: [],
        values: [[]],
        conflict: {
          target: ['key'],
          action: { kind: 'doNothing' },
        },
      }),
    ).toThrow(/SQLite.*conflict.*DEFAULT VALUES/i)
  })
})

describe('PostgreSQL insert upsert compilation', () => {
  it('preserves conflict literals and returning after DEFAULT VALUES', () => {
    expect(
      compilePostgresQuery({
        kind: 'insert',
        relation: { relation: 'records' },
        columns: [],
        values: [[]],
        conflict: {
          target: ['key'],
          action: {
            kind: 'doUpdate',
            set: [{ column: 'value', value: { kind: 'value', value: 'changed' } }],
          },
        },
        returning: { kind: 'columns', columns: ['key', 'value'] },
      }),
    ).toEqual({
      sql: 'insert into "records" default values on conflict ("key") do update set "value" = $1 returning "key", "value"',
      params: ['changed'],
    })
  })
})
