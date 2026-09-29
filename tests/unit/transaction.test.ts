import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { MigrationError, column, createDatabase, defineTable } from '@/index'

import { createMockPostgresConnector as createMockConnector } from './helpers/nativePostgresClient'

const Users = defineTable(
  'users',
  {
    id: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
    email: pipe(string(), column({ physicalType: { postgresql: 'text' } })),
  },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
)

describe('db.transaction', () => {
  it('should begin and commit on success', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

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

  it('should roll back when the callback throws', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

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

  it('should use savepoints for nested transactions', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    await db.transaction(async (trx) => {
      await trx.insert(Users).values({ id: '1', email: 'a@b.com' }).execute()

      await expect(
        trx.transaction(async (inner) => {
          await inner.insert(Users).values({ id: '2', email: 'b@b.com' }).execute()
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

  it('should release savepoint when nested transaction succeeds', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    await db.transaction(async (trx) => {
      await trx.transaction(async (inner) => {
        await inner.insert(Users).values({ id: '1', email: 'a@b.com' }).execute()
      })
    })

    const sql = connector.prepared.map((s) => s.toLowerCase())

    expect(sql.filter((s) => s.includes('savepoint sp_1')).length).toBeGreaterThanOrEqual(
      1,
    )

    expect(sql.some((s) => s.includes('release savepoint sp_1'))).toBe(true)
    expect(sql.some((s) => s.includes('rollback to'))).toBe(false)
    expect(sql.some((s) => s === 'commit')).toBe(true)

    await db.close()
  })

  it('should serialize concurrent top-level transactions', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })
    let releaseFirst!: () => void
    let markFirstStarted!: () => void
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve
    })

    const first = db.transaction(async () => {
      markFirstStarted()
      await firstCanFinish
      throw new Error('first failed')
    })
    await firstStarted

    const second = db.transaction(async (trx) => {
      await trx.insert(Users).values({ id: '2', email: 'second@example.com' }).execute()
      return 'second committed'
    })

    await Promise.resolve()

    expect(
      connector.prepared.filter((sql) => sql.toLowerCase() === 'begin'),
    ).toHaveLength(1)

    releaseFirst()
    await expect(first).rejects.toThrow('first failed')
    await expect(second).resolves.toBe('second committed')

    const transactionSql = connector.prepared
      .map((sql) => sql.toLowerCase())
      .filter((sql) => ['begin', 'commit', 'rollback'].includes(sql))

    expect(transactionSql).toEqual(['begin', 'rollback', 'begin', 'commit'])
    await db.close()
  })

  it('should reject migrations inside a transaction before acquiring a lock', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })
    const migrationCreatedBeforeTransaction = db.migrate()

    await expect(
      db.transaction(async (trx) => {
        await trx.insert(Users).values({ id: '1', email: 'a@b.com' }).execute()
        await migrationCreatedBeforeTransaction.execute()
      }),
    ).rejects.toBeInstanceOf(MigrationError)

    const sql = connector.prepared.map((s) => s.toLowerCase())
    expect(sql).toContain('begin')
    expect(sql).toContain('rollback')
    expect(sql).not.toContain('commit')
    expect(sql.some((s) => s.includes('pg_advisory_lock'))).toBe(false)

    await db.close()
  })

  it('should reject migrations from nested transaction clients', async () => {
    const connector = createMockConnector()
    const db = createDatabase({ connector, schemas: [Users] })

    await db.transaction(async (trx) => {
      await expect(trx.migrate().execute()).rejects.toBeInstanceOf(MigrationError)

      await trx.transaction(async (nested) => {
        await expect(nested.migrate().execute()).rejects.toBeInstanceOf(MigrationError)
      })
    })

    const sql = connector.prepared.map((s) => s.toLowerCase())
    expect(sql.some((s) => s.includes('pg_advisory_lock'))).toBe(false)
    expect(sql.some((s) => s.includes('savepoint sp_1'))).toBe(true)
    expect(sql).toContain('commit')

    await db.close()
  })
})
