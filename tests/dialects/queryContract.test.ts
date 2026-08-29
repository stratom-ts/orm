import { number, pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import type { Dialect, SelectAst } from '@/index'
import { column, defineTable, postgresDialect, reference } from '@/index'
import { createTableBuilder, createValueMapper } from '@/query'

describe('dialect query contract', () => {
  it('delivers authored relation intent to the selected query member', () => {
    const Events = defineTable(
      'events',
      { id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })) },
      {
        primaryKey: 'id',
        namespace: [{ role: 'database', spelling: 'analytics' }],
      },
    )
    const selectedCompile = vi.fn((node: SelectAst) => {
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
    })
    const dialect: Dialect = {
      ...postgresDialect,
      id: 'sqlite',
      query: { ...postgresDialect.query, compile: selectedCompile as never },
    }

    const compiled = createTableBuilder({
      handle: Events,
      dialect,
      executor: {
        execute: async () => [],
        run: async () => undefined,
      },
    })
      .select([Events.id])
      .compile()

    expect(compiled.sql).toBe('test member compiled query')
    expect(selectedCompile).toHaveBeenCalledOnce()
  })

  it('keeps omitted qualification omitted for the selected member', () => {
    const Events = defineTable(
      'events',
      { id: pipe(number(), column({ physicalType: { sqlite: 'integer' } })) },
      { primaryKey: 'id' },
    )
    const selectedCompile = vi.fn((node: SelectAst) => {
      expect(node.relation).toEqual({ relation: 'events' })
      expect(node.relation).not.toHaveProperty('namespace')
      return { sql: 'unqualified test query', params: [] }
    })
    const dialect: Dialect = {
      ...postgresDialect,
      id: 'sqlite',
      query: { ...postgresDialect.query, compile: selectedCompile as never },
    }

    const compiled = createTableBuilder({
      handle: Events,
      dialect,
      executor: {
        execute: async () => [],
        run: async () => undefined,
      },
    }).compile()

    expect(compiled.sql).toBe('unqualified test query')
    expect(selectedCompile).toHaveBeenCalledOnce()
  })

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
        inferColumnType: () => 'fallback',
      },
    }

    const mapper = createValueMapper(dialect, undefined, [NumericItem, TextItem, Link])

    expect(mapper.columnTypes(Link).itemId).toBe('text')
  })
})
