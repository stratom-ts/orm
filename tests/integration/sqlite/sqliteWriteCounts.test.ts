import { number } from 'valibot'
import { expect, expectTypeOf, it } from 'vitest'

import type { WriteResult } from '@/index'
import { defineTable } from '@/index'

import { withSqliteDatabase } from './sqliteIntegration'

const Counted = defineTable('counted', { rowCount: number() }, { primaryKey: 'rowCount' })

it.each(['insert', 'update', 'delete'] as const)(
  'should keep numeric rowCount columns distinct from %s write counts',
  async (operation) => {
    await withSqliteDatabase([Counted], async ({ db }) => {
      await db.migrate().execute()
      await db.insert(Counted).values({ rowCount: 11 }).execute()
      const writes = {
        insert: db
          .insert(Counted)
          .values({ rowCount: 11 })
          .onConflict([Counted.rowCount])
          .doUpdate({ rowCount: 11 }),
        update: db.update(Counted).set({ rowCount: 11 }).all(),
        delete: db.delete(Counted).all(),
      }

      const original = writes[operation]
      const count = original.returningNone()
      for (const write of [
        original,
        count.returningAll(),
        count.returning([Counted.rowCount]),
      ]) {
        expectTypeOf<ReturnType<typeof write.execute>>().toEqualTypeOf<
          Promise<{ rowCount: number }[]>
        >()

        expectTypeOf<ReturnType<typeof write.executeTakeFirst>>().toEqualTypeOf<
          Promise<{ rowCount: number } | undefined>
        >()

        expectTypeOf<ReturnType<typeof write.executeTakeFirstOrThrow>>().toEqualTypeOf<
          Promise<{ rowCount: number }>
        >()

        expect(write.compile().sql).toMatch(/returning/i)
        expect(await write.execute()).toBeInstanceOf(Array)
      }

      expectTypeOf<ReturnType<typeof count.execute>>().toEqualTypeOf<
        Promise<WriteResult>
      >()

      await expect(count.execute()).resolves.toEqual({
        rowCount: operation === 'delete' ? 0 : 1,
      })

      expect(original.compile().sql).toMatch(/returning/i)
    })
  },
)
