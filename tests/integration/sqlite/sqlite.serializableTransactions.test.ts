import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { expect, it } from 'vitest'

import { createDatabase } from '@/index'

import {
  History,
  assertWorkflow,
  edit,
  initialDate,
  seed,
  tables,
} from '../support/serializableTransactions'

import { withSqliteDatabase } from './sqliteIntegration'

it('rolls back failed history, releases ownership and preserves scoped mapping', async () => {
  await withSqliteDatabase(
    tables,
    async ({ db, filePath }) => {
      const observer = createDatabase({
        connector: nodeSqliteConnector({ path: filePath! }),
        schemas: tables,
      })

      try {
        await assertWorkflow(db, observer)
      } finally {
        await observer.close()
      }
    },
    { file: true },
  )
})

it('does not update data or fire an UPDATE trigger for an unchanged save', async () => {
  await withSqliteDatabase(tables, async ({ db, nativeSql }) => {
    await seed(db)

    await nativeSql(
      "create trigger reject_edit_update before update on edit_issues begin select raise(abort, 'unexpected update'); end",
    )

    expect(await edit(db, 'A')).toMatchObject({ title: 'A', updatedAt: initialDate })
    expect(await db.from(History).execute()).toEqual([])
  })
})

it('acquires write ownership before authorization reads and chains a competing client after release', async () => {
  await withSqliteDatabase(
    tables,
    async ({ db, filePath }) => {
      await seed(db)
      let release!: () => void
      let read!: () => void
      const readGate = new Promise<void>((r) => {
        read = r
      })

      const gate = new Promise<void>((r) => {
        release = r
      })

      const first = edit(db, 'B', {
        afterRead: async () => {
          read()
          await gate
        },
      })

      let worker: Worker | undefined
      try {
        await readGate
        worker = new Worker(new URL('./serializableWorker.mjs', import.meta.url), {
          workerData: { path: filePath!, library: import.meta.resolve('stratom') },
        })

        expect(
          (await once(worker, 'message', { signal: AbortSignal.timeout(10000) }))[0],
        ).toEqual({ state: 'busy', entered: false })

        release()
        await first
        const result = once(worker, 'message', { signal: AbortSignal.timeout(10000) })
        worker.postMessage('retry')
        expect((await result)[0]).toEqual({ state: 'done', before: 'B' })

        expect(await db.from(History).orderBy(History.after).execute()).toEqual([
          { before: 'A', after: 'B', issue: 1 },
          { before: 'B', after: 'C', issue: 1 },
        ])
      } finally {
        release()
        await Promise.allSettled([first])
        await worker?.terminate()
      }
    },
    { file: true },
  )
})
