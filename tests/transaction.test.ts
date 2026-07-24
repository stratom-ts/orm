import { createDb } from '@/client'
import { defineTable } from '@/defineTable'
import { column } from '@/schemas'
import type { Connector, Statement } from 'db0'
import { date, number, pipe, string, unknown } from 'valibot'
import { afterEach, describe, expect, it, vi } from 'vitest'

function createMockStatement(rows: unknown[] = []): Statement {
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
  onPrepare?: (sql: string) => Statement
  rowsBySql?: (sql: string) => unknown[]
}): Connector & {
  disposed: boolean
  prepared: string[]
  binds: unknown[][]
} {
  const prepared: string[] = []
  const binds: unknown[][] = []
  const connector = {
    name: 'mock',
    dialect: 'postgresql' as const,
    disposed: false,
    prepared,
    binds,
    getInstance: () => ({}),
    exec: async () => ({}),
    prepare: (sql: string) => {
      prepared.push(sql)
      const base =
        options?.onPrepare?.(sql) ??
        createMockStatement(options?.rowsBySql?.(sql) ?? [])
      return {
        bind(...params: unknown[]) {
          binds.push(params)
          return base.bind(...(params as never[]))
        },
        all: () => base.all(),
        run: () => base.run(),
        get: () => base.get(),
      }
    },
    dispose: async () => {
      connector.disposed = true
    },
  }
  return connector
}

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ type: 'text' })),
    email: pipe(string(), column({ type: 'text' })),
  },
  { primaryKey: 'id', schema: 'public' },
)

const Mapped = defineTable(
  'mapped',
  {
    id: pipe(string(), column({ type: 'uuid' })),
    createdAt: pipe(date(), column({ type: 'timestamptz' })),
    meta: pipe(unknown(), column({ type: 'jsonb' })),
    label: pipe(
      string(),
      column({
        type: 'text',
        mapParam: (v) => String(v).toUpperCase(),
        mapResult: (v) => `read:${String(v)}`,
      }),
    ),
  },
  { primaryKey: 'id', schema: 'public' },
)

describe('db.transaction', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('begins and commits on success', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    const result = await db.transaction(async (trx) => {
      expect(typeof trx.from).toBe('function')
      expect(typeof trx.transaction).toBe('function')
      await trx.insert(Users).values({ id: '1', email: 'a@b.com' }).execute()
      return 42
    })

    expect(result).toBe(42)
    const sql = connector.prepared.map((s) => s.toLowerCase())
    expect(sql.some((s) => s === 'begin')).toBe(true)
    expect(sql.some((s) => s === 'commit')).toBe(true)
    expect(sql.some((s) => s === 'rollback')).toBe(false)
    await db.close()
  })

  it('rolls back when the callback throws', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    await expect(
      db.transaction(async (trx) => {
        await trx.insert(Users).values({ id: '1', email: 'a@b.com' }).execute()
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const sql = connector.prepared.map((s) => s.toLowerCase())
    expect(sql.some((s) => s === 'begin')).toBe(true)
    expect(sql.some((s) => s === 'rollback')).toBe(true)
    expect(sql.some((s) => s === 'commit')).toBe(false)
    await db.close()
  })

  it('uses savepoints for nested transactions', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    await db.transaction(async (trx) => {
      await trx.insert(Users).values({ id: '1', email: 'a@b.com' }).execute()
      await expect(
        trx.transaction(async (inner) => {
          await inner
            .insert(Users)
            .values({ id: '2', email: 'b@b.com' })
            .execute()
          throw new Error('inner fail')
        }),
      ).rejects.toThrow('inner fail')
      // outer continues after inner rollback to savepoint
      await trx.insert(Users).values({ id: '3', email: 'c@b.com' }).execute()
    })

    const sql = connector.prepared.map((s) => s.toLowerCase())
    expect(sql.some((s) => s === 'begin')).toBe(true)
    expect(sql.some((s) => s.includes('savepoint sp_1'))).toBe(true)
    expect(sql.some((s) => s.includes('rollback to savepoint sp_1'))).toBe(true)
    expect(sql.some((s) => s.includes('release savepoint sp_1'))).toBe(true)
    expect(sql.some((s) => s === 'commit')).toBe(true)
    await db.close()
  })

  it('releases savepoint when nested transaction succeeds', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Users] })

    await db.transaction(async (trx) => {
      await trx.transaction(async (inner) => {
        await inner
          .insert(Users)
          .values({ id: '1', email: 'a@b.com' })
          .execute()
      })
    })

    const sql = connector.prepared.map((s) => s.toLowerCase())
    expect(
      sql.filter((s) => s.includes('savepoint sp_1')).length,
    ).toBeGreaterThanOrEqual(1)
    expect(sql.some((s) => s.includes('release savepoint sp_1'))).toBe(true)
    expect(sql.some((s) => s.includes('rollback to'))).toBe(false)
    expect(sql.some((s) => s === 'commit')).toBe(true)
    await db.close()
  })
})

describe('value mapping', () => {
  it('maps insert params for timestamp/json/uuid via dialect defaults', async () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Mapped] })
    const when = new Date('2024-06-15T12:00:00.000Z')
    const meta = { a: 1 }

    await db
      .insert(Mapped)
      .values({
        id: '550e8400-e29b-41d4-a716-446655440000',
        createdAt: when,
        meta,
        label: 'hello',
      })
      .execute()

    expect(connector.binds.length).toBeGreaterThan(0)
    const params = connector.binds[0]!
    // uuid string, ISO timestamp, JSON string, column mapParam uppercases
    expect(params).toContain('550e8400-e29b-41d4-a716-446655440000')
    expect(params).toContain(when.toISOString())
    expect(params).toContain(JSON.stringify(meta))
    expect(params).toContain('HELLO')
    await db.close()
  })

  it('maps select results for timestamp/json/uuid', async () => {
    const connector = createMockConnector({
      rowsBySql: () => [
        {
          id: '550e8400-e29b-41d4-a716-446655440000',
          createdAt: '2024-06-15T12:00:00.000Z',
          meta: '{"a":1}',
          label: 'world',
        },
      ],
    })
    const db = createDb({ connector, schemas: [Mapped] })
    const rows = await db.from(Mapped).execute()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.id).toBe('550e8400-e29b-41d4-a716-446655440000')
    expect(row.createdAt).toBeInstanceOf(Date)
    expect((row.createdAt as Date).toISOString()).toBe(
      '2024-06-15T12:00:00.000Z',
    )
    expect(row.meta).toEqual({ a: 1 })
    expect(row.label).toBe('read:world')
    await db.close()
  })

  it('applies createDb map overrides over dialect defaults', async () => {
    const connector = createMockConnector({
      rowsBySql: () => [
        {
          id: 'x',
          createdAt: '2024-01-01T00:00:00.000Z',
          meta: { n: 1 },
          label: 'z',
        },
      ],
    })
    const db = createDb({
      connector,
      schemas: [Mapped],
      map: {
        mapResultValue(dataType: string, value: unknown) {
          if (dataType === 'timestamptz' || dataType === 'timestamp') {
            return `as-string:${String(value)}`
          }
          return value
        },
      },
    })
    // Column mapResult for label still wins over createDb
    const rows = await db.from(Mapped).execute()
    expect(rows[0]!.createdAt).toBe('as-string:2024-01-01T00:00:00.000Z')
    expect(rows[0]!.label).toBe('read:z')
    await db.close()
  })

  it('compile applies param mapping', () => {
    const connector = createMockConnector()
    const db = createDb({ connector, schemas: [Mapped] })
    const when = new Date('2024-01-02T00:00:00.000Z')
    const compiled = db
      .insert(Mapped)
      .values({
        id: 'u',
        createdAt: when,
        meta: { k: true },
        label: 'ab',
      })
      .compile()
    expect(compiled.params).toContain(when.toISOString())
    expect(compiled.params).toContain(JSON.stringify({ k: true }))
    expect(compiled.params).toContain('AB')
  })
})

describe('transaction + mapping integration', () => {
  const url = process.env.DATABASE_URL

  it.skipIf(!url)(
    'commits and rolls back on real Postgres',
    async () => {
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const { createDatabase } = await import('db0')
      const setup = createDatabase(postgresql({ url: url as string }))
      const TxItems = defineTable(
        'tx_items',
        {
          id: pipe(number(), column({ type: 'integer' })),
          name: pipe(string(), column({ type: 'text' })),
        },
        { primaryKey: 'id', schema: 'public' },
      )
      const db = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [TxItems],
      })
      try {
        await setup.exec(
          'create table if not exists "public"."tx_items" ("id" integer primary key, "name" text not null)',
        )
        await setup.exec('delete from "public"."tx_items"')

        await db.transaction(async (trx) => {
          await trx.insert(TxItems).values({ id: 1, name: 'kept' }).execute()
        })

        await expect(
          db.transaction(async (trx) => {
            await trx
              .insert(TxItems)
              .values({ id: 2, name: 'rolled' })
              .execute()
            throw new Error('abort')
          }),
        ).rejects.toThrow('abort')

        const rows = await db.from(TxItems).execute()
        expect(rows).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: 1, name: 'kept' }),
          ]),
        )
        expect(rows.some((r) => r.id === 2)).toBe(false)

        // nested savepoint: inner fails, outer commits
        await db.transaction(async (trx) => {
          await trx.insert(TxItems).values({ id: 3, name: 'outer' }).execute()
          await expect(
            trx.transaction(async (inner) => {
              await inner
                .insert(TxItems)
                .values({ id: 4, name: 'inner' })
                .execute()
              throw new Error('inner')
            }),
          ).rejects.toThrow('inner')
        })

        const after = await db.from(TxItems).execute()
        expect(after.some((r) => r.id === 3)).toBe(true)
        expect(after.some((r) => r.id === 4)).toBe(false)
      } finally {
        await db.close()
        await setup.dispose()
      }
    },
    30_000,
  )

  it.skipIf(!url)(
    'round-trips timestamp/jsonb/uuid with default mapping',
    async () => {
      const { default: postgresql } = await import('db0/connectors/postgresql')
      const { createDatabase } = await import('db0')
      const setup = createDatabase(postgresql({ url: url as string }))
      const RoundTrip = defineTable(
        'map_roundtrip',
        {
          id: pipe(string(), column({ type: 'uuid' })),
          createdAt: pipe(date(), column({ type: 'timestamptz' })),
          meta: pipe(unknown(), column({ type: 'jsonb' })),
        },
        { primaryKey: 'id', schema: 'public' },
      )
      const db = createDb({
        connector: postgresql({ url: url as string }),
        schemas: [RoundTrip],
      })
      try {
        await setup.exec(
          'create table if not exists "public"."map_roundtrip" ("id" uuid primary key, "createdAt" timestamptz not null, "meta" jsonb not null)',
        )
        await setup.exec('delete from "public"."map_roundtrip"')
        const when = new Date('2025-03-01T10:30:00.000Z')
        const id = '550e8400-e29b-41d4-a716-446655440000'
        await db
          .insert(RoundTrip)
          .values({ id, createdAt: when, meta: { ok: true } })
          .execute()
        const rows = await db.from(RoundTrip).execute()
        const row = rows.find((r) => r.id === id)
        expect(row).toBeDefined()
        expect(row!.id).toBe(id)
        expect(row!.createdAt).toBeInstanceOf(Date)
        expect((row!.createdAt as Date).toISOString()).toBe(when.toISOString())
        expect(row!.meta).toEqual({ ok: true })
      } finally {
        await db.close()
        await setup.dispose()
      }
    },
    30_000,
  )
})
