import { number, pipe, string } from 'valibot'
import { expect, it, vi } from 'vitest'

import type { ColumnNamingFunction } from '@/index'
import {
  SchemaError,
  column,
  createDatabase,
  defineTable,
  postgresDialect,
  sqliteDialect,
} from '@/index'
import { snakeCase } from '@/naming'
import { resolveColumnNames } from '@/schemas/physicalColumn'

import { createMockPostgresConnector } from './dialects/postgresNativeClientFixtures'

const Users = defineTable(
  'users',
  {
    userId: number(),
    fullName: string(),
    legacyName: pipe(string(), column({ name: 'displayName' })),
  },
  { primaryKey: 'userId', indexes: [{ columns: ['fullName'] }] },
)

it('should snapshot names once, skip explicit names and isolate clients sharing handles', async () => {
  const connector = createMockPostgresConnector()
  const naming = vi.fn<ColumnNamingFunction>(snakeCase)
  const first = createDatabase({
    connector,
    schemas: [Users],
    naming: { columns: naming },
  })

  const second = createDatabase({
    connector: createMockPostgresConnector(),
    schemas: [Users],
    naming: { columns: ({ column, table }) => `${table}_${column}` },
  })

  const unchanged = createDatabase({
    connector: createMockPostgresConnector(),
    schemas: [Users],
  })

  expect(naming.mock.calls).toEqual([
    [{ column: 'userId', table: 'users' }],
    [{ column: 'fullName', table: 'users' }],
  ])

  expect(connector.prepared).toEqual([])
  expect(first.schemas[0]).toBe(Users)
  expect(Users.fullName.column).toBe('fullName')

  expect(first.from(Users).where('fullName', 'eq', 'Ada').compile().sql).toContain(
    '"full_name"',
  )

  expect(second.from(Users).compile().sql).toContain('"users_fullName"')
  expect(unchanged.from(Users).compile().sql).toContain('"fullName"')
  expect(first.from(Users).compile().sql).toContain('"displayName"')

  await first.transaction(async (trx) => {
    expect(trx.from(Users).compile().sql).toContain('"full_name"')
  })

  expect(naming).toHaveBeenCalledTimes(2)
  await Promise.all([first.close(), second.close(), unchanged.close()])
})

for (const dialect of [postgresDialect, sqliteDialect]) {
  it(`should reject invalid naming values before any session for ${dialect.id}`, () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const badValues = [
      undefined,
      null,
      42,
      1n,
      circular,
      '',
      'bad\0name',
      ...(dialect.id === 'postgresql' ? ['\u754c'.repeat(22)] : []),
    ]

    for (const value of badValues) {
      const naming = (() => value) as ColumnNamingFunction
      const getInstance = vi.fn<() => never>(() => {
        throw new Error('session acquired')
      })

      const connector = {
        ...createMockPostgresConnector(),
        dialect: dialect.id === 'sqlite' ? ('sqlite' as const) : ('postgresql' as const),
        getInstance,
      }

      const construct = () =>
        createDatabase({ connector, schemas: [Users], naming: { columns: naming } })

      expect(construct).toThrow(SchemaError)
      expect(construct).toThrow(/userId.*users|users.*userId/)
      expect(getInstance).not.toHaveBeenCalled()
    }
  })

  it(`should reject generated collisions including explicit names for ${dialect.id}`, () => {
    const Duplicate = defineTable(
      'duplicate',
      { fullName: string(), FullName: string() },
      { primaryKey: 'fullName' },
    )

    expect(() => resolveColumnNames([Duplicate], dialect, snakeCase)).toThrow(
      /fullName.*FullName|FullName.*fullName/,
    )

    expect(() => resolveColumnNames([Users], dialect, () => 'displayName')).toThrow(
      /userId.*fullName/,
    )

    const Explicit = defineTable(
      'explicit_collision',
      { value: string(), fixed: pipe(string(), column({ name: 'same' })) },
      { primaryKey: 'value' },
    )

    expect(() => resolveColumnNames([Explicit], dialect, () => 'same')).toThrow(
      /value.*fixed/,
    )

    const Case = defineTable(
      'case_columns',
      { a: string(), b: string() },
      { primaryKey: 'a' },
    )

    const run = () =>
      resolveColumnNames([Case], dialect, ({ column }) =>
        column === 'a' ? 'value' : 'VALUE',
      )

    let failure: unknown
    try {
      run()
    } catch (cause) {
      failure = cause
    }

    expect(failure instanceof SchemaError).toBe(dialect.id === 'sqlite')
  })
}

it('should preserve thrown callback values as SchemaError causes', () => {
  for (const cause of [new Error('naming failed'), undefined, null, 42]) {
    let failure: unknown
    try {
      createDatabase({
        connector: createMockPostgresConnector(),
        schemas: [Users],
        naming: {
          columns: () => {
            throw cause
          },
        },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(SchemaError)
    expect(failure).toHaveProperty('cause', cause)
    expect((failure as Error).message).toMatch(/userId.*users/)
  }
})

it('should reject invalid callback output at public construction before provider creation', () => {
  const connector = createMockPostgresConnector()
  expect(() =>
    createDatabase({ connector, schemas: [Users], naming: { columns: () => '' } }),
  ).toThrow(SchemaError)

  expect(connector.prepared).toEqual([])
})
