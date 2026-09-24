import type { Connector, Statement } from 'db0'
import { pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { QueryError, column, createDatabase, defineTable, postgresDialect } from '@/index'

import { createNativePostgresClient } from './helpers/nativePostgresClient'

function createMockStatement(rows: unknown[] = [{ '?column?': 1 }]): Statement {
  const statement: Statement = {
    bind() {
      return statement
    },
    async all() {
      return rows
    },
    async run() {
      return { success: true }
    },
    async get() {
      return rows[0]
    },
  }
  return statement
}

function createMockConnector(): Connector & { disposed: boolean; prepared: string[] } {
  const prepared: string[] = []

  const prepare = (sql: string) => {
    prepared.push(sql)
    return createMockStatement()
  }

  const nativeClient = createNativePostgresClient(prepare)
  const connector = {
    name: 'postgresql',
    dialect: 'postgresql' as const,
    disposed: false,
    prepared,
    getInstance: () => nativeClient,
    exec: async () => ({}),
    prepare,
    dispose: async () => {
      connector.disposed = true
    },
  }
  return connector
}

describe('createDatabase', () => {
  it('should accept a db0 connector and empty schemas', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [] })
    expect(db).toMatchObject({
      ping: expect.any(Function),
      close: expect.any(Function),
    })

    expect(typeof db[Symbol.asyncDispose]).toBe('function')
  })

  it('should ping with a trivial select via the owned database', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [] })

    await expect(db.ping()).resolves.toBeUndefined()
    expect(connector.prepared.some((sql) => /select\s+1/i.test(sql))).toBe(true)

    await db.close()
  })

  it('should export createDatabase and no stray dialect ORM symbols', async () => {
    const clientModule = await import('@/index')
    expect(clientModule.createDatabase).toBeTypeOf('function')
    expect(Object.keys(clientModule).join(',')).not.toMatch(/kysely/i)
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [] })
    await db.close()
  })
})

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

describe('client registration', () => {
  it('rejects duplicate authored relations before opening database work', () => {
    const DuplicateUsers = defineTable(
      'users',
      { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    )
    const connector = createMockConnector()
    const getInstance = vi.spyOn(connector, 'getInstance')

    expect(() => createDatabase({ connector, schemas: [Users, DuplicateUsers] })).toThrow(
      expect.objectContaining({
        _tag: 'SchemaError',
        message: expect.stringContaining('[schema:"public", relation:"users"]'),
      }),
    )

    expect(getInstance).not.toHaveBeenCalled()
    expect(connector.prepared).toEqual([])
  })

  it('allows equal relation names in different structured namespaces', async () => {
    const AppUsers = defineTable(
      'users',
      { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'app' }] },
    )
    const TenantUsers = defineTable(
      'users',
      { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'tenant' }] },
    )
    const db = createDatabase({
      connector: createMockConnector(),
      schemas: [AppUsers, TenantUsers],
    })

    expect(() => db.from(AppUsers)).not.toThrow()
    expect(() => db.from(TenantUsers)).not.toThrow()
    const Missing = defineTable(
      'users',
      { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
      {
        primaryKey: 'id',
        namespace: [
          { role: 'catalog', spelling: 'app' },
          { role: 'database', spelling: 'tenant' },
          { role: 'schema', spelling: 'missing' },
        ],
      },
    )
    expect(() => db.from(Missing)).toThrow(
      '[catalog:"app", database:"tenant", schema:"missing", relation:"users"]',
    )

    await db.close()
  })

  it('keeps dotted namespace and relation boundaries independent through the public handle seam', async () => {
    const DottedNamespace = defineTable(
      'c',
      { id: string() },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a.b' }] },
    )
    const DottedRelation = defineTable(
      'b.c',
      { id: string() },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'a' }] },
    )
    const SameSchema = defineTable(
      'same_relation',
      { id: string() },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'shared' }] },
    )
    const SameDatabase = defineTable(
      'same_relation',
      { id: string() },
      { primaryKey: 'id', namespace: [{ role: 'database', spelling: 'shared' }] },
    )
    const connector = createMockConnector()
    const db = createDatabase({
      connector,
      schemas: [DottedNamespace, DottedRelation, SameSchema, SameDatabase],
    })

    expect(() => db.from(DottedNamespace)).not.toThrow()
    expect(() => db.from(DottedRelation)).not.toThrow()
    expect(() => db.from(SameSchema)).not.toThrow()
    expect(() => db.from(SameDatabase)).not.toThrow()
    expect(connector.prepared).toEqual([])

    await db.close()
  })

  it('should retain registered schemas on the client', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })
    expect(db.schemas).toEqual([Users])
  })

  it('should reject non-handles in schemas', () => {
    const connector = createMockConnector()
    const getInstance = vi.spyOn(connector, 'getInstance')

    expect(() =>
      createDatabase({
        connector,
        schemas: [{ name: 'fake' } as never],
      }),
    ).toThrow(expect.objectContaining({ _tag: 'SchemaError' }))

    expect(getInstance).not.toHaveBeenCalled()
    expect(connector.prepared).toEqual([])
  })

  it('should resolve dialect from connector.dialect', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })
    const compiled = db.from(Users).compile()
    expect(compiled.sql).toContain('"public"')
    expect(compiled.sql).toContain('"users"')
  })

  it('passes the exact connector to the selected dialect operation provider', async () => {
    const connector = createMockConnector()
    const createProvider = vi.spyOn(postgresDialect.operations, 'createSessionProvider')

    const db = createDatabase({ connector, schemas: [] })

    expect(createProvider).toHaveBeenCalledTimes(1)
    expect(createProvider).toHaveBeenCalledWith(connector)
    await db.close()
    createProvider.mockRestore()
  })

  it('does not call the dialect provider when an explicit provider is supplied', async () => {
    const connector = createMockConnector()
    const createProvider = vi.spyOn(postgresDialect.operations, 'createSessionProvider')
    const provider = {
      nativeTransactions: true as const,
      open: vi.fn(),
      close: vi.fn(async () => undefined),
    }

    const db = createDatabase({
      connector,
      schemas: [Users],
      operationSessionProvider: provider,
    })

    expect(createProvider).not.toHaveBeenCalled()
    expect(db.from(Users).compile().sql).toContain('"public"')
    await db.close()
    expect(provider.close).toHaveBeenCalledOnce()
    expect(connector.disposed).toBe(false)
    createProvider.mockRestore()
  })

  it('rejects an invalid automatic connector/member combination before database work', () => {
    const connector = createMockConnector()
    const getInstance = vi.spyOn(connector, 'getInstance')
    ;(connector as { name: string }).name = 'custom'

    expect(() => createDatabase({ connector, schemas: [] })).toThrow(QueryError)

    expect(() => createDatabase({ connector, schemas: [] })).toThrow(
      /automatic operation sessions require/i,
    )

    expect(getInstance).not.toHaveBeenCalled()
    expect(connector.prepared).toHaveLength(0)
  })

  it('should reject unsupported connector dialects', () => {
    const connector = createMockConnector()
    const getInstance = vi.spyOn(connector, 'getInstance')
    ;(connector as { dialect: string }).dialect = 'sqlite'

    expect(() => createDatabase({ connector, schemas: [] })).toThrow(
      expect.objectContaining({
        _tag: 'SchemaError',
        message: expect.stringMatching(/unsupported connector dialect/i),
      }),
    )

    expect(getInstance).not.toHaveBeenCalled()
    expect(connector.prepared).toEqual([])
  })
})
