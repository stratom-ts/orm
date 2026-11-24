import {
  array,
  literal,
  nullable,
  number,
  object,
  optional,
  pipe,
  record,
  string,
  transform,
  tuple,
  union,
} from 'valibot'
import { expect, it, vi } from 'vitest'

import type { Dialect } from '@/index'
import { defineTable, postgresDialect, reference, sqliteDialect } from '@/index'
import { createTableBuilder, createValueMapper } from '@/query'
import type { AnySchema } from '@/types/schema'

function fixture(dialect: Dialect, left: AnySchema, right: AnySchema) {
  const a = defineTable(
    'json_left',
    { id: number(), payload: left },
    { primaryKey: 'id' },
  )

  const b = defineTable(
    'json_right',
    { id: number(), payload: right },
    { primaryKey: 'id' },
  )

  const tables = [a, b]
  const query = dialect.query.resolve(tables)
  const mapper = createValueMapper(dialect, undefined, tables, query)
  const executor = {
    execute: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
    run: async () => 0,
  }

  const builder = createTableBuilder({
    handle: a,
    dialect,
    query,
    mapper,
    executor,
  }).select([a.payload])

  // JavaScript callers have no static proof of the other operand's output type.
  const dynamic = builder as {
    union(other: object): { compile(): unknown; execute(): Promise<unknown[]> }
  }

  const other = createTableBuilder({
    handle: b,
    dialect,
    query,
    mapper,
    executor,
  }).select([b.payload])

  return { compound: dynamic.union(other), executor }
}

it.each([postgresDialect, sqliteDialect])(
  'should reject mismatched dynamic JSON output structures before SQL in $id',
  async (dialect) => {
    const { compound, executor } = fixture(
      dialect,
      object({ value: string() }),
      object({ other: number() }),
    )

    expect(() => compound.compile()).toThrow(/payload.*representation/)
    await expect(compound.execute()).rejects.toThrow(/payload.*representation/)
    expect(executor.execute).not.toHaveBeenCalled()
  },
)

it.each([
  [
    'nested property',
    object({ value: array(string()) }),
    object({ value: array(number()) }),
  ],
  [
    'optional property',
    object({ value: string() }),
    object({ value: optional(string()) }),
  ],
  [
    'nullable property',
    object({ value: string() }),
    object({ value: nullable(string()) }),
  ],
  ['record value', record(string(), string()), record(string(), number())],
  ['tuple position', tuple([string(), number()]), tuple([number(), string()])],
  [
    'literal choice',
    object({ value: literal('one') }),
    object({ value: literal('two') }),
  ],
] as const)('should reject incompatible JSON %s', (_name, left, right) => {
  const { compound } = fixture(postgresDialect, left, right)
  expect(() => compound.compile()).toThrow(/payload.*representation/)
})

it.each([
  [
    'object entries',
    () => object({ value: string(), nested: array(nullable(number())) }),
  ],
  ['optional entries', () => object({ value: optional(string()) })],
  ['records', () => record(string(), array(number()))],
  ['tuples', () => tuple([string(), nullable(number())])],
] as const)('should accept independently authored matching JSON %s', (_name, schema) => {
  const { compound } = fixture(postgresDialect, schema(), schema())
  expect(() => compound.compile()).not.toThrow()
})

it('should canonicalize JSON entry and union order while ignoring column defaults and SQL nullability', () => {
  const left = object({
    kind: union([literal('one'), literal('two')]),
    value: string(),
  })

  const right = optional(
    nullable(
      object({
        value: string(),
        kind: union([literal('two'), literal('one')]),
      }),
    ),
    { kind: 'one', value: '' },
  )

  expect(() => fixture(postgresDialect, left, right).compound.compile()).not.toThrow()
})

it('should reject opaque nested JSON transformations without invoking them', () => {
  const convert = vi.fn<(value: string) => string>((value) => value)
  const schema = () => object({ value: pipe(string(), transform(convert), string()) })
  const { compound } = fixture(postgresDialect, schema(), schema())
  expect(() => compound.compile()).toThrow(/payload.*representation/)
  expect(convert).not.toHaveBeenCalled()
})

it('should preserve structural JSON evidence through reference storage facts', () => {
  const parent = defineTable(
    'json_parent',
    { payload: object({ value: string() }) },
    {
      primaryKey: 'payload',
    },
  )

  const child = defineTable(
    'json_child',
    { payload: reference(parent, 'payload') },
    {
      primaryKey: 'payload',
    },
  )

  const dialect = postgresDialect
  const query = dialect.query.resolve([parent, child])
  const mapper = createValueMapper(dialect, undefined, [parent, child], query)
  const executor = { execute: async () => [], run: async () => 0 }
  const left = createTableBuilder({ handle: parent, dialect, query, mapper, executor })
  const right = createTableBuilder({ handle: child, dialect, query, mapper, executor })
  expect(() => left.union(right).compile()).not.toThrow()
})
