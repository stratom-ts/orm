import {
  boolean,
  date,
  enum as enumSchema,
  exactOptional,
  integer,
  minValue,
  nonNullable,
  nonNullish,
  nonOptional,
  nullable,
  nullish,
  number,
  object,
  optional,
  picklist,
  pipe,
  string,
  undefinedable,
} from 'valibot'
import { describe, expect, it } from 'vitest'

import { lowerDesiredSchema, registerDesiredSchema } from '@/ddl/desiredSchema'
import {
  sqliteIdentity,
  sqliteNaming,
  sqliteQuery,
  sqliteSchema,
} from '@/dialects/sqlite'
import type { AuthoredDesiredSchema, LoweredDesiredTable } from '@/dialects/types'
import {
  column,
  defineTable,
  sqliteIdentity as publicSqliteIdentity,
  sqliteNaming as publicSqliteNaming,
  sqliteQuery as publicSqliteQuery,
  sqliteSchema as publicSqliteSchema,
  reference,
} from '@/index'
import type { CanonicalRelationIdentity } from '@/migrations/canonicalRelationIdentity'
import type { PhysicalNameRegistry } from '@/migrations/physicalNaming'
import type { AnySchema } from '@/types/schema'
import { InvariantError, MigrationError, SchemaError } from '@/utils/error'

const context = {
  writableDefault: [{ role: 'database' as const, spelling: 'main' }],
}

/** Creates canonical identities from the fixture's selected namespace context. */
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

  it('infers homogeneous enum and picklist storage from their output values', () => {
    expect(sqliteSchema.inferColumnType(enumSchema({ first: 'a', second: 'b' }))).toBe(
      'TEXT',
    )

    expect(sqliteSchema.inferColumnType(picklist(['a', 'b']))).toBe('TEXT')
    expect(sqliteSchema.inferColumnType(picklist([1, 2]))).toBe('INTEGER')
    expect(sqliteSchema.inferColumnType(picklist([1, 1.5]))).toBe('REAL')
    expect(sqliteSchema.inferColumnType(picklist([1.5, 1]))).toBe('REAL')
    expect(sqliteSchema.inferColumnType(picklist([2, 1]))).toBe('INTEGER')

    expect(sqliteSchema.inferColumnType(enumSchema({ first: 1, second: 2 }))).toBe(
      'INTEGER',
    )

    expect(sqliteSchema.inferColumnType(enumSchema({ first: 1, second: 1.5 }))).toBe(
      'REAL',
    )
  })

  it('infers boolean and bigint choice storage', () => {
    const booleanChoices = (
      picklist as unknown as (options: readonly boolean[]) => AnySchema
    )([true, false])

    expect(sqliteSchema.inferColumnType(nullable(booleanChoices))).toBe('BOOLEAN')
    expect(sqliteSchema.inferColumnType(picklist([1n, 2n]))).toBe('BIGINT')
  })

  it('rejects mixed choices with the explicit mapping contract', () => {
    for (const schema of [
      picklist(['1', 1]),
      picklist([null, 'a'] as unknown as [string, string]),
      enumSchema({ first: 1, second: 'a' }),
    ]) {
      expect(() => sqliteSchema.inferColumnType(schema)).toThrow(SchemaError)

      expect(() => sqliteSchema.inferColumnType(schema)).toThrow(
        /column\(\{ physicalType: \{ sqlite: \.\.\. \} \}\).*explicit parameter and result mappings/,
      )
    }
  })
})

describe('SQLite choice inference wrappers', () => {
  it.each([
    ['optional', optional(picklist([1, 2]))],
    ['exactOptional', exactOptional(picklist([1, 2]))],
    ['undefinedable', undefinedable(picklist([1, 2]))],
    ['nullable', nullable(picklist([1, 2]))],
    ['nullish', nullish(picklist([1, 2]))],
    ['nonOptional', nonOptional(picklist([1, 2]))],
    ['nonNullable', nonNullable(picklist([1, 2]))],
    ['nonNullish', nonNullish(picklist([1, 2]))],
    ['nested wrappers and pipe', nullable(optional(pipe(picklist([1, 2]), minValue(1))))],
  ])('infers numeric choice storage through %s wrappers', (_name, schema) => {
    expect(sqliteSchema.inferColumnType(schema)).toBe('INTEGER')
  })
})

describe('SQLite choice inference numeric boundaries', () => {
  it.each([
    ['NaN', picklist([0, Number.NaN])],
    ['positive infinity', picklist([0, Number.POSITIVE_INFINITY])],
    ['negative infinity', picklist([0, Number.NEGATIVE_INFINITY])],
    ['unsafe positive integer', picklist([0, Number.MAX_SAFE_INTEGER + 1])],
    ['unsafe negative integer', picklist([0, Number.MIN_SAFE_INTEGER - 1])],
  ])('rejects numeric choice option %s after a valid option', (_name, schema) => {
    expect(() => sqliteSchema.inferColumnType(schema)).toThrow(SchemaError)
  })

  it('accepts safe-integer boundary choices and rejects their invalid neighbors', () => {
    expect(
      sqliteSchema.inferColumnType(
        picklist([Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]),
      ),
    ).toBe('INTEGER')

    expect(() =>
      sqliteSchema.inferColumnType(picklist([0, Number.MAX_SAFE_INTEGER + 1])),
    ).toThrow(SchemaError)

    expect(() =>
      sqliteSchema.inferColumnType(picklist([0, Number.MIN_SAFE_INTEGER - 1])),
    ).toThrow(SchemaError)
  })
})

describe('SQLite choice inference bigint boundaries', () => {
  it('accepts signed 64-bit bigint boundaries and rejects their invalid neighbors', () => {
    const min = -9223372036854775808n
    const max = 9223372036854775807n

    expect(sqliteSchema.inferColumnType(picklist([min, max]))).toBe('BIGINT')

    expect(() => sqliteSchema.inferColumnType(picklist([0n, min - 1n]))).toThrow(
      SchemaError,
    )

    expect(() => sqliteSchema.inferColumnType(picklist([0n, max + 1n]))).toThrow(
      SchemaError,
    )
  })
})

describe('SQLite schema facets: preserves explicit type spellings and uses by-default identity as legal AUTOINCREMENT intent', () => {
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

    assertSqliteIdentityGeneration(parent, child)
  })
})

describe('SQLite schema facets: rejects non-rowid identity and aliases outside main', () => {
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

    /** Attempts schema lowering for an attached SQLite database to exercise rejection. */
    const attachedDatabase = () =>
      lowerDesiredSchema([Attached], identities(), sqliteSchema)

    expect(attachedDatabase).toThrow(MigrationError)
    expect(attachedDatabase).toThrow(/database:main profile/i)
  })
})

describe('SQLite schema defaults and names', () => {
  it('lowers literals and SQLite defaults without accepting unsafe expressions', () => {
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

describe('SQLite schema defaults and names: re-exports ready SQLite facets from the package surface without a dialect member', () => {
  it('re-exports ready SQLite facets from the package surface without a dialect member', () => {
    expect(publicSqliteIdentity).toBe(sqliteIdentity)
    expect(publicSqliteNaming).toBe(sqliteNaming)
    expect(publicSqliteQuery).toBe(sqliteQuery)
    expect(publicSqliteSchema).toBe(sqliteSchema)
  })
})

describe('SQLite schema defaults and names: allows long SQLite names and validates identifier safety and collisions', () => {
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

    /** Validates an identifier containing NUL to exercise rejection. */
    const nulName = () => sqliteNaming.validate('has\0nul', 'NUL SQLite name')
    expect(nulName).toThrow(InvariantError)
    expect(nulName).toThrow(/must not contain NUL/i)

    /** Validates an identifier containing an unpaired surrogate to exercise rejection. */
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

    assertSqliteIdentifierSafety(registry, events, archive)
  })
})

/**
 * Checks long valid names and rejection of unsafe or malformed identifier spellings.
 *
 * @param registry - Identity registry used to resolve registered table handles.
 * @param events - Recorded session or migration events in their observed order.
 * @param archive - Attached or alternate namespace used to check relation resolution.
 */
function assertSqliteIdentifierSafety(
  registry: PhysicalNameRegistry,
  events: CanonicalRelationIdentity,
  archive: CanonicalRelationIdentity,
) {
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
}

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
