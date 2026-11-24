import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { integer, number, pipe } from 'valibot'
import { expect, it } from 'vitest'

import { QueryError, add, column, createDatabase, defineTable } from '@/index'

import {
  History,
  Issues,
  Projects,
  basicAndRollback,
  seed,
  tables,
} from '../support/arithmeticUpdates'

import { withSqliteDatabase } from './sqliteIntegration'

it('should compose numeric assignments and roll back the complete allocation transaction', async () => {
  await withSqliteDatabase(
    tables,
    async ({ db, filePath }) => {
      const observer = createDatabase({
        connector: nodeSqliteConnector({ path: filePath! }),
        schemas: tables,
      })

      try {
        await expect(basicAndRollback(db, observer)).resolves.toBeUndefined()
      } finally {
        await observer.close()
      }
    },
    { file: true },
  )
})

it('should not treat INTEGER affinity as proof that a numeric source is integral', async () => {
  const Values = defineTable(
    'numeric_affinity',
    {
      id: pipe(number(), integer()),
      count: pipe(number(), integer()),
      fraction: pipe(number(), column({ physicalType: { sqlite: 'INTEGER' } })),
    },
    { primaryKey: 'id' },
  )

  await withSqliteDatabase([Values], async ({ db }) => {
    await db.migrate().execute()
    await db.insert(Values).values({ id: 1, count: 2, fraction: 1.5 }).execute()

    expect(() => db.update(Values).set({ count: add(Values.fraction, 1) })).toThrow(
      QueryError,
    )

    expect(
      await db
        .update(Values)
        .set({ fraction: add(Values.fraction, 0.25) })
        .where({ id: 1 })
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: 1, count: 2, fraction: 1.75 })
  })
})

it('should allocate unique numbers through overlapping independent worker clients', async () => {
  await withSqliteDatabase(
    tables,
    async ({ db, filePath }) => {
      await seed(db)
      const first = startAllocator(filePath!, true)

      let second: Worker | undefined
      try {
        expect(
          (await once(first, 'message', { signal: AbortSignal.timeout(10000) }))[0],
        ).toEqual({ state: 'locked' })

        second = startAllocator(filePath!, false)

        expect(
          (await once(second, 'message', { signal: AbortSignal.timeout(10000) }))[0],
        ).toEqual({ state: 'busy' })

        const firstResult = once(first, 'message', { signal: AbortSignal.timeout(10000) })
        first.postMessage('release')
        expect((await firstResult)[0]).toEqual({ state: 'done', number: 1 })
        const secondResult = once(second, 'message', {
          signal: AbortSignal.timeout(10000),
        })

        second.postMessage('retry')
        expect((await secondResult)[0]).toEqual({ state: 'done', number: 2 })

        expect(
          await db.from(Projects).where({ id: 1 }).executeTakeFirstOrThrow(),
        ).toMatchObject({ nextIssueNumber: 3 })

        expect(
          await db.from(Projects).where({ id: 2 }).executeTakeFirstOrThrow(),
        ).toMatchObject({ nextIssueNumber: 1 })

        expect(await db.from(Issues).execute()).toHaveLength(2)
        expect(await db.from(History).execute()).toHaveLength(2)
      } finally {
        await first.terminate()
        await second?.terminate()
      }
    },
    { file: true },
  )
})

/** Starts an independent native client sharing the fixture database file. */
function startAllocator(path: string, hold: boolean): Worker {
  return new Worker(new URL('./arithmeticWorker.mjs', import.meta.url), {
    workerData: { path, library: import.meta.resolve('@stratom/orm'), hold },
  })
}
