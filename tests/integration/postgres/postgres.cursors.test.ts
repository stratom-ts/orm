import { setTimeout } from 'node:timers/promises'
import type { Client } from 'pg'
import { date, number, pipe, string } from 'valibot'
import { expect, expectTypeOf, it } from 'vitest'

import { column, defineTable, eq } from '@/index'
import type { Cursor, Db } from '@/index'

import { deferred } from '../../helpers/deferredPromise'

import { withPostgresDatabase } from './postgresIntegration'

const Items = defineTable(
  'cursor_items',
  {
    id: number(),
    label: pipe(string(), column({ name: 'physical_label' })),
    created: date(),
  },
  { primaryKey: 'id' },
)

const rows = [1, 2, 3, 4].map((id) => ({
  id,
  label: `item ${id}`,
  created: new Date('2026-01-01Z'),
}))

it('should fetch bounded batches on one physical session and removes server cursors on early exit', async () => {
  const events: { sql: string; physicalSession: string }[] = []
  await withPostgresDatabase(
    [Items],
    async ({ db }) => {
      await db.migrate().execute()
      await db.insert(Items).values(rows).execute()
      events.length = 0

      await db.transaction(async (tx) => {
        const iterator = tx.from(Items).orderBy(Items.id).batches({ batchSize: 2 })
        expect(events.some((e) => e.sql.startsWith('DECLARE'))).toBe(false)
        expect((await iterator.next()).value).toEqual(rows.slice(0, 2))
        await tx.ping()
        await iterator.return?.()

        expect(
          await tx.sql`select name from pg_cursors where name like 'stratom_cursor_%'`,
        ).toEqual([])

        await tx
          .insert(Items)
          .values({ ...rows[0], id: 5 })
          .execute()
      })

      const commands = events.filter((e) => /^(DECLARE|FETCH|CLOSE)/.test(e.sql))
      expect(commands.map((e) => e.sql.split(' ')[0])).toEqual([
        'DECLARE',
        'FETCH',
        'CLOSE',
      ])

      expect(new Set(events.map((e) => e.physicalSession)).size).toBe(1)
      expect(await db.from(Items).where({ id: 5 }).execute()).toHaveLength(1)
    },
    {
      hooks: {
        before(event) {
          events.push(event)
        },
      },
    },
  )
})

it.each([0, 1, 3, 4])(
  'should handle %s rows without empty batches or repeats',
  async (count) => {
    await withPostgresDatabase([Items], async ({ db }) => {
      await db.migrate().execute()
      await db.insert(Items).values(rows).execute()

      await db.transaction(async (tx) => {
        const batches = []
        for await (const batch of tx
          .from(Items)
          .where((b) => b.lte(Items.id, count))
          .orderBy(Items.id)
          .batches({ batchSize: 2 }))
          batches.push(batch)
        expect(batches.flat()).toEqual(rows.slice(0, count))
        expect(batches.every((batch) => batch.length > 0 && batch.length <= 2)).toBe(true)
      })
    })
  },
)

it('should support variable concurrent fetches, exhaustion, independent cursors, and callback results', async () => {
  await withPostgresDatabase([Items], async ({ db }) => {
    await db.migrate().execute()
    await db.insert(Items).values(rows).execute()
    let escaped!: Cursor<(typeof rows)[number]>
    const result = await db.transaction((tx) =>
      tx
        .from(Items)
        .orderBy(Items.id)
        .withCursor(async (cursor) => {
          escaped = cursor
          const [first, second] = await Promise.all([cursor.fetch(1), cursor.fetch(2)])
          expect(first).toEqual(rows.slice(0, 1))
          expect(second).toEqual(rows.slice(1, 3))

          await tx
            .from(Items)
            .orderBy(Items.id)
            .withCursor(async (other) => {
              expect(await other.fetch(1)).toEqual(rows.slice(0, 1))
            })

          expect(await cursor.fetch(10)).toEqual(rows.slice(3))
          expect(await cursor.fetch(1)).toEqual([])
          expect(await cursor.fetch(1)).toEqual([])
          return 'done' as const
        }),
    )

    expect(result).toBe('done')
    await expect(escaped.fetch(1)).rejects.toThrow(/closed/)
  })
})

it('should preserve aliases, expressions, CTEs and compound selection mapping', async () => {
  await withPostgresDatabase([Items], async ({ db }) => {
    await db.migrate().execute()
    await db.insert(Items).values(rows).execute()

    await db.transaction(async (tx) => {
      const selected = tx
        .from(Items)
        .select((b) => [
          Items.id,
          b.as(Items.label, 'name'),
          b.as(b.upper(Items.label), 'upperName'),
          Items.created,
        ])

      const cte = tx.cte('chosen', selected.where(eq(Items.id, 2)))
      const query = tx.with(cte).from(cte)
      const expected = await query.execute()
      await query.withCursor(async (cursor) => {
        const actual = await cursor.fetch(2)
        expectTypeOf(actual).toEqualTypeOf<
          { id: number; name: string; upperName: string; created: Date }[]
        >()

        expect(actual).toEqual(expected)
      })

      const compound = selected
        .where(eq(Items.id, 1))
        .unionAll(selected.where(eq(Items.id, 3)))
        .orderBy('id')

      const batches: Awaited<ReturnType<typeof compound.execute>> = []
      for await (const batch of compound.batches({ batchSize: 1 })) batches.push(...batch)
      expect(batches).toEqual(await compound.execute())

      await compound.withCursor(async (cursor) => {
        expect(await cursor.fetch(2)).toEqual(batches)
      })
    })
  })
})

it('should clean abandoned child iterators, and keeps an ancestor cursor usable after savepoint rollback', async () => {
  await withPostgresDatabase([Items], async ({ db }) => {
    await db.migrate().execute()
    await db.insert(Items).values(rows).execute()

    await db.transaction(async (tx) => {
      await tx
        .from(Items)
        .orderBy(Items.id)
        .withCursor(async (cursor) => {
          expect(await cursor.fetch(1)).toEqual(rows.slice(0, 1))

          await tx.transaction(async (child) => {
            await child.from(Items).batches({ batchSize: 1 }).next()
          })

          await expect(
            tx.transaction(async (child) => {
              await child.from(Items).batches({ batchSize: 1 }).next()
              throw new Error('child rollback')
            }),
          ).rejects.toThrow('child rollback')

          expect(await cursor.fetch(1)).toEqual(rows.slice(1, 2))
        })

      await tx.from(Items).batches({ batchSize: 1 }).next()
    })

    await db.transaction(async (tx) => {
      expect(
        await tx.sql`select name from pg_cursors where name like 'stratom_cursor_%'`,
      ).toEqual([])
    })
  })
})

const Slow = defineTable('cursor_slow', { id: number() }, { primaryKey: 'id' })

it('should cancel a native PostgreSQL fetch and reject further transaction work', async () => {
  const entered = deferred()
  const abort = new AbortController()
  const reason = new Error('native fetch aborted')
  await withPostgresDatabase(
    [Slow],
    async ({ db, admin, schema }) => {
      await admin.query(
        `create view "${schema}"."cursor_slow" as select 1::integer as id from pg_sleep(5)`,
      )

      const result = db.transaction(async (tx) => {
        await tx.from(Slow).withCursor(
          async (cursor) => {
            await expect(cursor.fetch(1)).rejects.toBe(reason)
            await expect(tx.ping()).rejects.toThrow(/no longer usable/)
          },
          { signal: abort.signal },
        )
      })

      const settled = result.catch((error: unknown) => error)
      try {
        await entered.promise
        await waitForSleepingFetch(admin)
      } finally {
        abort.abort(reason)
        await expect(settled).resolves.toBe(reason)
      }

      await db.ping()
    },
    {
      hooks: {
        before({ sql }) {
          if (sql.startsWith('FETCH')) entered.resolve()
        },
      },
    },
  )
})

async function waitForSleepingFetch(admin: Client): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await admin.query(
      "select 1 from pg_stat_activity where query like 'FETCH FORWARD %' and wait_event = 'PgSleep'",
    )

    if (result.rows.length) return

    await setTimeout(10)
  }

  throw new Error('Native cursor FETCH did not reach pg_sleep')
}

const Missing = defineTable('cursor_missing', { id: number() }, { primaryKey: 'id' })
it('should preserve outer join nullability in cursor projections', async () => {
  await withPostgresDatabase([Items, Missing], async ({ db }) => {
    await db.migrate().execute()
    await db.insert(Items).values(rows).execute()

    await db.transaction(async (tx) => {
      await tx
        .from(Items)
        .leftJoin(Missing, (b) => b.eq(Items.id, Missing.id))
        .select((b) => [Items.id, b.as(Missing.id, 'missing')])
        .orderBy(Items.id)
        .withCursor(async (cursor) => {
          const actual = await cursor.fetch(1)
          expectTypeOf(actual).toEqualTypeOf<{ id: number; missing: number | null }[]>()
          expect(actual).toEqual([{ id: 1, missing: null }])
        })
    })
  })
})

const Broken = defineTable(
  'cursor_broken',
  { id: number(), broken: number() },
  { primaryKey: 'id' },
)

it.each([
  ['withCursor', 'fetch'],
  ['batches', 'fetch'],
  ['withCursor', 'query'],
  ['batches', 'query'],
] as const)(
  'should recover child %s %s SQL failures without closing in an aborted transaction',
  async (terminal, source) => {
    const calls: string[] = []
    await withPostgresDatabase(
      [Items, Broken],
      async ({ db, admin, schema }) => {
        await createBrokenCursorView(admin, schema)
        await db.insert(Items).values(rows).execute()

        await db.transaction(async (tx) => {
          await tx
            .insert(Items)
            .values({ ...rows[0], id: 10 })
            .execute()

          await tx
            .from(Items)
            .orderBy(Items.id)
            .withCursor(async (ancestor) => {
              expect(await ancestor.fetch(1)).toEqual(rows.slice(0, 1))
              calls.length = 0
              let primary: unknown
              const child = tx.transaction(async (nested) => {
                try {
                  await failChildCursor(nested, terminal, source)
                } catch (error) {
                  primary = error
                  throw error
                }
              })

              await expect(child).rejects.toMatchObject({
                _tag: 'DriverError',
                code: '22012',
              })

              await expect(child).rejects.toBe(primary)
              expect(calls.some((sql) => sql.startsWith('FETCH'))).toBe(true)
              expect(calls.some((sql) => sql.startsWith('CLOSE'))).toBe(false)
              expect(calls).toContain('rollback to savepoint sp_1')
              await tx.ping()
              expect(await ancestor.fetch(1)).toEqual(rows.slice(1, 2))
            })
        })

        expect(await db.from(Items).where({ id: 10 }).execute()).toHaveLength(1)
      },
      {
        hooks: {
          before({ sql }) {
            calls.push(sql)
          },
        },
      },
    )
  },
)

async function failChildCursor(
  tx: Db,
  terminal: 'withCursor' | 'batches',
  source: 'fetch' | 'query',
): Promise<void> {
  if (terminal === 'withCursor') {
    if (source === 'fetch')
      return tx.from(Broken).withCursor(async (cursor) => {
        await cursor.fetch(1)
      })

    return tx.from(Items).withCursor(async (cursor) => {
      await cursor.fetch(1)
      await tx.sql`select 1 / 0`
    })
  }

  if (source === 'fetch') {
    await tx.from(Broken).batches({ batchSize: 1 }).next()
    return
  }

  for await (const batch of tx.from(Items).batches({ batchSize: 1 })) {
    await tx.sql`select 1 / ${batch.length - 1}`
  }
}

async function createBrokenCursorView(admin: Client, schema: string): Promise<void> {
  await admin.query(
    `create table "${schema}"."cursor_items" (id integer primary key, physical_label text not null, created timestamptz not null)`,
  )

  await admin.query(
    `create view "${schema}"."cursor_broken" as select id, 1 / (id - id) as broken from "${schema}"."cursor_items"`,
  )
}

it.each([false, true])(
  'should recover a child declaration failure with queued close %s',
  async (queuedClose) => {
    await withPostgresDatabase([Items, Missing], async ({ db, admin, schema }) => {
      await db.migrate().execute()
      await db.insert(Items).values(rows).execute()
      await admin.query(`drop table "${schema}"."cursor_missing"`)

      await db.transaction(async (tx) => {
        await tx
          .from(Items)
          .orderBy(Items.id)
          .withCursor(async (ancestor) => {
            await expect(
              tx.transaction((child) =>
                child.from(Items).withCursor(async (cursor) => {
                  const declaring = child.from(Missing).withCursor(async () => undefined)

                  if (queuedClose) await Promise.all([declaring, cursor.close()])
                  else await declaring
                }),
              ),
            ).rejects.toMatchObject({ _tag: 'DriverError', code: '42P01' })

            await tx.ping()
            expect(await ancestor.fetch(1)).toEqual(rows.slice(0, 1))
          })
      })
    })
  },
)
