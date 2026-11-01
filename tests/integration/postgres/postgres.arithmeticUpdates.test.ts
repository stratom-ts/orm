import { setTimeout } from 'node:timers/promises'
import type { Client } from 'pg'
import { expect, it } from 'vitest'

import {
  History,
  Issues,
  Projects,
  allocate,
  basicAndRollback,
  seed,
  tables,
} from '../support/arithmeticUpdates'

import { withPostgresDatabase } from './postgresIntegration'

it('composes numeric assignments and rolls back the complete allocation transaction', async () => {
  await withPostgresDatabase(tables, async ({ db, createDatabase }) => {
    await expect(basicAndRollback(db, createDatabase(tables))).resolves.toBeUndefined()
  })
})

it('allocates unique numbers while an independent client waits on the same project lock', async () => {
  await withPostgresDatabase(tables, async ({ db, createDatabase, admin, schema }) => {
    await seed(db)
    let release!: () => void
    let locked!: () => void
    const held = new Promise<void>((resolve) => {
      locked = resolve
    })

    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = createDatabase(tables, {
      hooks: {
        async after({ sql }) {
          if (sql.startsWith('update ')) {
            locked()
            await gate
          }
        },
      },
    })

    const second = createDatabase(tables)
    const allocation1 = allocate(first)
    await Promise.race([
      held,
      allocation1.then(() => {
        throw new Error('allocation finished before the lock gate')
      }),
    ])

    const allocation2 = allocate(second)

    let waiting = false
    try {
      waiting = await hasWaitingCounterUpdate(admin, schema)
    } finally {
      release()
      await Promise.allSettled([allocation1, allocation2])
    }

    const numbers = await Promise.all([allocation1, allocation2])
    expect(waiting).toBe(true)
    expect(numbers.sort((a, b) => a - b)).toEqual([1, 2])

    expect(
      await db.from(Projects).where({ id: 1 }).executeTakeFirstOrThrow(),
    ).toMatchObject({ nextIssueNumber: 3 })

    expect(
      await db.from(Projects).where({ id: 2 }).executeTakeFirstOrThrow(),
    ).toMatchObject({ nextIssueNumber: 1 })

    expect(await db.from(Issues).execute()).toHaveLength(2)
    expect(await db.from(History).execute()).toHaveLength(2)
  })
})

/** Observes real PostgreSQL lock contention with a bounded wait. */
async function hasWaitingCounterUpdate(admin: Client, schema: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await admin.query(
      "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query like $1",
      [`update %"${schema}"."counter_projects"%`],
    )

    if (result.rowCount) return true

    await setTimeout(10)
  }

  return false
}
