import { randomUUID } from 'node:crypto'
import { integer, number, pipe, string } from 'valibot'
import { beforeAll, describe, expect, it } from 'vitest'

import { column, defineTable } from '@/index'

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

function deferred(): {
  promise: Promise<void>
  resolve(): void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

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

function settle<T>(promise: Promise<T>): Promise<Settlement<T>> {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason: unknown) => ({ status: 'rejected', reason }),
  )
}

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

function rejected(settlement: Settlement<unknown>): unknown {
  if (settlement.status === 'rejected') return settlement.reason

  throw new Error('Expected operation to reject')
}

describe('PostgreSQL transaction and coordination integration', () => {
  beforeAll(waitForPostgres)

  it('uses savepoints for nested success and rollback on one physical session', async () => {
    const events: SessionEvent[] = []

    await withPostgresDatabase(
      [TransactionRows],
      async ({ db }) => {
        await db.migrate().execute()
        events.length = 0

        await db.transaction(async (outer) => {
          await outer.insert(TransactionRows).values({ label: 'outer before' }).execute()
          await outer.transaction(async (nested) => {
            await nested
              .insert(TransactionRows)
              .values({ label: 'nested success' })
              .execute()
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
          before(event) {
            events.push(event)
          },
        },
      },
    )

    const begin = events.findIndex(({ sql }) => sql.toLowerCase() === 'begin')
    const commit = events.findIndex(
      ({ sql }, index) => index > begin && sql.toLowerCase() === 'commit',
    )
    expect(begin).toBeGreaterThanOrEqual(0)
    expect(commit).toBeGreaterThan(begin)
    if (begin < 0 || commit <= begin) throw new Error('Expected committed transaction')

    const transactionEvents = events.slice(begin, commit + 1)
    const sql = transactionEvents.map(({ sql: statement }) => statement.toLowerCase())
    expect(sql).toEqual(expect.arrayContaining(['begin', 'commit']))
    expect(sql.some((statement) => statement.startsWith('savepoint '))).toBe(true)
    expect(sql.some((statement) => statement.startsWith('rollback to savepoint '))).toBe(
      true,
    )
    expect(sql.some((statement) => statement.startsWith('release savepoint '))).toBe(true)
    expect(sql.filter((statement) => statement.startsWith('insert into '))).toHaveLength(
      4,
    )
    expect(
      new Set(transactionEvents.map(({ physicalSession }) => physicalSession)).size,
    ).toBe(1)
    expect(transactionEvents[0]?.physicalSession).toMatch(/^\d+$/)
  })

  it('coordinates timeout, cancellation, release, and reacquisition across clients', async () => {
    const firstReachedDdl = deferred()
    const releaseFirst = deferred()
    const applicationId = `postgres-integration-${randomUUID()}`
    let blocked = false

    await withPostgresDatabase(
      [CoordinatedRows],
      async ({ db: first, createDatabase }) => {
        let lockObserved: (() => void) | undefined
        const second = createDatabase([CoordinatedRowsAfter], {
          applicationId,
          hooks: {
            after(event) {
              if (/pg_try_advisory_lock/i.test(event.sql)) lockObserved?.()
            },
          },
        })

        const firstMigration = first.migrate().execute()
        const firstOutcome = settle(firstMigration)
        let firstCompletion!: Settlement<void>

        try {
          await waitForBarrier(
            firstReachedDdl.promise,
            firstOutcome,
            'the first migration DDL barrier',
          )

          let timeoutAttempts = 0
          lockObserved = () => {
            timeoutAttempts++
          }

          const timedOut = settle(second.migrate().execute({ lockTimeoutMs: 1_000 }))
          await within(
            timedOut.then(() => undefined),
            'the positive advisory-lock timeout',
          )
          expect(rejected(await timedOut)).toMatchObject({
            _tag: 'MigrationError',
            stage: 'lock',
            outcome: 'unchanged',
            retryable: true,
          })
          expect(timeoutAttempts).toBeGreaterThan(0)

          const contenderTriedLock = deferred()
          lockObserved = contenderTriedLock.resolve
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
          expect(rejected(await cancelledOutcome)).toMatchObject({
            _tag: 'MigrationError',
            stage: 'lock',
            outcome: 'unchanged',
            retryable: true,
          })
        } finally {
          releaseFirst.resolve()
          firstCompletion = await firstOutcome
        }

        if (firstCompletion.status === 'rejected') throw firstCompletion.reason

        await first
          .insert(CoordinatedRows)
          .values({ id: 'preserved', value: 'before second migration' })
          .execute()

        const reacquiredLock = deferred()
        lockObserved = reacquiredLock.resolve
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
        await expect(second.migrate().dryRun()).resolves.toEqual({ steps: [] })
      },
      {
        applicationId,
        hooks: {
          async before(event) {
            if (!blocked && /^(?:create|alter|drop)\s/i.test(event.sql)) {
              blocked = true
              firstReachedDdl.resolve()
              await releaseFirst.promise
            }
          },
        },
      },
    )
  })
})
