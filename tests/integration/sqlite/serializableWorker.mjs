import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { once } from 'node:events'
import { parentPort, workerData } from 'node:worker_threads'
import { date, number, pipe, string } from 'valibot'

/** @type {{ library: string; path: string }} */
const options = /** @type {{ library: string; path: string }} */ (workerData)

/** @type {typeof import('../../../src/index')} */
const library = /** @type {typeof import('../../../src/index')} */ (
  await import(options.library)
)

const { createDatabase, defineTable, column } = library

if (!parentPort) throw new Error('worker requires a parent port')

const port = parentPort
const Projects = defineTable(
  'edit_projects',
  { id: number(), workspace: string() },
  { primaryKey: 'id' },
)

const Issues = defineTable(
  'edit_issues',
  {
    id: number(),
    workspace: string(),
    project: number(),
    title: pipe(string(), column({ name: 'issue_title' })),
    updatedAt: date(),
  },
  { primaryKey: 'id' },
)

const History = defineTable(
  'edit_history',
  { before: string(), after: string(), issue: number() },
  { primaryKey: ['issue', 'after'] },
)

const db = createDatabase({
  connector: nodeSqliteConnector({ path: options.path }),
  schemas: [Projects, Issues, History],
})

let entered = false
async function edit() {
  return db.transaction(
    async (tx) => {
      entered = true
      await tx.from(Projects).where({ id: 1, workspace: 'a' }).executeTakeFirstOrThrow()
      const before = await tx
        .from(Issues)
        .where({ id: 1, project: 1, workspace: 'a' })
        .executeTakeFirstOrThrow()

      await tx
        .update(Issues)
        .set({ title: 'C', updatedAt: new Date('2026-02-01T00:00:00Z') })
        .where({ id: 1, project: 1, workspace: 'a' })
        .execute()

      await tx
        .insert(History)
        .values({ issue: 1, before: before.title, after: 'C' })
        .execute()

      return before.title
    },
    { isolationLevel: 'serializable' },
  )
}

async function competingAttempt() {
  try {
    await edit()
    throw new Error('competing writer unexpectedly succeeded')
  } catch (error) {
    if (!library.isStratomError(error) || error.kind !== 'transient' || !error.retryable)
      throw error

    port.postMessage({ state: 'busy', entered })
  }
}

try {
  await db.sql`pragma busy_timeout = 0`
  await competingAttempt()
  await once(port, 'message', { signal: AbortSignal.timeout(10000) })
  const before = await edit()
  port.postMessage({ state: 'done', before })
} finally {
  await db.close()
  port.close()
}
