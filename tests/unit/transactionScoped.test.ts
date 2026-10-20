import { describe, expect, it } from 'vitest'

import { createDatabase } from '@/index'

import { deferred } from '../helpers/deferredPromise'

import {
  createControllableProvider,
  customConnector,
  withDeadline,
} from './helpers/operationSessionFixtures'

describe('scoped transaction coordinator behavior', () => {
  it('reuses one token for transaction calls, concurrent calls, and savepoints', async () => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    await db.transaction(async (trx) => {
      await Promise.all([trx.ping(), trx.ping()])
      await trx.transaction(async (nested) => nested.ping())
    })

    expect(controls.openCount).toBe(1)
    expect(controls.maxActiveCalls).toBe(1)
    expect(controls.calls.every((entry) => entry.session === 1)).toBe(true)

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'select 1',
      'select 1',
      'savepoint sp_1',
      'select 1',
      'release savepoint sp_1',
      'commit',
    ])

    await db.close()
  })
})

describe('scoped transaction coordinator behavior: serializes sibling savepoint callbacks while preserving deeper nesting', () => {
  it('serializes sibling savepoint callbacks while preserving deeper nesting', async () => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    await db.transaction(async (trx) => {
      await Promise.all([
        trx.transaction(async (first) => {
          await first.transaction(async (deep) => deep.ping())
        }),
        trx.transaction(async (second) => second.ping()),
      ])
    })

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'savepoint sp_2',
      'select 1',
      'release savepoint sp_2',
      'release savepoint sp_1',
      'savepoint sp_3',
      'select 1',
      'release savepoint sp_3',
      'commit',
    ])

    await db.close()
  })
})

describe('scoped transaction coordinator behavior: rejects ancestor transaction use from a descendant callback', () => {
  it('rejects ancestor transaction use from a descendant callback', async () => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    await withDeadline(
      db.transaction(async (trx) => {
        await trx.transaction(async (nested) => {
          await expect(
            withDeadline(trx.transaction(async () => undefined)),
          ).rejects.toThrow(/use the nested callback client/i)

          await expect(withDeadline(trx.ping())).rejects.toThrow(
            /use the nested callback client/i,
          )

          await nested.transaction(async (deep) => deep.ping())
        })
      }),
    )

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'savepoint sp_2',
      'select 1',
      'release savepoint sp_2',
      'release savepoint sp_1',
      'commit',
    ])

    await db.close()
  })
})

describe('scoped transaction coordinator behavior: rejects ancestor transaction use from a descendant callback: queues unrelated ancestor statements until a successful savepoint releases', () => {
  it('queues unrelated ancestor statements until a successful savepoint releases', async () => {
    const nestedStarted = deferred()
    const finishNested = deferred()
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    let ancestor!: Parameters<Parameters<typeof db.transaction>[0]>[0]

    const transaction = db.transaction(async (trx) => {
      ancestor = trx

      await trx.transaction(async () => {
        nestedStarted.resolve()
        await finishNested.promise
      })
    })

    await nestedStarted.promise
    const ancestorStatement = ancestor.ping()
    await Promise.resolve()
    expect(controls.calls.map((entry) => entry.sql)).toEqual(['begin', 'savepoint sp_1'])

    finishNested.resolve()
    await withDeadline(Promise.all([transaction, ancestorStatement]))

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'release savepoint sp_1',
      'select 1',
      'commit',
    ])

    await db.close()
  })
})

describe('scoped transaction coordinator behavior: queues unrelated ancestor statements until a failing savepoint cleans up', () => {
  it('queues unrelated ancestor statements until a failing savepoint cleans up', async () => {
    const nestedStarted = deferred()
    const failNested = deferred()
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    let ancestor!: Parameters<Parameters<typeof db.transaction>[0]>[0]

    const transaction = db.transaction(async (trx) => {
      ancestor = trx

      await trx
        .transaction(async () => {
          nestedStarted.resolve()
          await failNested.promise
          throw new Error('nested callback failed')
        })
        .catch(() => undefined)
    })

    await nestedStarted.promise
    const ancestorStatement = ancestor.ping()
    await Promise.resolve()
    expect(controls.calls.map((entry) => entry.sql)).toEqual(['begin', 'savepoint sp_1'])

    failNested.resolve()
    await withDeadline(Promise.all([transaction, ancestorStatement]))

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'rollback to savepoint sp_1',
      'release savepoint sp_1',
      'select 1',
      'commit',
    ])

    await db.close()
  })
})

describe('scoped transaction cleanup failures', () => {
  it('poisons cleanup failure and suppresses queued sibling and ancestor SQL', async () => {
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^rollback to savepoint/i.test(sql)) {
          throw new Error('savepoint rollback cleanup failed')
        }
      },
    })

    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const transaction = db.transaction(async (trx) => {
      await Promise.all([
        trx.transaction(async () => {
          throw new Error('primary nested failure')
        }),
        trx.transaction(async (sibling) => sibling.ping()),
        trx.ping(),
      ])
    })

    await expect(withDeadline(transaction)).rejects.toThrow(/primary nested failure/i)

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'rollback to savepoint sp_1',
      'rollback',
    ])

    expect(controls.events).toContain('release-started:1:discard')
    await db.close()
  })
})

describe('scoped transaction cleanup failures: poisons failed savepoint release and suppresses all queued scoped SQL', () => {
  it('poisons failed savepoint release and suppresses all queued scoped SQL', async () => {
    const controls = createControllableProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (/^release savepoint sp_1$/i.test(sql)) {
          throw new Error('savepoint release cleanup failed')
        }
      },
    })

    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const transaction = db.transaction(async (trx) => {
      await Promise.all([
        trx.transaction(async () => undefined),
        trx.transaction(async (sibling) => sibling.ping()),
        trx.ping(),
      ])
    })

    await expect(withDeadline(transaction)).rejects.toThrow(
      /savepoint release cleanup failed/i,
    )

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'release savepoint sp_1',
      'rollback',
    ])

    expect(controls.events).toContain('release-started:1:discard')
    await db.close()
  })
})

describe('scoped transaction cleanup failures: drains an accepted sibling savepoint before root rollback', () => {
  it('drains an accepted sibling savepoint before root rollback', async () => {
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector('postgresql'),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    await expect(
      db.transaction(async (trx) => {
        await Promise.all([
          trx.transaction(async () => {
            throw new Error('first sibling failed')
          }),
          trx.transaction(async (second) => second.ping()),
        ])
      }),
    ).rejects.toThrow(/first sibling failed/i)

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'savepoint sp_1',
      'rollback to savepoint sp_1',
      'release savepoint sp_1',
      'savepoint sp_2',
      'select 1',
      'release savepoint sp_2',
      'rollback',
    ])

    await db.close()
  })
})
