import {
  bigint,
  boolean,
  date,
  literal,
  nonNullable,
  null as nullSchema,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
  transform,
  union,
  uuid,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import { sqliteIdentity } from '@/dialects/sqlite/identity'
import { sqliteSchema } from '@/dialects/sqlite/schema'
import type { AuthoredDesiredSchema, LoweredDesiredTable } from '@/dialects/types'
import { column, defineTable, reference } from '@/index'
import { MigrationError, SchemaError, attemptSync } from '@/utils/error'

const context = {
  writableDefault: [{ role: 'database' as const, spelling: 'main' }],
}

/** Creates canonical identities from the fixture's selected namespace context. */
function identities() {
  return sqliteIdentity.create({ context })
}

it('should keep unsafe JSON composite inference as the MigrationError cause', () => {
  const Unsafe = defineTable(
    'sqlite_unsafe_json_composite',
    { id: string(), value: union([object({ id: bigint() }), object({ id: bigint() })]) },
    { primaryKey: 'id' },
  )

  const result = attemptSync(() =>
    lowerDesiredSchema([Unsafe], identities(), sqliteSchema),
  )

  expect(result.ok).toBe(false)

  if (result.ok) throw new Error('Expected unsafe JSON composite lowering to fail')

  if (!(result.error instanceof MigrationError))
    throw new Error('Expected MigrationError')

  expect(result.error.cause).toBeInstanceOf(SchemaError)

  expect((result.error.cause as SchemaError).message).toContain(
    'JSON composite output is not preserved',
  )
})

it('should lower a nullable transformed output to nullable number storage', () => {
  const Transformed = defineTable(
    'nullable_output',
    {
      id: string(),
      value: pipe(
        string(),
        transform((value): number | null => (value === 'null' ? null : Number(value))),
        nullable(number()),
      ),
    },
    { primaryKey: 'id' },
  )

  const tables = lowerDesiredSchema([Transformed], identities(), sqliteSchema).tables
  expect(
    tables[0]!.columns.find((column) => column.identifier.spelling === 'value'),
  ).toMatchObject({
    dataType: 'REAL',
    notNull: false,
  })
})

describe('SQLite desired schema', () => {
  it('should lower composite nullability, selected override, and inherited reference storage', () => {
    const Parent = defineTable(
      'composite_parent',
      {
        id: union([literal('one'), literal('two')]),
        value: pipe(
          union([string(), nullSchema()]),
          column({ physicalType: { postgresql: 'varchar(20)', sqlite: 'TEXT' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const Child = defineTable(
      'composite_child',
      {
        id: string(),
        parentId: reference(Parent, 'id'),
      },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema([Child, Parent], identities(), sqliteSchema).tables
    const parent = tables.find(
      (table) => table.identity.relation.spelling === 'composite_parent',
    )!

    const child = tables.find(
      (table) => table.identity.relation.spelling === 'composite_child',
    )!

    expect(
      parent.columns.find((column) => column.identifier.spelling === 'value'),
    ).toMatchObject({ dataType: 'TEXT', notNull: false })

    expect(
      child.columns.find((column) => column.identifier.spelling === 'parentId'),
    ).toMatchObject({ dataType: 'TEXT', notNull: true })
  })
})

describe('SQLite desired schema', () => {
  it('should retain TEXT for UUID validation, wrappers, references, and PostgreSQL-only overrides', () => {
    const Parent = defineTable(
      'uuid_parent',
      {
        id: pipe(string(), uuid()),
        wrapped: nullable(optional(pipe(string(), uuid()))),
        pipedWrapper: pipe(nonNullable(nullable(string())), uuid()),
        pgOverride: pipe(
          string(),
          uuid(),
          column({ physicalType: { postgresql: 'uuid' } }),
        ),
      },
      { primaryKey: 'id' },
    )

    const Child = defineTable(
      'uuid_child',
      { id: string(), parentId: reference(Parent, 'id') },
      { primaryKey: 'id' },
    )

    const tables = lowerDesiredSchema([Child, Parent], identities(), sqliteSchema).tables
    expect(tables.flatMap((table) => table.columns.map((item) => item.dataType))).toEqual(
      ['TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT', 'TEXT'],
    )
  })
})

describe('SQLite desired schema', () => {
  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
    ['unsafe positive integer', Number.MAX_SAFE_INTEGER + 1],
    ['unsafe negative integer', Number.MIN_SAFE_INTEGER - 1],
  ])('should reject %s during desired-schema lowering', (_name, value) => {
    const Records = defineTable(
      'literal_records',
      { value: literal(value) },
      { primaryKey: 'value' },
    )

    expect(() => lowerDesiredSchema([Records], identities(), sqliteSchema)).toThrow(
      MigrationError,
    )
  })

  it('should accept signed 64-bit bigint literals and reject their invalid neighbors', () => {
    const min = -9223372036854775808n
    const max = 9223372036854775807n

    expect(sqliteSchema.inferColumnType(literal(min))).toBe('BIGINT')
    expect(sqliteSchema.inferColumnType(literal(max))).toBe('BIGINT')
    expect(sqliteSchema.inferColumnType(literal(42n))).toBe('BIGINT')

    for (const value of [min - 1n, max + 1n]) {
      const Records = defineTable(
        'literal_records',
        { value: literal(value) },
        { primaryKey: 'value' },
      )

      expect(() => lowerDesiredSchema([Records], identities(), sqliteSchema)).toThrow(
        MigrationError,
      )
    }
  })
})

describe('SQLite desired schema', () => {
  it('should preserve explicit type spellings and use by-default identity as legal AUTOINCREMENT intent', () => {
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

    assertSqliteIdentityGeneration(parent, child)
  })
})

describe('SQLite desired schema', () => {
  it('should reject non-rowid identity and aliases outside main', () => {
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

    /** Attempts schema lowering for an attached SQLite database to exercise rejection. */
    const attachedDatabase = () =>
      lowerDesiredSchema([Attached], identities(), sqliteSchema)

    expect(attachedDatabase).toThrow(MigrationError)
    expect(attachedDatabase).toThrow(/database:main profile/i)
  })
})

describe('SQLite desired schema', () => {
  it('should lower literals and SQLite defaults without accepting unsafe expressions', () => {
    const Defaults = createDefaultsTable()
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
    const unsafe = createUnsafeDefaultGraph(graph)

    /** Attempts schema lowering with an unsafe database default to exercise rejection. */
    const unsafeDefault = () => sqliteSchema.lowerDesiredSchema(unsafe)
    expect(unsafeDefault).toThrow(MigrationError)
    expect(unsafeDefault).toThrow(/unsafe SQLite/i)
  })
})

/**
 * Creates the unsafe default graph fixture used by the contract scenario.
 *
 * @param graph - Registered authored tables and their resolved reference graph.
 *
 * @returns The unsafe default graph fixture used by the contract scenario.
 */
function createUnsafeDefaultGraph(graph: AuthoredDesiredSchema) {
  return {
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
}

/**
 * Builds a fresh defaults table handle for the schema scenario.
 *
 * @returns A fresh defaults table handle for the schema scenario.
 */
function createDefaultsTable() {
  return defineTable(
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
}

/**
 * Checks supported rowid identity generation and preserved explicit physical-type
 * spellings.
 *
 * @param parent - Parent relation or syntax node used by the fixture scenario.
 * @param child - Child relation or syntax node used by the fixture scenario.
 */
function assertSqliteIdentityGeneration(
  parent: LoweredDesiredTable,
  child: LoweredDesiredTable,
) {
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
}
