import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { number, string } from 'valibot'
import { expect, expectTypeOf, it } from 'vitest'

import type { WriteResult } from '@/index'
import { InvariantError, createDatabase, defineTable } from '@/index'

import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

const Records = defineTable(
  'records',
  { id: number(), label: string() },
  { primaryKey: 'id' },
)

const Counted = defineTable('counted', { rowCount: number() }, { primaryKey: 'rowCount' })

it.each(['insert', 'update', 'delete'] as const)(
  'keeps numeric rowCount columns distinct from %s write counts',
  async (operation) => {
    const db = createDatabase({
      connector: nodeSqliteConnector({ name: ':memory:' }),
      schemas: [Counted],
    })

    try {
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
    } finally {
      await db.close()
    }
  },
)

/** Creates a client whose custom provider supplies the selected native count. */
function countDatabase(rowCount?: number) {
  return createDatabase({
    connector: customConnector(),
    schemas: [Records],
    operationSessionProvider: createControllableProvider({ rowCount }).provider,
  })
}

it('preserves counts and write-result types through every terminal', async () => {
  const db = countDatabase(7)
  try {
    const insert = db.insert(Records).values({ id: 1, label: 'one' }).returningNone()

    const update = db
      .update(Records)
      .set({ label: 'changed' })
      .returningNone()
      .where({ id: 1 })

    const remove = db.delete(Records).returningNone().where({ id: 1 })

    expectTypeOf<ReturnType<typeof insert.execute>>().toEqualTypeOf<
      Promise<WriteResult>
    >()

    expectTypeOf<ReturnType<typeof update.execute>>().toEqualTypeOf<
      Promise<WriteResult>
    >()

    expectTypeOf<ReturnType<typeof remove.execute>>().toEqualTypeOf<
      Promise<WriteResult>
    >()

    expectTypeOf<ReturnType<typeof insert.executeTakeFirst>>().toEqualTypeOf<
      Promise<WriteResult>
    >()

    expectTypeOf<ReturnType<typeof update.executeTakeFirstOrThrow>>().toEqualTypeOf<
      Promise<WriteResult>
    >()

    await expect(insert.execute()).resolves.toEqual({ rowCount: 7 })
    await expect(update.executeTakeFirst()).resolves.toEqual({ rowCount: 7 })
    await expect(remove.executeTakeFirstOrThrow()).resolves.toEqual({ rowCount: 7 })
  } finally {
    await db.close()
  }
})

it('clears returning immutably and preserves conflict and filter chains', async () => {
  const db = countDatabase(0)
  try {
    const insert = db.insert(Records).values({ id: 1, label: 'one' }).returningAll()

    const update = db
      .update(Records)
      .set({ label: 'changed' })
      .where({ id: 1 })
      .returning([Records.id])

    const remove = db.delete(Records).where({ id: 1 }).returningAll()

    for (const builder of [insert, update, remove]) {
      expect(builder.compile().sql).toMatch(/returning/i)
      expect(builder.returningNone().compile().sql).not.toMatch(/returning/i)
      expect(builder.compile().sql).toMatch(/returning/i)
    }

    expect(update.returningNone().compile().sql).toMatch(/where/i)
    expect(remove.returningNone().compile().sql).toMatch(/where/i)
    const upsert = insert.returningNone().onConflict([Records.id]).doNothing()
    expect(upsert.compile().sql).toMatch(/on conflict/i)
    await expect(upsert.execute()).resolves.toEqual({ rowCount: 0 })
    expect(upsert.returningAll().compile().sql).toMatch(/returning/i)
  } finally {
    await db.close()
  }
})

it.each([undefined, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'rejects missing or invalid provider count %s as an invariant defect',
  async (rowCount) => {
    const db = countDatabase(rowCount)
    try {
      const writes = [
        db.insert(Records).values({ id: 1, label: 'one' }).returningNone(),
        db.update(Records).set({ label: 'changed' }).where({ id: 1 }).returningNone(),
        db.delete(Records).where({ id: 1 }).returningNone(),
        db
          .insert(Records)
          .values({ id: 1, label: 'one' })
          .onConflict([Records.id])
          .doNothing()
          .returningNone(),
      ]

      for (const write of writes) {
        const failure = await write.execute().catch((cause: unknown) => cause)
        expect(failure).toBeInstanceOf(InvariantError)

        expect(failure).toMatchObject({
          message:
            'Write execution requires a nonnegative safe integer affected-row count',
        })
      }
    } finally {
      await db.close()
    }
  },
)
