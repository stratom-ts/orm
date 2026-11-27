import { number } from 'valibot'
import { expect, it, vi } from 'vitest'

import { QueryError, defineTable } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

const Items = defineTable('cursor_items', { id: number() }, { primaryKey: 'id' })
it('should reject cursor terminals on a native SQLite transaction before invoking user code', async () => {
  await withSqliteDatabase([Items], async ({ db }) => {
    const callback = vi.fn<() => Promise<void>>(async () => undefined)
    await db.transaction(async (tx) => {
      await expect(tx.from(Items).withCursor(callback)).rejects.toBeInstanceOf(QueryError)
      await expect(tx.from(Items).batches().next()).rejects.toBeInstanceOf(QueryError)
      await tx.ping()
    })

    expect(callback).not.toHaveBeenCalled()
  })
})
