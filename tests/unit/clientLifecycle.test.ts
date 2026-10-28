import { pipe, string } from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import { QueryError, SchemaError, column, createDatabase, defineTable } from '@/index'

import { createMockPostgresConnector } from './dialects/postgresNativeClientFixtures'

const Accounts = defineTable(
  'accounts',
  { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'billing' }] },
)

describe('client lifecycle', () => {
  it.each([
    ['empty', ''],
    ['NUL-containing', 'billing\0worker'],
    ['unpaired-surrogate', '\ud800'],
    ['non-string', 42],
  ])(
    'should reject a %s application identity before opening database work',
    (_, applicationId) => {
      const connector = createMockPostgresConnector()
      const getInstance = vi.spyOn(connector, 'getInstance')

      expect(() =>
        createDatabase({
          connector,
          schemas: [Accounts],
          applicationId: applicationId as string,
        }),
      ).toThrow(SchemaError)

      expect(getInstance).not.toHaveBeenCalled()
      expect(connector.prepared).toEqual([])
    },
  )

  it('should return one close operation and dispose the connector only once', async () => {
    const connector = createMockPostgresConnector()
    const dispose = vi.spyOn(connector, 'dispose')
    const db = createDatabase({ connector, schemas: [Accounts] })

    const first = db.close()
    const concurrent = db.close()

    expect(concurrent).toBe(first)
    await expect(first).resolves.toBeUndefined()
    await expect(db.close()).resolves.toBeUndefined()
    expect(connector.disposed).toBe(true)
    expect(dispose).toHaveBeenCalledOnce()
  })
})

describe('client lifecycle: closes the client through asynchronous disposal', () => {
  it('should close the client through asynchronous disposal', async () => {
    const connector = createMockPostgresConnector()

    {
      await using db = createDatabase({ connector, schemas: [Accounts] })
      await db.ping()
    }

    expect(connector.disposed).toBe(true)
  })

  it('should reject every root operation after close instead of building stale work', async () => {
    const connector = createMockPostgresConnector()
    const db = createDatabase({ connector, schemas: [Accounts] })
    await db.close()

    expect(() => db.from(Accounts)).toThrow(QueryError)
    expect(() => db.insert(Accounts)).toThrow(QueryError)
    expect(() => db.update(Accounts)).toThrow(QueryError)
    expect(() => db.delete(Accounts)).toThrow(QueryError)
    expect(() => db.migrate()).toThrow(QueryError)
    await expect(db.ping()).rejects.toMatchObject({ _tag: 'QueryError' })

    await expect(db.transaction(async () => undefined)).rejects.toMatchObject({
      _tag: 'QueryError',
    })

    expect(connector.prepared).toEqual([])
  })
})

describe('client lifecycle: rejects root and scoped close calls during active transaction work', () => {
  it('should reject root and scoped close calls during active transaction work', async () => {
    const connector = createMockPostgresConnector()
    const db = createDatabase({ connector, schemas: [Accounts] })

    await db.transaction(async (trx) => {
      await expect(trx.close()).rejects.toMatchObject({
        _tag: 'QueryError',
        message: expect.stringMatching(/transaction clients cannot close/i) as unknown,
      })

      await expect(db.close()).rejects.toMatchObject({
        _tag: 'QueryError',
        message: expect.stringMatching(/inside an active operation callback/i) as unknown,
      })
    })

    await expect(db.close()).resolves.toBeUndefined()
  })
})
