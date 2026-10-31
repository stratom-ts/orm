import { nullable, string } from 'valibot'
import { expect, it } from 'vitest'

import type { ReferenceTarget } from '@/index'
import { defineTable, eq, reference } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

it('migrates and queries mutually circular lazy references with enforced foreign keys', async () => {
  const A = defineTable(
    'a',
    {
      id: string(),
      bId: nullable(
        reference(string(), (): ReferenceTarget => B, 'id', { onDelete: 'set null' }),
      ),
    },
    { primaryKey: 'id' },
  )

  const B = defineTable(
    'b',
    {
      id: string(),
      aId: reference(string(), (): ReferenceTarget => A, 'id'),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([B, A], async ({ db, native }) => {
    native.exec('pragma foreign_keys = on')
    expect(native.prepare('pragma foreign_keys').get()).toEqual({ foreign_keys: 1 })
    await db.migrate().execute()
    await db.insert(A).values({ id: 'a', bId: null }).execute()
    await db.insert(B).values({ id: 'b', aId: 'a' }).execute()
    await db.update(A).set({ bId: 'b' }).where(eq(A.id, 'a')).execute()
    expect(await db.from(A).selectAll().execute()).toEqual([{ id: 'a', bId: 'b' }])

    await expect(
      db.insert(B).values({ id: 'invalid', aId: 'missing' }).execute(),
    ).rejects.toMatchObject({ cause: { message: 'FOREIGN KEY constraint failed' } })

    expect((await db.migrate().plan()).steps).toEqual([])
  })
})
