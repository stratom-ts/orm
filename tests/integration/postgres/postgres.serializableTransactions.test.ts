import { expect, it } from 'vitest'

import { deferred } from '../../helpers/deferredPromise'
import {
  History,
  assertWorkflow,
  edit,
  initialDate,
  seed,
  tables,
} from '../support/serializableTransactions'

import { withPostgresDatabase } from './postgresIntegration'

const intent = { isolationLevel: 'serializable' } as const

it('rolls back failed history, releases ownership and preserves scoped mapping', async () => {
  await withPostgresDatabase(tables, async ({ db, createDatabase }) => {
    await assertWorkflow(db, createDatabase(tables), intent)
  })
})

it('does not update data or fire an UPDATE trigger for an unchanged save', async () => {
  await withPostgresDatabase(tables, async ({ db, schema }) => {
    await seed(db)
    await db.sql`create function ${db.sql.id(schema, 'reject_edit_update')}() returns trigger language plpgsql as 'begin raise exception ''unexpected update''; end'`
    await db.sql`create trigger reject_edit_update before update on ${db.sql.id(schema, 'edit_issues')} for each row execute function ${db.sql.id(schema, 'reject_edit_update')}()`

    expect(await edit(db, intent, 'A')).toMatchObject({
      title: 'A',
      updatedAt: initialDate,
    })

    expect(await db.from(History).execute()).toEqual([])
  })
})

it('rejects an overlapping stale edit and a new transaction chains from the committed predecessor', async () => {
  await withPostgresDatabase(tables, async ({ db, createDatabase }) => {
    await seed(db)
    const firstRead = deferred()
    const secondRead = deferred()
    const firstGate = deferred()
    const secondGate = deferred()
    const first = edit(createDatabase(tables), intent, 'B', {
      afterRead: async () => {
        firstRead.resolve()
        await firstGate.promise
      },
    })

    const secondClient = createDatabase(tables)
    let second: Promise<unknown> | undefined
    try {
      await firstRead.promise
      second = edit(secondClient, intent, 'C', {
        afterRead: async () => {
          secondRead.resolve()
          await secondGate.promise
        },
      })

      const outcome = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      )

      await secondRead.promise
      firstGate.resolve()
      await first
      secondGate.resolve()

      expect(await outcome).toMatchObject({
        error: { kind: 'transient', retryable: true },
      })

      expect(await edit(secondClient, intent, 'C')).toMatchObject({ title: 'C' })

      expect(await db.from(History).orderBy(History.after).execute()).toEqual([
        { before: 'A', after: 'B', issue: 1 },
        { before: 'B', after: 'C', issue: 1 },
      ])
    } finally {
      firstGate.resolve()
      secondGate.resolve()
      await Promise.allSettled([first, ...(second ? [second] : [])])
    }
  })
})
