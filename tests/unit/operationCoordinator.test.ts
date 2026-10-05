import { describe, expect, it } from 'vitest'

import { QueryError, createDatabase } from '@/index'
import type { OperationSessionProvider } from '@/index'
import { OperationCoordinator } from '@/operations/coordinator'

import { deferred } from '../helpers/deferredPromise'

import {
  createControllableProvider,
  customConnector,
  withDeadline,
} from './helpers/operationSessionFixtures'

describe('OperationCoordinator', () => {
  it('snapshots nested namespace identity and discards when the live context changes', async () => {
    const namespaceContext = {
      writableDefault: [
        { role: 'database' as const, spelling: 'coordinator_test' },
        { role: 'schema' as const, spelling: 'public' },
      ],
    }
    const dispositions: string[] = []
    const provider: OperationSessionProvider = createMutableNamespaceProvider(
      namespaceContext,
      dispositions,
    )
    const coordinator = new OperationCoordinator(provider)
    let capturedSchema: string | undefined

    try {
      const error = await coordinator
        .run(async ({ identity }) => {
          namespaceContext.writableDefault[1]!.spelling = 'tenant'
          capturedSchema = identity.namespaceContext?.writableDefault[1]?.spelling
        })
        .catch((cause: unknown) => cause)

      expect(capturedSchema).toBe('public')
      expect(error).toBeInstanceOf(QueryError)

      expect(error).toMatchObject({
        message: expect.stringMatching(/identity changed/i) as unknown,
      })

      expect(dispositions).toEqual(['discard'])
    } finally {
      await coordinator.close()
    }
  })
})

describe('OperationCoordinator: advances the queue and closes after an early provider-open failure', () => {
  it('advances the queue and closes after an early provider-open failure', async () => {
    const controls = createControllableProvider({
      openFailure: { session: 1, value: new Error('open failed') },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const first = db.ping()
    const successor = db.ping()
    const close = db.close()
    await expect(withDeadline(first)).rejects.toThrow(/open failed/i)
    await expect(withDeadline(successor)).resolves.toBeUndefined()
    await expect(withDeadline(close)).resolves.toBeUndefined()

    expect(controls.events).toEqual([
      'lease-opened:1',
      'lease-opened:2',
      'statement:2:select 1',
      'release-started:2:reuse',
      'release-finished:2:reuse',
      'provider-closed',
    ])
  })
})

describe('OperationCoordinator: rejects descendant root use across nested clients without deadlocking', () => {
  it('rejects descendant root use across nested clients without deadlocking', async () => {
    const firstControls = createControllableProvider()
    const secondControls = createControllableProvider()
    const first = createDatabase({
      connector: customConnector(),
      operationSessionProvider: firstControls.provider,
      schemas: [],
    })
    const second = createDatabase({
      connector: customConnector(),
      operationSessionProvider: secondControls.provider,
      schemas: [],
    })

    const operation = first.transaction(async () =>
      second.transaction(async () => first.ping()),
    )
    await expect(withDeadline(operation)).rejects.toThrow(/root database client/i)
    expect(firstControls.openCount).toBe(1)
    expect(secondControls.openCount).toBe(1)
    await Promise.all([first.close(), second.close()])
  })
})

describe('OperationCoordinator: rejects descendant root use across nested clients without deadlocking: retains savepoint ancestry across another client coordinator', () => {
  it('retains savepoint ancestry across another client coordinator', async () => {
    const firstControls = createControllableProvider()
    const secondControls = createControllableProvider()
    const first = createDatabase({
      connector: customConnector(),
      operationSessionProvider: firstControls.provider,
      schemas: [],
    })
    const second = createDatabase({
      connector: customConnector(),
      operationSessionProvider: secondControls.provider,
      schemas: [],
    })

    const invalid = first.transaction(async (firstTrx) =>
      firstTrx.transaction(async () => second.transaction(async () => firstTrx.ping())),
    )
    await expect(withDeadline(invalid)).rejects.toThrow(/use the nested callback client/i)

    await withDeadline(
      first.transaction(async (firstTrx) => {
        await firstTrx.transaction(async (nestedFirst) => {
          await second.transaction(async (secondTrx) => secondTrx.ping())
          await nestedFirst.ping()
        })
      }),
    )

    expect(firstControls.openCount).toBe(2)
    expect(secondControls.openCount).toBe(2)
    await Promise.all([first.close(), second.close()])
  })
})

describe('OperationCoordinator queue and shutdown', () => {
  it('keeps FIFO order across failures and release cleanup', async () => {
    const releaseFirst = deferred()
    const releaseStarted = deferred()
    const controls = createControllableProvider({
      failSession: 1,
      /** Signals or holds release to expose the requested cleanup scenario. */
      beforeRelease: (session) => {
        if (session !== 1) return Promise.resolve()

        releaseStarted.resolve()
        return releaseFirst.promise
      },
    })
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const first = db.ping()
    const second = db.ping()
    await releaseStarted.promise
    expect(controls.openCount).toBe(1)
    releaseFirst.resolve()
    await expect(first).rejects.toThrow(/session 1 failed/i)
    await expect(second).resolves.toBeUndefined()

    expect(controls.events.slice(0, 6)).toEqual([
      'lease-opened:1',
      'statement:1:select 1',
      'release-started:1:reuse',
      'release-finished:1:reuse',
      'lease-opened:2',
      'statement:2:select 1',
    ])

    await db.close()
  })
})

describe('OperationCoordinator queue and shutdown: rejects callback root reentrancy while unrelated roots wait FIFO', () => {
  it('rejects callback root reentrancy while unrelated roots wait FIFO', async () => {
    const callbackStarted = deferred()
    const finishCallback = deferred()
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const transaction = db.transaction(async () => {
      callbackStarted.resolve()
      await expect(db.ping()).rejects.toBeInstanceOf(QueryError)
      await expect(db.close()).rejects.toThrow(/active operation callback/i)
      await finishCallback.promise
    })
    await callbackStarted.promise
    const unrelated = db.ping()
    await Promise.resolve()
    expect(controls.openCount).toBe(1)
    finishCallback.resolve()
    await transaction
    await unrelated
    expect(controls.openCount).toBe(2)
    await db.close()
  })
})

describe('OperationCoordinator queue and shutdown: lets an accepted transaction keep using its scoped client while close drains', () => {
  it('lets an accepted transaction keep using its scoped client while close drains', async () => {
    const callbackStarted = deferred()
    const resumeCallback = deferred()
    const controls = createControllableProvider()
    const db = createDatabase({
      connector: customConnector(),
      operationSessionProvider: controls.provider,
      schemas: [],
    })

    const transaction = db.transaction(async (trx) => {
      callbackStarted.resolve()
      await resumeCallback.promise
      await trx.ping()
    })
    await callbackStarted.promise
    const close = db.close()
    await expect(db.ping()).rejects.toThrow(/closed/i)
    resumeCallback.resolve()

    await transaction
    await close

    expect(controls.calls.map((entry) => entry.sql)).toEqual([
      'begin',
      'select 1',
      'commit',
    ])

    expect(controls.events.at(-1)).toBe('provider-closed')
  })
})

describe('OperationCoordinator queue and shutdown: rejects providers without mandatory native transaction semantics', () => {
  it('rejects providers without mandatory native transaction semantics', () => {
    expect(
      () =>
        new OperationCoordinator({
          /** Opens an exclusive fixture session with lifecycle controls. */
          open() {},
          /** Closes the fixture provider after its leases settle. */
          close() {},
        } as never),
    ).toThrow(/native transaction semantics/i)
  })
})

/**
 * Exposes mutable native namespace evidence to verify coordinator snapshots.
 *
 * @param namespaceContext - Live writable namespace mutated by the scenario.
 * @param dispositions - Release dispositions observed after identity verification.
 *
 * @returns A provider retaining the supplied live namespace object.
 */
function createMutableNamespaceProvider(
  namespaceContext: NonNullable<
    Awaited<ReturnType<OperationSessionProvider['open']>>['identity']['namespaceContext']
  >,
  dispositions: string[],
): OperationSessionProvider {
  return {
    nativeTransactions: true,
    /** Opens an exclusive fixture session with lifecycle controls. */
    async open() {
      return {
        identity: {
          database: 'coordinator_test',
          physicalSession: 'physical-namespace',
          namespaceContext,
        },
        /** Runs fixture SQL and records physical-session ownership. */
        async query() {
          return []
        },
        /** Runs a fixture statement with configured outcomes. */
        async run() {},
        /** Cancels the active physical-session operation. */
        async cancel() {},
        /** Releases the fixture lease with configured cleanup behavior. */
        async release(disposition) {
          dispositions.push(disposition)
        },
      }
    },
    /** Closes the fixture provider after its leases settle. */
    async close() {},
  }
}
