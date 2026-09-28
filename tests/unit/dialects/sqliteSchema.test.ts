import { boolean, date, integer, number, object, pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import {
  sqliteIdentity,
  sqliteNaming,
  sqliteQuery,
  sqliteSchema,
} from '@/dialects/sqlite'
import {
  column,
  defineTable,
  sqliteIdentity as publicSqliteIdentity,
  sqliteNaming as publicSqliteNaming,
  sqliteQuery as publicSqliteQuery,
  sqliteSchema as publicSqliteSchema,
  reference,
} from '@/index'
import { InvariantError, MigrationError } from '@/utils/error'

const context = {
  writableDefault: [{ role: 'database' as const, spelling: 'main' }],
}

function identities() {
  return sqliteIdentity.create({ context })
}

describe('SQLite schema facets', () => {
  it('infers distinct logical declared types while comparing their affinities stably', () => {
    expect(sqliteSchema.inferColumnType(string())).toBe('TEXT')
    expect(sqliteSchema.inferColumnType(pipe(number(), integer()))).toBe('INTEGER')
    expect(sqliteSchema.inferColumnType(number())).toBe('REAL')
    expect(sqliteSchema.inferColumnType(boolean())).toBe('BOOLEAN')
    expect(sqliteSchema.inferColumnType(date())).toBe('DATETIME')
    expect(sqliteSchema.inferColumnType(object({ value: string() }))).toBe('JSON')
    expect(sqliteSchema.normalizeDataType('BOOLEAN')).toBe('numeric')
    expect(sqliteSchema.normalizeDataType('JSON')).toBe('numeric')
    expect(sqliteSchema.normalizeDataType('INTEGER')).toBe('integer')
  })

  it('preserves explicit type spellings and uses by-default identity as legal AUTOINCREMENT intent', () => {
    const Parent = defineTable(
      'parents',
      {
        id: pipe(
          number(),
          column({
            physicalType: { sqlite: ' INTEGER ' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
        enabled: pipe(boolean(), column({ unique: true })),
      },
      { primaryKey: 'id' },
    )
    const Child = defineTable(
      'children',
      {
        id: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })),
        parentId: pipe(
          reference(Parent, 'id', { onDelete: 'cascade' }),
          column({ physicalType: { sqlite: 'INT' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const lowered = lowerDesiredSchema([Child, Parent], identities(), sqliteSchema)
    const parent = lowered.tables.find(
      (table) => table.identity.relation.spelling === 'parents',
    )!
    const child = lowered.tables.find(
      (table) => table.identity.relation.spelling === 'children',
    )!

    expect(
      parent.columns.find((column) => column.identifier.spelling === 'id'),
    ).toMatchObject({
      dataType: 'INTEGER',
      autoIncrement: true,
      unique: false,
    })

    expect(
      parent.columns.find((column) => column.identifier.spelling === 'enabled'),
    ).toMatchObject({
      dataType: 'BOOLEAN',
      unique: true,
    })

    expect(
      child.columns.find((column) => column.identifier.spelling === 'parentId'),
    ).toMatchObject({
      dataType: 'INT',
      reference: {
        relation: parent.identity,
        column: { spelling: 'id', comparisonKey: 'id' },
        onDelete: 'cascade',
      },
    })
  })

  it('rejects non-rowid identity and aliases outside main', () => {
    const NotRowid = defineTable(
      'not_rowid',
      {
        id: pipe(
          number(),
          column({
            physicalType: { sqlite: 'INT' },
            generation: { kind: 'identity', mode: 'byDefault' },
          }),
        ),
      },
      { primaryKey: 'id' },
    )
    const Attached = defineTable(
      'attached',
      { id: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })) },
      {
        primaryKey: 'id',
        namespace: [{ role: 'database', spelling: 'archive' }],
      },
    )

    expect(() => lowerDesiredSchema([NotRowid], identities(), sqliteSchema)).toThrow(
      MigrationError,
    )

    const attachedDatabase = () =>
      lowerDesiredSchema([Attached], identities(), sqliteSchema)
    expect(attachedDatabase).toThrow(MigrationError)
    expect(attachedDatabase).toThrow(/database:main profile/i)
  })

  it('lowers literals and SQLite defaults without accepting unsafe expressions', () => {
    const Defaults = defineTable(
      'defaults',
      {
        id: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })),
        enabled: pipe(
          boolean(),
          column({ databaseDefault: { kind: 'literal', value: true } }),
        ),
        createdAt: pipe(
          date(),
          column({
            databaseDefault: {
              kind: 'portableExpression',
              expression: 'currentTimestamp',
            },
          }),
        ),
        clock: pipe(
          string(),
          column({
            databaseDefault: {
              kind: 'dialectExpression',
              dialect: 'sqlite',
              expression: "strftime('%s', 'now')",
            },
          }),
        ),
      },
      { primaryKey: 'id' },
    )
    const table = lowerDesiredSchema([Defaults], identities(), sqliteSchema).tables[0]!

    const defaults = Object.fromEntries(
      table.columns.map((column) => [column.identifier.spelling, column.databaseDefault]),
    )
    expect(defaults.enabled).toEqual({ sql: '1', normalized: '1' })

    expect(defaults.createdAt).toEqual({
      sql: 'CURRENT_TIMESTAMP',
      normalized: 'current_timestamp',
    })

    expect(defaults.clock).toEqual({
      sql: "(strftime('%s', 'now'))",
      normalized: "strftime('%s', 'now')",
    })

    const graph = registerDesiredSchema([Defaults], identities())
    const unsafe = {
      ...graph,
      tables: graph.tables.map((table) => ({
        ...table,
        columns: table.columns.map((item) =>
          item.name === 'clock'
            ? {
                ...item,
                metadata: {
                  ...item.metadata!,
                  databaseDefault: {
                    kind: 'dialectExpression' as const,
                    dialect: 'sqlite' as const,
                    expression: 'select 1',
                  },
                },
              }
            : item,
        ),
      })),
    }

    const unsafeDefault = () => sqliteSchema.lowerDesiredSchema(unsafe)
    expect(unsafeDefault).toThrow(MigrationError)
    expect(unsafeDefault).toThrow(/unsafe SQLite/i)
  })

  it('re-exports ready SQLite facets from the package surface without a dialect member', () => {
    expect(publicSqliteIdentity).toBe(sqliteIdentity)
    expect(publicSqliteNaming).toBe(sqliteNaming)
    expect(publicSqliteQuery).toBe(sqliteQuery)
    expect(publicSqliteSchema).toBe(sqliteSchema)
  })

  it('allows long SQLite names and validates identifier safety and collisions', () => {
    const identity = identities()
    const records = identity.resolve({ relation: 'records' })
    const events = identity.resolve({ relation: 'events' })
    const archive = identity.resolve({
      namespace: [{ role: 'database', spelling: 'archive' }],
      relation: 'events',
    })
    const registry = sqliteNaming.createRegistry()

    expect(() =>
      sqliteNaming.validate('a'.repeat(1024), 'long SQLite name'),
    ).not.toThrow()

    const nulName = () => sqliteNaming.validate('has\0nul', 'NUL SQLite name')
    expect(nulName).toThrow(InvariantError)
    expect(nulName).toThrow(/must not contain NUL/i)

    const unpairedSurrogate = () =>
      sqliteNaming.validate('has\ud800surrogate', 'surrogate SQLite name')
    expect(unpairedSurrogate).toThrow(InvariantError)
    expect(unpairedSurrogate).toThrow(/must not contain unpaired Unicode surrogates/i)

    registry.reserve({
      kind: 'index',
      owner: records,
      name: 'CaseSensitiveIndex',
      token: 'records-index',
      description: 'records index',
    })

    expect(() =>
      registry.reserve({
        kind: 'index',
        owner: events,
        name: 'casesensitiveindex',
        token: 'events-index',
        description: 'events index',
      }),
    ).toThrow(/collision/i)

    expect(() =>
      registry.reserve({
        kind: 'index',
        owner: archive,
        name: 'casesensitiveindex',
        token: 'archive-index',
        description: 'archive index',
      }),
    ).not.toThrow()
  })
})
