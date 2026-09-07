import type { Connector, Statement } from 'db0'
import { pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import {
  QueryError,
  SchemaError,
  column,
  createDatabase,
  defineTable,
  postgresDialect,
} from '@/index'

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

function createMockConnector(options?: {
  onDispose?: () => void | Promise<void>
  onPrepare?: (sql: string) => Statement
}): Connector & { disposed: boolean; prepared: string[] } {
  const prepared: string[] = []

  const prepare = (sql: string) => {
    prepared.push(sql)
    return options?.onPrepare?.(sql) ?? createMockStatement()
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
      await options?.onDispose?.()
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

  it('should close once without error and dispose the connector', async () => {
    const onDispose = vi.fn()
    const connector = createMockConnector({ onDispose })
    const db = createDatabase({ connector, schemas: [] })

    await expect(db.close()).resolves.toBeUndefined()
    expect(connector.disposed).toBe(true)
    expect(onDispose).toHaveBeenCalledTimes(1)

    await expect(db.close()).resolves.toBeUndefined()
    expect(onDispose).toHaveBeenCalledTimes(1)
  })

  it('should dispose via Symbol.asyncDispose', async () => {
    const connector = createMockConnector()

    {
      await using db = createDatabase({ connector, schemas: [] })
      await db.ping()
    }

    expect(connector.disposed).toBe(true)
  })

  it('should reject ping after close with QueryError', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [] })
    await db.close()
    await expect(db.ping()).rejects.toBeInstanceOf(QueryError)
    await expect(db.ping()).rejects.toThrow(/closed/i)
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

describe('registry and from()', () => {
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

  it('should retain registered schemas on the client', () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })
    expect(db.schemas).toEqual([Users])
  })

  it('should compile select * for a registered table without executing', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    const compiled = db.from(Users).compile()
    expect(compiled.sql.toLowerCase()).toContain('select *')
    expect(compiled.sql).toContain('"public"')
    expect(compiled.sql).toContain('"users"')
    expect(compiled.params).toEqual([])
    expect(connector.prepared).toHaveLength(0)

    await db.close()
  })

  it('should execute compiled select via db0', async () => {
    const rows = [{ id: '1', email: 'a@b.com' }]
    const connector = createMockConnector({
      onPrepare: () => createMockStatement(rows),
    })

    const db = createDatabase({ connector, schemas: [Users] })
    await expect(db.from(Users).execute()).resolves.toEqual(rows)

    expect(connector.prepared.some((sql) => /select\s+\*\s+from/i.test(sql))).toBe(true)

    await db.close()
  })

  it('should reject unregistered handles with SchemaError', async () => {
    const Other = defineTable(
      'other',
      { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
      { primaryKey: 'id' },
    )

    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })
    expect(() => db.from(Other)).toThrow(SchemaError)
    expect(() => db.from(Other)).toThrow(/not registered/)

    await db.close()
  })

  it('should reject non-handles in schemas', () => {
    const connector = createMockConnector()
    expect(() =>
      createDatabase({
        connector,
        schemas: [{ name: 'fake' } as never],
      }),
    ).toThrow(SchemaError)
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
    ;(connector as { dialect: string }).dialect = 'sqlite'
    expect(() => createDatabase({ connector, schemas: [] })).toThrow(SchemaError)
    expect(() => createDatabase({ connector, schemas: [] })).toThrow(
      /unsupported connector dialect/i,
    )
  })
})
