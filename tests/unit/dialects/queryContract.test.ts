import { number, pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { compilePostgresQuery } from '@/dialects/postgres/compile'
import { compileSqliteQuery } from '@/dialects/sqlite/compile'
import type { CompiledQuery, Dialect, SelectAst } from '@/index'
import {
  InvariantError,
  QueryError,
  column,
  defineTable,
  eq,
  postgresDialect,
  reference,
} from '@/index'
import { createTableBuilder, createValueMapper } from '@/query'

import { exactQueryAddressing } from '../helpers/queryAddressing'

describe('dialect compiler AST invariants', () => {
  it('treats malformed builder ASTs as invariants in both compilers', () => {
    const relation = { relation: 'events' }

    expect(() =>
      compilePostgresQuery({ kind: 'select', relation, selection: [] } as never),
    ).toThrow(InvariantError)

    expect(() =>
      compileSqliteQuery({ kind: 'select', relation, selection: null } as never),
    ).toThrow(InvariantError)

    expect(() =>
      compileSqliteQuery({ kind: 'select', relation, selection: [] }),
    ).not.toThrow()
  })
})

describe('dialect query contract', () => {
  it('delivers authored relation intent to the selected query member', () => {
    const Events = createEventsTable()
    const selectedCompile = vi.fn<(node: SelectAst) => CompiledQuery>(
      (node: SelectAst) => {
        expect(node.relation).toEqual({
          namespace: [{ role: 'database', spelling: 'analytics' }],
          relation: 'events',
        })

        expect(node.selection).toEqual([
          {
            kind: 'column',
            column: 'id',
            relation: {
              namespace: [{ role: 'database', spelling: 'analytics' }],
              relation: 'events',
            },
          },
        ])

        return { sql: 'test member compiled query', params: [] }
      },
    )

    const dialect: Dialect = {
      ...postgresDialect,
      id: 'sqlite',
      query: {
        ...postgresDialect.query,
        ...exactQueryAddressing(selectedCompile as never),
      },
    }

    const compiled = createTableBuilder({
      handle: Events,
      dialect,
      executor: {
        /** Executes fixture SQL with the configured native observations. */
        execute: async () => [],
        /** Runs a fixture statement with configured outcomes. */
        run: async () => undefined,
      },
    })
      .select([Events.id])
      .compile()

    expect(compiled.sql).toBe('test member compiled query')
    expect(selectedCompile).toHaveBeenCalledOnce()
  })
})

describe('dialect query contract: keeps omitted qualification omitted for the selected member', () => {
  it('keeps omitted qualification omitted for the selected member', () => {
    const Events = defineTable(
      'events',
      { id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })) },
      { primaryKey: 'id' },
    )

    const selectedCompile = vi.fn<(node: SelectAst) => CompiledQuery>(
      (node: SelectAst) => {
        expect(node.relation).toEqual({ relation: 'events' })
        expect(node.relation).not.toHaveProperty('namespace')
        return { sql: 'unqualified test query', params: [] }
      },
    )

    const dialect: Dialect = {
      ...postgresDialect,
      id: 'sqlite',
      query: {
        ...postgresDialect.query,
        ...exactQueryAddressing(selectedCompile as never),
      },
    }

    const compiled = createTableBuilder({
      handle: Events,
      dialect,
      executor: {
        /** Executes fixture SQL with the configured native observations. */
        execute: async () => [],
        /** Runs a fixture statement with configured outcomes. */
        run: async () => undefined,
      },
    }).compile()

    expect(compiled.sql).toBe('unqualified test query')
    expect(selectedCompile).toHaveBeenCalledOnce()
  })
})

describe('dialect query contract: resolves reference types by complete structured relation intent', () => {
  it('resolves reference types by complete structured relation intent', () => {
    const NumericItem = defineTable(
      'items',
      { id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })) },
      {
        primaryKey: 'id',
        namespace: [{ role: 'database', spelling: 'numeric' }],
      },
    )

    const TextItem = defineTable(
      'items',
      { id: pipe(string(), column({ physicalType: { sqlite: 'text' } })) },
      {
        primaryKey: 'id',
        namespace: [{ role: 'database', spelling: 'textual' }],
      },
    )

    const Link = defineTable(
      'links',
      {
        id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })),
        itemId: reference(TextItem, 'id'),
      },
      { primaryKey: 'id' },
    )

    const dialect: Dialect = {
      ...postgresDialect,
      id: 'sqlite',
      schema: {
        ...postgresDialect.schema,
        /** Infers a supported physical SQL type from Valibot schema facts. */
        inferColumnType: () => 'fallback',
      },
      query: {
        ...postgresDialect.query,
        ...exactQueryAddressing(postgresDialect.query.resolve([]).compile),
      },
    }

    const mapper = createValueMapper(dialect, undefined, [NumericItem, TextItem, Link])

    expect(mapper.columnTypes(Link).itemId).toBe('text')
  })
})

describe('Dialect query relation lookup errors', () => {
  it('throws tagged errors when semantic relation lookup finds zero matches', () => {
    const Events = defineTable(
      'events',
      { id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })) },
      {
        primaryKey: 'id',
        namespace: [{ role: 'database', spelling: 'analytics' }],
      },
    )

    const dialect: Dialect = {
      ...postgresDialect,
      id: 'sqlite',
      query: {
        ...postgresDialect.query,
        ...exactQueryAddressing(() => ({ sql: 'query', params: [] })),
      },
    }

    assertMissingRelationError(Events, dialect)
  })
})

describe('Dialect query relation lookup errors: throws tagged errors when semantic relation lookup finds multiple matches', () => {
  it('throws tagged errors when semantic relation lookup finds multiple matches', () => {
    const Events = createAmbiguousEventsTable()
    const DuplicateEvents = defineTable(
      'events',
      { id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })) },
      {
        primaryKey: 'id',
        namespace: [{ role: 'database', spelling: 'analytics' }],
      },
    )

    const dialect: Dialect = {
      ...postgresDialect,
      id: 'sqlite',
      query: {
        ...postgresDialect.query,
        ...exactQueryAddressing(() => ({ sql: 'query', params: [] })),
      },
    }

    assertAmbiguousRelationError(Events, dialect, DuplicateEvents)

    expect(() =>
      createTableBuilder({
        handle: Events,
        dialect,
        executor: {
          /** Executes fixture SQL with the configured native observations. */
          execute: async () => [],

          /** Runs a fixture statement with configured outcomes. */
          run: async () => undefined,
        },
      })
        .innerJoin(DuplicateEvents, eq(Events.id, DuplicateEvents.id))
        .select(() => [
          {
            kind: 'column',
            relation: {
              namespace: [{ role: 'database', spelling: 'analytics' }],
              relation: 'events',
            },
            column: 'id',
            alias: 'id',
          } as const,
        ])
        .compile(),
    ).toThrow(/ambiguous in this query/i)
  })
})

/**
 * Builds a fresh ambiguous events table handle for the schema scenario.
 *
 * @returns A fresh ambiguous events table handle for the schema scenario.
 */
function createAmbiguousEventsTable() {
  return defineTable(
    'events',
    { id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })) },
    {
      primaryKey: 'id',
      namespace: [{ role: 'database', spelling: 'analytics' }],
    },
  )
}

/**
 * Builds a fresh events table handle for the schema scenario.
 *
 * @returns A fresh events table handle for the schema scenario.
 */
function createEventsTable() {
  return defineTable(
    'events',
    { id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })) },
    {
      primaryKey: 'id',
      namespace: [{ role: 'database', spelling: 'analytics' }],
    },
  )
}

/**
 * Checks the tagged query error for an ambiguous authored relation reference.
 *
 * @param Events - Table handle used to exercise events schema behavior.
 * @param dialect - Selected dialect's schema, query, and lifecycle operations.
 * @param DuplicateEvents - Table handle used to exercise duplicate events schema
 *   behavior.
 */
function assertAmbiguousRelationError(
  Events: ReturnType<typeof createEventsTable>,
  dialect: Dialect,
  DuplicateEvents: ReturnType<typeof createEventsTable>,
) {
  expect(() =>
    createTableBuilder({
      handle: Events,
      dialect,
      executor: {
        /** Executes fixture SQL with the configured native observations. */
        execute: async () => [],

        /** Runs a fixture statement with configured outcomes. */
        run: async () => undefined,
      },
    })
      .innerJoin(DuplicateEvents, eq(Events.id, DuplicateEvents.id))
      .select(() => [
        {
          kind: 'column',
          relation: {
            namespace: [{ role: 'database', spelling: 'analytics' }],
            relation: 'events',
          },
          column: 'id',
          alias: 'id',
        } as const,
      ])
      .compile(),
  ).toThrow(QueryError)
}

/**
 * Checks the tagged query error for an unregistered authored relation reference.
 *
 * @param Events - Table handle used to exercise events schema behavior.
 * @param dialect - Selected dialect's schema, query, and lifecycle operations.
 */
function assertMissingRelationError(
  Events: ReturnType<typeof createEventsTable>,
  dialect: Dialect,
) {
  expect(() =>
    createTableBuilder({
      handle: Events,
      dialect,
      executor: createEmptyQueryExecutor(),
    })
      .select(() => [
        {
          kind: 'column',
          relation: {
            namespace: [{ role: 'database', spelling: 'missing' }],
            relation: 'events',
          },
          column: 'id',
          alias: 'id',
        } as const,
      ])
      .compile(),
  ).toThrow(QueryError)

  expect(() =>
    createTableBuilder({
      handle: Events,
      dialect,
      executor: createEmptyQueryExecutor(),
    })
      .select(() => [
        {
          kind: 'column',
          relation: {
            namespace: [{ role: 'database', spelling: 'missing' }],
            relation: 'events',
          },
          column: 'id',
          alias: 'id',
        } as const,
      ])
      .compile(),
  ).toThrow(/not available in this query/i)
}

/**
 * Supplies inert execution methods for query-compilation rejection checks.
 *
 * @returns An executor whose queries return no rows and whose statements do nothing.
 */
function createEmptyQueryExecutor(): import('@/query').Executor {
  return {
    /** Executes fixture SQL with the configured native observations. */
    execute: async () => [],

    /** Runs a fixture statement with configured outcomes. */
    run: async () => undefined,
  }
}
