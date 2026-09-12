import type { Connector } from 'db0'
import { describe, expect, it } from 'vitest'

import { createDatabase } from '@/index'
import {
  OperationCoordinator,
  getOperationReleaseCleanupFailures,
} from '@/operations/coordinator'
import type { OperationSessionProvider } from '@/operations/operationSession'
import type { TableHandle } from '@/types'

type Deferred = Readonly<{
  promise: Promise<void>
  resolve(): void
}>

function deferred(): Deferred {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve,
  }
}

export type ProviderContractFactoryOptions = Readonly<{
  beforeCall?: (session: number, sql: string) => Promise<void>
  beforeCancel?: (session: number) => Promise<void>
  releaseFailure?: Readonly<{ session: number; value: unknown }>
  identityReadFailure?: Readonly<{ session: number; read: number; value: unknown }>
  mutateIdentityAfterCall?: boolean
  mutationFailure?: Readonly<{ session: number; value: unknown }>
  invalidInitialSession?: 'identity' | 'capability'
}>

export type ProviderContractControls = Readonly<{
  provider: OperationSessionProvider
  events: string[]
  calls: Array<{ session: number; sql: string }>
  readonly openCount: number
  readonly maxActiveCalls: number
  readonly closeCount: number
}>

export type ProviderContractFactory = (
  options?: ProviderContractFactoryOptions,
) => ProviderContractControls

export type ProviderMigrationContract = Readonly<{
  connector(): Connector
  appliedSchemas(): readonly TableHandle[]
  planningFailureSchemas?(): readonly TableHandle[]
}>

/**
 * Registers the common contract for an exclusive native operation-session provider.
 *
 * Migration scenarios are optional because not every member advertises migration
 * support. When supplied, the suite also verifies that cleanup retains the member's
 * acknowledged applied/unchanged outcome.
 */
export function registerOperationSessionProviderContract(
  name: string,
  createProvider: ProviderContractFactory,
  migration?: ProviderMigrationContract,
): void {
  describe(`${name} Dialect contract [operation-session/controlled]`, () => {
    it('provides non-empty stable physical identity and a complete lifecycle', async () => {
      const controls = createProvider()
      const session = await controls.provider.open()
      const identity = session.identity

      expect(identity.database.length).toBeGreaterThan(0)
      expect(identity.physicalSession.length).toBeGreaterThan(0)
      await Promise.all([
        session.query({ sql: 'contract query', params: [] }),
        session.run({ sql: 'contract run', params: [] }),
      ])
      expect(session.identity).toBe(identity)
      await session.release('reuse')
      await controls.provider.close()

      expect(controls.events).toContain('release-end:1:reuse')
      expect(controls.events.at(-1)).toBe('provider-close')
      expect(controls.maxActiveCalls).toBe(1)
      expect(controls.closeCount).toBe(1)
    })

    it('serializes leases and drains release before shutdown', async () => {
      const started = deferred()
      const finish = deferred()
      const controls = createProvider({
        beforeCall: async (session) => {
          if (session !== 1) return

          started.resolve()
          await finish.promise
        },
      })
      const coordinator = new OperationCoordinator(controls.provider)
      const first = coordinator.run(({ executor }) =>
        executor.run({ sql: 'first', params: [] }),
      )
      await started.promise
      const second = coordinator.run(({ executor }) =>
        executor.run({ sql: 'second', params: [] }),
      )
      const close = coordinator.close()

      expect(controls.openCount).toBe(1)
      expect(controls.events).not.toContain('provider-close')
      finish.resolve()
      await Promise.all([first, second, close])

      expect(controls.events.indexOf('release-end:2:reuse')).toBeLessThan(
        controls.events.indexOf('provider-close'),
      )
    })

    it('forwards cancellation and honours discard disposition', async () => {
      const controls = createProvider()
      const coordinator = new OperationCoordinator(controls.provider)

      try {
        await coordinator.run(async ({ cancel, discard }) => {
          await cancel()
          discard()
        })

        expect(controls.events).toContain('cancel:1')
        expect(controls.events).toContain('release-end:1:discard')
      } finally {
        await coordinator.close()
      }
    })

    it.each(['identity', 'capability'] as const)(
      'discards a session with invalid initial %s evidence',
      async (invalidInitialSession) => {
        const controls = createProvider({ invalidInitialSession })
        const coordinator = new OperationCoordinator(controls.provider)

        try {
          await expect(coordinator.run(async () => undefined)).rejects.toThrow(
            /invalid pinned session/i,
          )
          expect(controls.events).toContain('release-end:1:discard')
          expect(controls.events).not.toContain('release-end:1:reuse')
        } finally {
          await coordinator.close()
        }
      },
    )

    it('cancels active unsettled work, settles it, and discards uncertain state', async () => {
      const started = deferred()
      const cancelled = deferred()
      const controls = createProvider({
        beforeCall: async (_session, sql) => {
          if (sql !== 'active unsettled') return

          started.resolve()
          await cancelled.promise
        },
        beforeCancel: async () => cancelled.resolve(),
      })
      const coordinator = new OperationCoordinator(controls.provider)

      try {
        const operation = coordinator.run(async ({ executor, cancel }) => {
          const unsettled = executor.run({ sql: 'active unsettled', params: [] })
          await started.promise
          await cancel()
          await unsettled
        })
        await expect(
          Promise.race([
            operation.then(() => 'settled' as const),
            new Promise<'timeout'>((resolve) =>
              setTimeout(() => resolve('timeout'), 1_000),
            ),
          ]),
        ).resolves.toBe('settled')
        expect(controls.events).toContain('cancel:1')
        expect(controls.events).toContain('release-end:1:discard')
      } finally {
        await coordinator.close()
      }
    })

    it('discards a session whose physical identity changes', async () => {
      const controls = createProvider({ mutateIdentityAfterCall: true })
      const coordinator = new OperationCoordinator(controls.provider)

      try {
        await expect(
          coordinator.run(({ executor }) =>
            executor.run({ sql: 'mutate identity', params: [] }),
          ),
        ).rejects.toThrow(/identity changed/i)
        expect(controls.events).toContain('release-end:1:discard')
      } finally {
        await coordinator.close()
      }
    })

    it('keeps a call failure primary when identity verification also fails', async () => {
      const primary = new Error('primary operation failure after identity mutation')
      const controls = createProvider({
        mutateIdentityAfterCall: true,
        mutationFailure: { session: 1, value: primary },
      })
      const coordinator = new OperationCoordinator(controls.provider)

      try {
        const error = await coordinator
          .run(({ executor }) => executor.run({ sql: 'mutate then fail', params: [] }))
          .catch((cause: unknown) => cause)

        expect(error).toBeInstanceOf(Error)
        expect(error).toMatchObject({ cause: primary })
        expect((error as Error).message).toBe(primary.message)
        expect(controls.events).toContain('release-end:1:discard')
        expect(controls.events).not.toContain('release-end:1:reuse')
      } finally {
        await coordinator.close()
      }
    })

    it('captures immutable context identity before reuse and discards when the next live read fails', async () => {
      const controls = createProvider({
        identityReadFailure: {
          session: 1,
          read: 2,
          value: new Error('identity verification failed'),
        },
      })
      const coordinator = new OperationCoordinator(controls.provider)
      let captured:
        | { readonly database: string; readonly physicalSession: string }
        | undefined

      try {
        const error = await coordinator
          .run(async ({ identity }) => {
            captured = identity
            expect(identity).toEqual({
              database: 'coordinator_test',
              physicalSession: 'physical-1',
            })
            expect(Object.isFrozen(identity)).toBe(true)
          })
          .catch((cause: unknown) => cause)

        expect(captured).toEqual({
          database: 'coordinator_test',
          physicalSession: 'physical-1',
        })
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(/verify operation session identity/i)
        expect(controls.events).toContain('release-end:1:discard')
        expect(controls.events).not.toContain('release-end:1:reuse')
      } finally {
        await coordinator.close()
      }
    })

    it('discards when initial identity capture cannot be proven and never invokes the callback', async () => {
      const controls = createProvider({
        identityReadFailure: {
          session: 1,
          read: 1,
          value: new Error('initial identity capture failed'),
        },
      })
      const coordinator = new OperationCoordinator(controls.provider)
      let invoked = false

      try {
        const error = await coordinator
          .run(async () => {
            invoked = true
          })
          .catch((cause: unknown) => cause)

        expect(invoked).toBe(false)
        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(/capture operation session identity/i)
        expect(controls.events).toContain('release-end:1:discard')
        expect(controls.events).not.toContain('release-end:1:reuse')
      } finally {
        await coordinator.close()
      }
    })

    it('retains release cleanup without replacing the primary failure', async () => {
      const primary = new Error('primary operation failure')
      const release = new Error('release cleanup failure')
      const controls = createProvider({
        releaseFailure: { session: 1, value: release },
      })
      const coordinator = new OperationCoordinator(controls.provider)

      try {
        const error = await coordinator
          .run(async () => {
            throw primary
          })
          .catch((cause: unknown) => cause)

        expect(error).toBe(primary)
        expect(getOperationReleaseCleanupFailures(error)).toEqual([release])
      } finally {
        await coordinator.close()
      }
    })

    it('retains release cleanup when final identity verification also fails', async () => {
      const release = new Error('release cleanup failure')
      const controls = createProvider({
        identityReadFailure: {
          session: 1,
          read: 2,
          value: new Error('identity verification failed'),
        },
        releaseFailure: { session: 1, value: release },
      })
      const coordinator = new OperationCoordinator(controls.provider)

      try {
        const error = await coordinator
          .run(async () => undefined)
          .catch((cause: unknown) => cause)

        expect(error).toBeInstanceOf(Error)
        expect((error as Error).message).toMatch(/verify operation session identity/i)
        expect(getOperationReleaseCleanupFailures(error)).toEqual([release])
      } finally {
        await coordinator.close()
      }
    })

    if (migration) {
      it('preserves applied and unchanged migration outcomes across release failure', async () => {
        const release = new Error('migration session release failure')
        const appliedControls = createProvider({
          releaseFailure: { session: 1, value: release },
        })
        const applied = createDatabase({
          connector: migration.connector(),
          operationSessionProvider: appliedControls.provider,
          schemas: migration.appliedSchemas(),
        })

        try {
          await expect(applied.migrate().execute()).rejects.toMatchObject({
            _tag: 'MigrationError',
            stage: 'sessionCleanup',
            outcome: 'applied',
            cleanupFailures: [{ stage: 'sessionCleanup', cause: release }],
          })
        } finally {
          await applied.close()
        }

        const unchangedControls = createProvider({
          releaseFailure: { session: 1, value: release },
        })
        const unchanged = createDatabase({
          connector: migration.connector(),
          operationSessionProvider: unchangedControls.provider,
          schemas: [],
        })

        try {
          await expect(unchanged.migrate().execute()).rejects.toMatchObject({
            _tag: 'MigrationError',
            stage: 'sessionCleanup',
            outcome: 'unchanged',
            cleanupFailures: [{ stage: 'sessionCleanup', cause: release }],
          })
        } finally {
          await unchanged.close()
        }
      })

      it('preserves final identity cleanup evidence across dry-run and execute wrapping', async () => {
        const release = new Error('release cleanup failure')
        const createCleanupFailureDb = () =>
          createDatabase({
            connector: migration.connector(),
            operationSessionProvider: createProvider({
              identityReadFailure: {
                session: 1,
                read: 2,
                value: new Error('identity verification failed'),
              },
              releaseFailure: { session: 1, value: release },
            }).provider,
            schemas: migration.appliedSchemas(),
          })

        const dryRunDb = createCleanupFailureDb()

        try {
          await expect(dryRunDb.migrate().dryRun()).rejects.toMatchObject({
            _tag: 'MigrationError',
            cleanupFailures: [{ stage: 'sessionCleanup', cause: release }],
          })
        } finally {
          await dryRunDb.close()
        }

        const executeDb = createCleanupFailureDb()

        try {
          await expect(executeDb.migrate().execute()).rejects.toMatchObject({
            _tag: 'MigrationError',
            stage: 'sessionCleanup',
            outcome: 'applied',
            cleanupFailures: [
              {
                stage: 'sessionCleanup',
                cause: expect.objectContaining({
                  _tag: 'QueryError',
                  message: expect.stringMatching(/verify operation session identity/i),
                }),
              },
              { stage: 'sessionCleanup', cause: release },
            ],
          })
        } finally {
          await executeDb.close()
        }
      })

      const planningFailureSchemas = migration.planningFailureSchemas

      if (planningFailureSchemas) {
        it('retains exact release cleanup when dry-run planning already failed structurally', async () => {
          const release = new Error('release cleanup failure')
          const db = createDatabase({
            connector: migration.connector(),
            operationSessionProvider: createProvider({
              releaseFailure: { session: 1, value: release },
            }).provider,
            schemas: planningFailureSchemas(),
          })

          try {
            await expect(db.migrate().dryRun()).rejects.toMatchObject({
              _tag: 'MigrationError',
              stage: 'planning',
              cleanupFailures: [{ stage: 'sessionCleanup', cause: release }],
            })
          } finally {
            await db.close()
          }
        })
      }
    }
  })
}
