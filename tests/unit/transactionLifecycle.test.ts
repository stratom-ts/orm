import { pipe, string } from 'valibot'
import { describe, expect, it } from 'vitest'

import { column, createDatabase, defineTable } from '@/index'

import { createMockPostgresConnector } from './dialects/postgresNativeClientFixtures'

const Accounts = defineTable(
  'accounts',
  { id: pipe(string(), column({ physicalType: { postgresql: 'text' } })) },
  { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'billing' }] },
)

describe('transaction client lifecycle', () => {
  it('should expire a transaction client and a builder captured from its callback', async () => {
    const connector = createMockPostgresConnector()
    const db = createDatabase({ connector, schemas: [Accounts] })
    let scopedClient: typeof db | undefined
    let scopedQuery: ReturnType<typeof db.from> | undefined

    await db.transaction(async (trx) => {
      scopedClient = trx
      scopedQuery = trx.from(Accounts)
    })

    expect(() => scopedClient!.from(Accounts)).toThrow(/no longer active/i)
    await expect(scopedQuery!.execute()).rejects.toMatchObject({ _tag: 'QueryError' })
    await db.close()
  })
})
