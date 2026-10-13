import { describe, expect, it } from 'vitest'

import type { OperationSessionProvider } from '@/index'
import { createDatabase } from '@/index'

import { deferred } from '../helpers/deferredPromise'

import {
  createControllableProvider,
  customConnector,
} from './helpers/operationSessionFixtures'

describe('operation coordinator lifecycle', () => {
  it('gives query, transaction, planning, and migration distinct FIFO root slots', async () => {
    const firstCall = deferred()
    const finishFirst = deferred()
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (session) => {
        if (session === 1) {
          firstCall.resolve()
          await finishFirst.promise
        }
      },
    })

    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const query = db.ping()
    await firstCall.promise
    const transaction = db.transaction(async (trx) => trx.ping())
    const planning = db.migrate().plan()
    const migration = db.migrate().execute()
    expect(controls.openCount).toBe(1)
    finishFirst.resolve()
    await Promise.all([query, transaction, planning, migration])

    assertRootOperationOrder(controls)

    await db.close()
  })
})

describe('operation coordinator lifecycle: drains accepted operations and releases them before provider close', () => {
  it('drains accepted operations and releases them before provider close', async () => {
    const firstStarted = deferred()
    const finishFirst = deferred()
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (session) => {
        if (session === 1) {
          firstStarted.resolve()
          await finishFirst.promise
        }
      },
    })

    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const first = db.ping()
    await firstStarted.promise
    const second = db.ping()
    const close = db.close()
    const sameClose = db.close()
    expect(sameClose).toBe(close)
    await Promise.resolve()
    expect(controls.events).not.toContain('provider-closed')
    finishFirst.resolve()
    await Promise.all([first, second, close])
    expect(controls.events.at(-1)).toBe('provider-closed')
    expect(controls.events).toContain('release-finished:2:reuse')
    await expect(db.ping()).rejects.toThrow(/closed/i)
  })
})

describe('operation coordinator lifecycle: returns one shutdown promise and preserves provider close rejection', () => {
  it('returns one shutdown promise and preserves provider close rejection', async () => {
    const closeError = new Error('provider close failed')
    const controls = createControllableProvider({
      closeFailure: { value: closeError },
    })

    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const first = db.close()
    const second = db.close()
    expect(second).toBe(first)
    await expect(first).rejects.toBe(closeError)
    const later = db.close()
    expect(later).toBe(first)
    await expect(later).rejects.toBe(closeError)
    expect(controls.closeCount).toBe(1)
  })
})

describe('operation coordinator lifecycle: returns one shutdown promise and preserves provider close rejection: preserves rejection with undefined from callbacks and release cleanup', () => {
  it('preserves rejection with undefined from callbacks and release cleanup', async () => {
    const callbackControls = createControllableProvider()
    const callbackDb = createDatabase({
      connector: customConnector(),
      operationSessionProvider: callbackControls.provider,
      schemas: [],
    })

    const transaction = callbackDb.transaction(async () => {
      throw undefined
    })

    await expect(transaction).rejects.toBeUndefined()

    expect(callbackControls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'rollback',
    ])

    await callbackDb.close()

    const releaseControls = createControllableProvider({
      releaseFailure: { session: 1, value: undefined },
    })

    const releaseDb = createDatabase({
      connector: customConnector(),
      operationSessionProvider: releaseControls.provider,
      schemas: [],
    })

    await expect(releaseDb.ping()).rejects.toBeUndefined()

    await expect(releaseDb.ping()).resolves.toBeUndefined()
    expect(releaseControls.openCount).toBe(2)
    await releaseDb.close()
  })
})

/**
 * Checks that query, transaction, planning, and migration calls receive separate
 * serialized root sessions.
 *
 * @param controls - Mutable test observations and synchronization controls.
 */
function assertRootOperationOrder(controls: {
  provider: OperationSessionProvider
  events: string[]
  calls: { session: number; sql: string }[]
  readonly openCount: number
  readonly maxActiveCalls: number
  readonly closeCount: number
}) {
  expect(controls.events.filter((event) => event.startsWith('lease-opened:'))).toEqual([
    'lease-opened:1',
    'lease-opened:2',
    'lease-opened:3',
    'lease-opened:4',
  ])

  expect(
    controls.calls.some((entry) => entry.session === 2 && entry.sql === 'begin'),
  ).toBe(true)

  expect(
    controls.calls.some(
      (entry) => entry.session === 3 && /current_database\(\)/i.test(entry.sql),
    ),
  ).toBe(true)

  expect(
    controls.calls.some(
      (entry) => entry.session === 4 && /pg_try_advisory_lock/i.test(entry.sql),
    ),
  ).toBe(true)
}
