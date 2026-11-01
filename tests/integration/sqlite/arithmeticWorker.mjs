import nodeSqliteConnector from 'db0/connectors/node-sqlite'
import { once } from 'node:events'
import { parentPort, workerData } from 'node:worker_threads'
import { integer, number, pipe, string } from 'valibot'

/** @type {{ library: string; path: string; hold: boolean }} */
const options = /** @type {{ library: string; path: string; hold: boolean }} */ (
  workerData
)

/** @type {typeof import('stratom')} */
const library = /** @type {typeof import('stratom')} */ (await import(options.library))
const { add, createDatabase, defineTable } = library

if (!parentPort) throw new Error('worker requires a parent port')

const port = parentPort
const Projects = defineTable(
  'counter_projects',
  {
    id: pipe(number(), integer()),
    workspace: string(),
    nextIssueNumber: pipe(number(), integer()),
  },
  { primaryKey: 'id' },
)

const Issues = defineTable(
  'counter_issues',
  { project: pipe(number(), integer()), number: pipe(number(), integer()) },
  { primaryKey: ['project', 'number'] },
)

const History = defineTable(
  'counter_history',
  {
    project: pipe(number(), integer()),
    number: pipe(number(), integer()),
    event: string(),
  },
  { primaryKey: ['project', 'number', 'event'] },
)

const db = createDatabase({
  connector: nodeSqliteConnector({ path: options.path }),
  schemas: [Projects, Issues, History],
})

/**
 * Checks only recognized native SQLite lock contention.
 *
 * @param {unknown} error - Driver or query failure.
 *
 * @returns {boolean} Whether the failure is SQLITE_BUSY.
 */
function isBusy(error) {
  if (!error || typeof error !== 'object') return false

  return (
    ('errcode' in error && error.errcode === 5) ||
    ('code' in error && error.code === 'SQLITE_BUSY') ||
    ('cause' in error && isBusy(error.cause))
  )
}

async function allocate() {
  return db.transaction(async (tx) => {
    const row = await tx
      .update(Projects)
      .set({ nextIssueNumber: add(Projects.nextIssueNumber, 1) })
      .where({ id: 1, workspace: 'a' })
      .executeTakeFirstOrThrow()

    if (options.hold) {
      port.postMessage({ state: 'locked' })
      await once(port, 'message', { signal: AbortSignal.timeout(10000) })
    }

    const number = row.nextIssueNumber - 1
    await tx.insert(Issues).values({ project: 1, number }).execute()
    await tx.insert(History).values({ project: 1, number, event: 'created' }).execute()
    return number
  })
}

async function allocateWithRetry() {
  try {
    return await allocate()
  } catch (error) {
    if (options.hold || !isBusy(error)) throw error

    port.postMessage({ state: 'busy' })
    await once(port, 'message', { signal: AbortSignal.timeout(10000) })
    return allocate()
  }
}

try {
  const number = await allocateWithRetry()
  port.postMessage({ state: 'done', number })
} finally {
  await db.close()
  port.close()
}
