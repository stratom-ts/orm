import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'

import { createDatabase } from '@/index'

import { deferred } from '../../helpers/deferredPromise'
import {
  History,
  assertWorkflow,
  edit,
  initialDate,
  seed,
  tables,
  waitForRead,
} from '../support/serializableTransactions'

import { withSqliteDatabase } from './sqliteIntegration'

const intent = { behavior: 'immediate' } as const

it('should roll back failed history, release ownership and preserve scoped mapping', async () => {
  await withSqliteDatabase(
    tables,
    async ({ db, filePath }) => {
      const observer = createDatabase({
        connector: nodeSqliteConnector({ path: filePath! }),
        schemas: tables,
      })

      try {
        await assertWorkflow(db, observer, intent)
      } finally {
        await observer.close()
      }
    },
    { file: true },
  )
})

it('should not update data or fire an UPDATE trigger for an unchanged save', async () => {
  await withSqliteDatabase(tables, async ({ db, nativeSql }) => {
    await seed(db)

    await nativeSql(
      "create trigger reject_edit_update before update on edit_issues begin select raise(abort, 'unexpected update'); end",
    )

    expect(await edit(db, intent, 'A')).toMatchObject({
      title: 'A',
      updatedAt: initialDate,
    })

    expect(await db.from(History).execute()).toEqual([])
  })
})

it('should acquire write ownership before authorization reads and chain a competing client after release', async () => {
  await withSqliteDatabase(
    tables,
    async ({ db, filePath }) => {
      await seed(db)
      const readGate = deferred()
      const gate = deferred()

      const first = edit(db, intent, 'B', {
        afterRead: async () => {
          readGate.resolve()
          await gate.promise
        },
      })

      let worker: Worker | undefined
      try {
        await waitForRead(readGate.promise, first, 'first edit')
        worker = new Worker(new URL('./serializableWorker.mjs', import.meta.url), {
          workerData: { path: filePath!, library: import.meta.resolve('@stratom/orm') },
        })

        expect(
          (await once(worker, 'message', { signal: AbortSignal.timeout(10000) }))[0],
        ).toEqual({ state: 'busy', entered: false })

        gate.resolve()
        await first
        const result = once(worker, 'message', { signal: AbortSignal.timeout(10000) })
        worker.postMessage('retry')
        expect((await result)[0]).toEqual({ state: 'done', before: 'B' })

        expect(await db.from(History).orderBy(History.after).execute()).toEqual([
          { before: 'A', after: 'B', issue: 1 },
          { before: 'B', after: 'C', issue: 1 },
        ])
      } finally {
        gate.resolve()
        await Promise.allSettled([first])
        await worker?.terminate()
      }
    },
    { file: true },
  )
})
