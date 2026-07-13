import { createDb } from '@/client'
import { defineTable } from '@/defineTable'
import { column, table } from '@/schemas'
import { QueryError, SchemaError } from '@/utils/error'
import type { Connector, Statement } from 'db0'
import { object, pipe, string, title } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

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
  const connector = {
    name: 'mock',
    dialect: 'postgresql' as const,
    disposed: false,
    prepared,
    getInstance: () => ({}),
    exec: async () => ({}),
    prepare: (sql: string) => {
      prepared.push(sql)
      return options?.onPrepare?.(sql) ?? createMockStatement()
    },
    dispose: async () => {
      connector.disposed = true
      await options?.onDispose?.()
    },
  }
  return connector
}

describe('createDb', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('accepts a db0 connector and empty schemas', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [] })
    expect(db).toMatchObject({
      ping: expect.any(Function),
      close: expect.any(Function),
    })
    expect(typeof db[Symbol.asyncDispose]).toBe('function')
  })

  it('pings with a trivial select via the owned database', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [] })

    await expect(db.ping()).resolves.toBeUndefined()
    expect(connector.prepared.some((sql) => /select\s+1/i.test(sql))).toBe(true)

    await db.close()
  })

  it('closes once without error and disposes the connector', async () => {
    const onDispose = vi.fn()
    const connector = createMockConnector({ onDispose })
    const db = createDb({ connector, schemas: [] })

    await expect(db.close()).resolves.toBeUndefined()
    expect(connector.disposed).toBe(true)
    expect(onDispose).toHaveBeenCalledTimes(1)

    await expect(db.close()).resolves.toBeUndefined()
    expect(onDispose).toHaveBeenCalledTimes(1)
  })

  it('disposes via Symbol.asyncDispose', async () => {
    const connector = createMockConnector()
    {
      await using db = createDb({ connector, schemas: [] })
      await db.ping()
    }
    expect(connector.disposed).toBe(true)
  })

  it('rejects ping after close with QueryError', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [] })
    await db.close()
    await expect(db.ping()).rejects.toBeInstanceOf(QueryError)
    await expect(db.ping()).rejects.toThrow(/closed/i)
  })

  it('client module surface does not export Kysely symbols', async () => {
    const clientModule = await import('@/client')
    expect(clientModule.createDb).toBeTypeOf('function')
    expect(Object.keys(clientModule).join(',')).not.toMatch(/kysely/i)
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [] })
    await db.close()
  })
})

const Users = defineTable(
  pipe(
    object({
      id: pipe(string(), column({ type: 'text' })),
      email: pipe(string(), column({ type: 'text' })),
    }),
    title('users'),
    table({ name: 'users', primaryKey: 'id', schema: 'public' }),
  ),
)

describe('registry and from()', () => {
  it('retains registered schemas on the client', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    expect(db.schemas).toEqual([Users])
  })

  it('compiles select * for a registered table without executing', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    const compiled = db.from(Users).compile()
    expect(compiled.sql.toLowerCase()).toContain('select *')
    expect(compiled.sql).toContain('"public"')
    expect(compiled.sql).toContain('"users"')
    expect(compiled.params).toEqual([])
    expect(connector.prepared).toHaveLength(0)
    await db.close()
  })

  it('executes compiled select via db0', async () => {
    const rows = [{ id: '1', email: 'a@b.com' }]
    const connector = createMockConnector({
      onPrepare: () => createMockStatement(rows),
    })
    const db = createDb({ connector, schemas: [Users] })
    await expect(db.from(Users).execute()).resolves.toEqual(rows)
    expect(
      connector.prepared.some((sql) => /select\s+\*\s+from/i.test(sql)),
    ).toBe(true)
    await db.close()
  })

  it('rejects unregistered handles with SchemaError', async () => {
    const Other = defineTable(
      pipe(
        object({ id: pipe(string(), column({ type: 'text' })) }),
        title('other'),
        table({ name: 'other', primaryKey: 'id' }),
      ),
    )
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })
    expect(() => db.from(Other)).toThrow(SchemaError)
    expect(() => db.from(Other)).toThrow(/not registered/)
    await db.close()
  })

  it('rejects non-handles in schemas', () => {
    const connector = createMockConnector()
    expect(() =>
      createDb({
        connector,
        schemas: [{ name: 'fake' } as never],
      }),
    ).toThrow(SchemaError)
  })
})

describe('createDb integration', () => {
  const url = process.env.DATABASE_URL

  it.skipIf(!url)(
    'connects to real Postgres, pings, and closes',
    async () => {
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const db = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [],
      })

      await expect(db.ping()).resolves.toBeUndefined()
      await expect(db.close()).resolves.toBeUndefined()
    },
    30_000,
  )

  it.skipIf(!url)(
    'selects from a table created out-of-band',
    async () => {
      const { createDatabase } = await import('db0')
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const setup = createDatabase(postgresql({ url: url as string }))
      const db = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [Users],
      })
      try {
        await setup.exec(
          'create table if not exists "public"."users" ("id" text primary key, "email" text not null)',
        )
        await setup.exec('delete from "public"."users"')
        await setup.exec(
          `insert into "public"."users" ("id", "email") values ('1', 'a@b.com')`,
        )
        const rows = await db.from(Users).execute()
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: '1', email: 'a@b.com' }),
          ]),
        )
      } finally {
        await db.close()
        await setup.dispose()
      }
    },
    30_000,
  )
})
