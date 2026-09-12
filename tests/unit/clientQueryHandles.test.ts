import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'

import { createMockPostgresConnector } from './helpers/nativePostgresClient'

const Accounts = defineTable(
  'accounts',
  { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'billing' }] },
)

const AuditEvents = defineTable(
  'events',
  { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'audit' }] },
)

type QueryRoot = 'from' | 'insert' | 'update' | 'delete'

function startQuery(
  db: ReturnType<typeof createDatabase>,
  method: QueryRoot,
  value: never,
) {
  switch (method) {
    case 'from':
      return db.from(value)
    case 'insert':
      return db.insert(value)
    case 'update':
      return db.update(value)
    case 'delete':
      return db.delete(value)
  }
}

describe('client query table handles', () => {
  it.each<QueryRoot>(['from', 'insert', 'update', 'delete'])(
    '%s rejects a non-handle with a tagged schema error before database work',
    async (method) => {
      const connector = createMockPostgresConnector()
      const db = createDatabase({ connector, schemas: [Accounts] })

      expect(() => startQuery(db, method, { relation: 'accounts' } as never)).toThrow(
        expect.objectContaining({
          _tag: 'SchemaError',
          message: expect.stringContaining(`db.${method}()`),
        }),
      )
      expect(connector.prepared).toEqual([])
      await db.close()
    },
  )

  it.each<QueryRoot>(['from', 'insert', 'update', 'delete'])(
    '%s rejects an unregistered handle with the same tagged error contract before database work',
    async (method) => {
      const connector = createMockPostgresConnector()
      const db = createDatabase({ connector, schemas: [Accounts] })

      expect(() => startQuery(db, method, AuditEvents as never)).toThrow(
        expect.objectContaining({
          _tag: 'SchemaError',
          message: expect.stringMatching(/not registered/i),
        }),
      )
      expect(connector.prepared).toEqual([])
      await db.close()
    },
  )
})
