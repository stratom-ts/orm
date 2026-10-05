import { randomUUID } from 'node:crypto'
import { integer, number, pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import type { Db } from '@/index'
import { column, defineTable } from '@/index'

import { deferred } from '../helpers/deferredPromise'

import { waitForPostgres } from './postgres.setup'
import type { SessionEvent } from './postgresIntegration'
import { withPostgresDatabase } from './postgresIntegration'

const TransactionRows = defineTable(
  'transaction_rows',
  {
    id: pipe(
      number(),
      integer(),
      column({ generation: { kind: 'identity', mode: 'byDefault' } }),
    ),
    label: string(),
  },
  { primaryKey: 'id' },
)

const CoordinatedRows = defineTable(
  'coordinated_rows',
  { id: string(), value: string() },
  { primaryKey: 'id' },
)

const CoordinatedRowsAfter = defineTable(
  'coordinated_rows',
  {
    id: string(),
    value: string(),
    added: pipe(
      string(),
      column({ databaseDefault: { kind: 'literal', value: 'after lock' } }),
    ),
  },
  { primaryKey: 'id' },
)

type Settlement<T> =
  | Readonly<{ status: 'fulfilled'; value: T }>
  | Readonly<{ status: 'rejected'; reason: unknown }>

/**
 * Waits for a synchronization promise with a five-second diagnostic timeout.
 *
 * @param promise - Pending work whose settlement or timeout is observed.
 * @param label - Diagnostic label for the field or observation being checked.
 */
async function within(promise: Promise<void>, label: string): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000)
  })

  try {
    await Promise.race([promise, deadline])
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Captures promise fulfillment or rejection without rejecting the observation promise.
 *
 * @param promise - Pending work whose settlement or timeout is observed.
 *
 * @returns The callback value after the operation and required cleanup complete.
 */
function settle<T>(promise: Promise<T>): Promise<Settlement<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  )
}

/**
 * Waits for the barrier and reports an operation that settles before reaching it.
 *
 * @param barrier - Promise used to synchronize concurrent test operations.
 * @param operation - Work to run within the current session or error boundary.
 * @param label - Diagnostic label for the field or observation being checked.
 */
async function waitForBarrier(
  barrier: Promise<void>,
  operation: Promise<Settlement<unknown>>,
  label: string,
): Promise<void> {
  const winner = await Promise.race([
    within(barrier, label).then(() => ({ kind: 'barrier' as const })),
    operation.then((settlement) => ({ kind: 'operation' as const, settlement })),
  ])

  if (winner.kind === 'barrier') return

  if (winner.settlement.status === 'rejected') throw winner.settlement.reason

  throw new Error(`Operation completed before ${label}`)
}

/** Extracts a captured rejection or fails when the operation unexpectedly succeeded. */
function rejected(settlement: Settlement<unknown>): unknown {
  if (settlement.status === 'rejected') return settlement.reason

  throw new Error('Expected operation to reject')
}

beforeAll(waitForPostgres)

describe('PostgreSQL transaction and coordination integration', () => {
  it('uses savepoints for nested success and rollback on one physical session', async () => {
    const events: SessionEvent[] = []

    await withPostgresDatabase(
      [TransactionRows],
      async ({ db }) => {
        await db.migrate().execute()
        events.length = 0

        await performNestedTransactions(db)

        const rows = await db
          .from(TransactionRows)
          .select([TransactionRows.label])
          .orderBy(TransactionRows.id, 'asc')
          .execute()

        expect(rows.map(({ label }) => label)).toEqual([
          'outer before',
          'nested success',
          'outer after',
        ])
      },
      {
        hooks: {
          /** Observes a physical SQL call before native execution. */
          before(event) {
            events.push(event)
          },
        },
      },
    )

    assertSavepointSessionEvents(events)
  })
})

describe('PostgreSQL coordination integration', () => {
  it('coordinates timeout, cancellation, release, and reacquisition across clients', async () => {
    const firstReachedDdl = deferred()
    const releaseFirst = deferred()
    const applicationId = `postgres-integration-${randomUUID()}`

    await withPostgresDatabase(
      [CoordinatedRows],
      async ({ db: first, createDatabase }) => {
        const observer: LockObserver = { notify: undefined }
        const second = createDatabase([CoordinatedRowsAfter], {
          applicationId,
          hooks: {
            /** Observes a physical SQL call after native execution. */
            after(event) {
              if (/pg_try_advisory_lock/i.test(event.sql)) observer.notify?.()
            },
          },
        })

        const firstMigration = first.migrate().execute()
        const firstOutcome = settle(firstMigration)
        let firstCompletion!: Settlement<void>

        try {
          await assertLockContention(firstReachedDdl, firstOutcome, observer, second)
        } finally {
          releaseFirst.resolve()
          firstCompletion = await firstOutcome
        }

        if (firstCompletion.status === 'rejected') throw firstCompletion.reason

        await assertMigrationReacquisition(first, observer, second)
      },
      {
        applicationId,
        hooks: createCoordinationBarrierHooks(firstReachedDdl, releaseFirst),
      },
    )
  })
})

type LockObserver = { notify: (() => void) | undefined }

/**
 * Exercises nested commit and rollback while retaining the outer transaction's successful
 * rows.
 *
 * @param db - Database client exercised by this test scenario.
 */
async function performNestedTransactions(db: Db) {
  await db.transaction(async (outer) => {
    await outer.insert(TransactionRows).values({ label: 'outer before' }).execute()

    await outer.transaction(async (nested) => {
      await nested.insert(TransactionRows).values({ label: 'nested success' }).execute()
    })

    await expect(
      outer.transaction(async (nested) => {
        await nested
          .insert(TransactionRows)
          .values({ label: 'nested rollback' })
          .execute()

        throw new Error('nested failure')
      }),
    ).rejects.toThrow('nested failure')

    await outer.insert(TransactionRows).values({ label: 'outer after' }).execute()
  })
}

/**
 * Checks that a client can reacquire migration coordination after the previous holder
 * releases it.
 *
 * @param first - First observation or composite-key row used as the comparison baseline.
 * @param observer - Mutable session hooks and event observations used to coordinate
 *   concurrent clients.
 * @param second - Second observation used to detect changes.
 */
async function assertMigrationReacquisition(
  first: Db,
  observer: LockObserver,
  second: Db,
) {
  await first
    .insert(CoordinatedRows)
    .values({ id: 'preserved', value: 'before second migration' })
    .execute()

  const reacquiredLock = deferred()
  observer.notify = reacquiredLock.resolve
  const reacquisition = second.migrate().execute({ lockTimeoutMs: 0 })
  const reacquisitionOutcome = settle(reacquisition)
  await waitForBarrier(
    reacquiredLock.promise,
    reacquisitionOutcome,
    'the reacquired advisory-lock query',
  )

  const reacquired = await reacquisitionOutcome

  if (reacquired.status === 'rejected') throw reacquired.reason

  await expect(second.from(CoordinatedRowsAfter).execute()).resolves.toEqual([
    {
      id: 'preserved',
      value: 'before second migration',
      added: 'after lock',
    },
  ])

  await expect(second.migrate().plan()).resolves.toEqual({ steps: [] })
}

/**
 * Finds the committed transaction's event range before checking its nested savepoint
 * calls.
 *
 * @param events - Recorded session or migration events in their observed order.
 */
function assertSavepointSessionEvents(
  events: Readonly<{ sql: string; physicalSession: string }>[],
) {
  const begin = events.findIndex(({ sql }) => sql.toLowerCase() === 'begin')
  const commit = events.findIndex(
    ({ sql }, index) => index > begin && sql.toLowerCase() === 'commit',
  )

  expect(begin).toBeGreaterThanOrEqual(0)
  expect(commit).toBeGreaterThan(begin)

  if (begin < 0 || commit <= begin) throw new Error('Expected committed transaction')

  const transactionEvents = events.slice(begin, commit + 1)
  const sql = transactionEvents.map(({ sql: statement }) => statement.toLowerCase())
  assertNestedSavepointEvents(sql, transactionEvents)
}

/**
 * Checks savepoint, rollback, insert, and physical-session evidence for nested
 * transactions.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 * @param transactionEvents - Recorded events for the transaction under test.
 */
function assertNestedSavepointEvents(
  sql: string[],
  transactionEvents: Readonly<{ sql: string; physicalSession: string }>[],
) {
  expect(sql).toEqual(expect.arrayContaining(['begin', 'commit']))
  expect(sql.some((statement) => statement.startsWith('savepoint '))).toBe(true)

  expect(sql.some((statement) => statement.startsWith('rollback to savepoint '))).toBe(
    true,
  )

  expect(sql.some((statement) => statement.startsWith('release savepoint '))).toBe(true)

  expect(sql.filter((statement) => statement.startsWith('insert into '))).toHaveLength(4)

  expect(
    new Set(transactionEvents.map(({ physicalSession }) => physicalSession)).size,
  ).toBe(1)

  expect(transactionEvents[0]?.physicalSession).toMatch(/^\d+$/)
}

/**
 * Checks timeout and abort behavior while another client holds migration coordination.
 *
 * @param firstReachedDdl - Barrier that resolves after the first client enters its
 *   protected DDL phase.
 * @param firstOutcome - Configured result of the first cancellation or release attempt.
 * @param observer - Mutable session hooks and event observations used to coordinate
 *   concurrent clients.
 * @param second - Second observation used to detect changes.
 */
async function assertLockContention(
  firstReachedDdl: ReturnType<typeof deferred>,
  firstOutcome: Promise<Settlement<void>>,
  observer: LockObserver,
  second: import('@/index').Db<readonly [typeof CoordinatedRowsAfter]>,
): Promise<void> {
  await waitForBarrier(
    firstReachedDdl.promise,
    firstOutcome,
    'the first migration DDL barrier',
  )

  await assertLockTimeout(observer, second)
  const contenderTriedLock = deferred()
  observer.notify = contenderTriedLock.resolve
  const controller = new AbortController()

  const cancelled = second.migrate().execute({
    signal: controller.signal,
    lockTimeoutMs: 30_000,
  })

  const cancelledOutcome = settle(cancelled)
  await waitForBarrier(
    contenderTriedLock.promise,
    cancelledOutcome,
    'the contending advisory-lock query',
  )

  controller.abort()

  await within(
    cancelledOutcome.then(() => undefined),
    'the cancelled advisory-lock query',
  )

  expect(rejected(await cancelledOutcome)).toMatchObject({
    _tag: 'MigrationError',
    message: expect.stringMatching(/aborted/i) as unknown,
    stage: 'lock',
    outcome: 'unchanged',
    retryable: true,
  })
}

/**
 * Waits for observed lock acquisition attempts and checks that timeout prevents protected
 * migration work.
 *
 * @param observer - Mutable session hooks and event observations used to coordinate
 *   concurrent clients.
 * @param second - Second observation used to detect changes.
 */
async function assertLockTimeout(observer: LockObserver, second: Db) {
  let timeoutAttempts = 0
  observer.notify = () => {
    timeoutAttempts++
  }

  const timedOut = settle(second.migrate().execute({ lockTimeoutMs: 1000 }))
  await within(
    timedOut.then(() => undefined),
    'the positive advisory-lock timeout',
  )

  expect(rejected(await timedOut)).toMatchObject({
    _tag: 'MigrationError',
    message: expect.stringContaining(
      'Timed out acquiring the migration advisory lock',
    ) as unknown,
    stage: 'lock',
    outcome: 'unchanged',
    retryable: true,
  })

  expect(timeoutAttempts).toBeGreaterThan(0)
}

/**
 * Holds the first protected DDL call until the test releases its synchronization barrier.
 *
 * @param firstReachedDdl - Barrier that resolves after the first client enters its
 *   protected DDL phase.
 * @param releaseFirst - Barrier that releases the first client's held DDL phase.
 *
 * @returns Hooks that suspend the first protected DDL call at the fixture barrier.
 */
function createCoordinationBarrierHooks(
  firstReachedDdl: ReturnType<typeof deferred>,
  releaseFirst: ReturnType<typeof deferred>,
): NonNullable<Parameters<typeof withPostgresDatabase>[2]>['hooks'] {
  let blocked = false
  return {
    /** Observes a physical SQL call before native execution. */
    async before(event) {
      if (!blocked && /^(?:create|alter|drop)\s/i.test(event.sql)) {
        blocked = true
        firstReachedDdl.resolve()
        await releaseFirst.promise
      }
    },
  }
}
