import type { Connector } from 'db0'
import { describe, expect, it } from 'vitest'

import type { Db } from '@/index'
import { createDatabase } from '@/index'
import {
  OperationCoordinator,
  getOperationReleaseCleanupFailures,
} from '@/operations/coordinator'
import type { OperationSessionProvider } from '@/operations/operationSession'
import type { TableHandle } from '@/types'

import { deferred } from '../../helpers/deferredPromise'

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
  calls: { session: number; sql: string }[]
  readonly openCount: number
  readonly maxActiveCalls: number
  readonly closeCount: number
}>

export type ProviderContractFactory = (
  options?: ProviderContractFactoryOptions,
) => ProviderContractControls

export type ProviderMigrationContract = Readonly<{
  /**
   * Returns the connector owned by the operation-session fixture.
   *
   * @returns The connector owned by the operation-session fixture.
   */
  connector(): Connector
  /**
   * Returns table handles used to exercise successful migration through the provider.
   *
   * @returns Table handles used to exercise successful migration through the provider.
   */
  appliedSchemas(): readonly TableHandle[]
  /**
   * Returns table handles whose metadata forces a planning failure.
   *
   * @returns Table handles whose metadata forces a planning failure.
   */
  planningFailureSchemas(): readonly TableHandle[]
}>

export type ProviderMigrationSupport =
  | Readonly<{ state: 'supported'; input: ProviderMigrationContract }>
  | Readonly<{ state: 'unsupported'; reason: string }>

/** Validates explicit provider migration participation before any contract registers. */
export function validateProviderMigrationSupport(
  migration: unknown,
): asserts migration is ProviderMigrationSupport {
  if (typeof migration !== 'object' || migration === null)
    throw new Error(
      'Controlled operation-session contract needs explicit migration participation',
    )

  const support = migration as {
    state?: unknown
    reason?: unknown
    input?: Partial<ProviderMigrationContract>
  }

  if (support.state === 'unsupported') {
    if (typeof support.reason !== 'string' || support.reason.trim().length === 0)
      throw new Error(
        'Controlled operation-session migration needs a non-empty unsupported reason',
      )

    return
  }

  if (support.state !== 'supported')
    throw new Error(
      'Controlled operation-session contract needs explicit migration participation',
    )

  const input = support.input

  if (
    !input ||
    typeof input.connector !== 'function' ||
    typeof input.appliedSchemas !== 'function' ||
    typeof input.planningFailureSchemas !== 'function'
  )
    throw new Error(
      'Supported controlled operation-session migration needs connector, appliedSchemas, and planningFailureSchemas',
    )
}

/**
 * Registers the scenario that forwards cancellation and honours discard disposition.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerLifecycleScenarios(createProvider: ProviderContractFactory): void {
  it('should forward cancellation and honor discard disposition', async () => {
    const controls = createProvider()
    const coordinator = new OperationCoordinator(controls.provider)

    try {
      await coordinator.run(async ({ cancel, discard }) => {
        await cancel()
        discard()
      })

      expect(controls.events).toContain('cancel-requested:1')
      expect(controls.events).toContain('release-finished:1:discard')
    } finally {
      await coordinator.close()
    }
  })
}

/**
 * Registers the scenario that serializes leases and drains release before shutdown.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerLeaseDrainScenario(createProvider: ProviderContractFactory) {
  it('should serialize leases and drain release before shutdown', async () => {
    const started = deferred()
    const finish = deferred()
    const controls = createProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
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
    expect(controls.events).not.toContain('provider-closed')
    finish.resolve()
    await Promise.all([first, second, close])

    expect(controls.events.indexOf('release-finished:2:reuse')).toBeLessThan(
      controls.events.indexOf('provider-closed'),
    )
  })
}

/**
 * Registers the scenario that provides non-empty stable physical identity and a complete
 * lifecycle.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerStableIdentityScenario(createProvider: ProviderContractFactory) {
  it('should provide non-empty stable physical identity and a complete lifecycle', async () => {
    const controls = createProvider()
    const session = await controls.provider.open()
    const identity = session.identity
    const initialDatabase = identity.database
    const initialPhysicalSession = identity.physicalSession

    expect(identity.database.length).toBeGreaterThan(0)
    expect(identity.physicalSession.length).toBeGreaterThan(0)

    await Promise.all([
      session.query({ sql: 'contract query', params: [] }),
      session.run({ sql: 'contract run', params: [] }),
    ])

    expect(session.identity).toMatchObject({
      database: initialDatabase,
      physicalSession: initialPhysicalSession,
    })

    await session.release('reuse')
    await controls.provider.close()

    expect(controls.events).toContain('release-finished:1:reuse')
    expect(controls.events.at(-1)).toBe('provider-closed')
    expect(controls.maxActiveCalls).toBe(1)
    expect(controls.closeCount).toBe(1)
  })
}

/**
 * Registers the scenario that keeps a call failure primary when identity verification
 * also fails.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerIdentityScenarios(createProvider: ProviderContractFactory): void {
  it('should keep a call failure primary when identity verification also fails', async () => {
    const primary = new Error('named statement failure')
    const controls = createProvider({
      mutateIdentityAfterCall: true,
      mutationFailure: { session: 1, value: primary },
    })

    const coordinator = new OperationCoordinator(controls.provider)

    try {
      const error = await coordinator
        .run(({ executor }) => executor.run({ sql: 'mutate then fail', params: [] }))
        .catch((cause: unknown) => cause)

      expect(error).toBe(primary)

      const cleanupFailures = getOperationReleaseCleanupFailures(error)
      expect(cleanupFailures).toHaveLength(1)

      expect(cleanupFailures[0]).toMatchObject({
        _tag: 'QueryError',
        message: expect.stringMatching(/identity changed/i) as unknown,
      })

      expect(controls.events).toContain('release-finished:1:discard')
      expect(controls.events).not.toContain('release-finished:1:reuse')
    } finally {
      await coordinator.close()
    }
  })
}

/**
 * Registers the scenario that discards a session whose physical identity changes.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerIdentityChangeScenario(createProvider: ProviderContractFactory) {
  it('should discard a session whose physical identity changes', async () => {
    const controls = createProvider({ mutateIdentityAfterCall: true })
    const coordinator = new OperationCoordinator(controls.provider)

    try {
      await expect(
        coordinator.run(({ executor }) =>
          executor.run({ sql: 'mutate identity', params: [] }),
        ),
      ).rejects.toThrow(/identity changed/i)

      expect(controls.events).toContain('release-finished:1:discard')
    } finally {
      await coordinator.close()
    }
  })
}

/**
 * Registers the scenario that cancels active unsettled work, settles it, and discards
 * uncertain state.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerUnsettledCancellationScenario(createProvider: ProviderContractFactory) {
  it('should cancel active unsettled work, settle it, and discard uncertain state', async () => {
    const started = deferred()
    const cancelled = deferred()
    const controls = createProvider({
      /** Runs the configured synchronization or failure control before a fixture SQL call. */
      beforeCall: async (_session, sql) => {
        if (sql !== 'active unsettled') return

        started.resolve()
        await cancelled.promise
      },
      /** Signals or holds cancellation to expose the requested concurrency scenario. */
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
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
        ]),
      ).resolves.toBe('settled')

      expect(controls.events).toContain('cancel-requested:1')
      expect(controls.events).toContain('release-finished:1:discard')
    } finally {
      await coordinator.close()
    }
  })
}

/**
 * Registers the scenario that discards a session with invalid initial %s evidence.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerInvalidSessionScenario(createProvider: ProviderContractFactory) {
  it.each(['identity', 'capability'] as const)(
    'should discard a session with invalid initial %s evidence',
    async (invalidInitialSession) => {
      const controls = createProvider({ invalidInitialSession })
      const coordinator = new OperationCoordinator(controls.provider)

      try {
        await expect(coordinator.run(async () => undefined)).rejects.toThrow(
          /invalid pinned session/i,
        )

        expect(controls.events).toContain('release-finished:1:discard')
        expect(controls.events).not.toContain('release-finished:1:reuse')
      } finally {
        await coordinator.close()
      }
    },
  )
}

/**
 * Registers the scenario that captures immutable context identity before reuse and
 * discards when the next live read fails.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerIdentityFailureScenarios(createProvider: ProviderContractFactory): void {
  registerCombinedIdentityCleanupScenario(createProvider)
  registerPrimitiveFailureScenario(createProvider)

  it('should capture immutable context identity before reuse and discard when the next live read fails', async () => {
    const defect = new Error('identity verification failed')
    const controls = createProvider({
      identityReadFailure: {
        session: 1,
        read: 2,
        value: defect,
      },
    })

    const coordinator = new OperationCoordinator(controls.provider)
    let captured:
      | { readonly database: string; readonly physicalSession: string }
      | undefined
    let capturedWasFrozen = false

    try {
      const error = await coordinator
        .run(async ({ identity }) => {
          captured = identity
          capturedWasFrozen = Object.isFrozen(identity)
        })
        .catch((cause: unknown) => cause)

      expect(captured).toEqual({
        database: 'coordinator_test',
        physicalSession: 'physical-1',
      })

      expect(capturedWasFrozen).toBe(true)

      expect(error).toBe(defect)
      expect(controls.events).toContain('release-finished:1:discard')
      expect(controls.events).not.toContain('release-finished:1:reuse')
    } finally {
      await coordinator.close()
    }
  })

  registerInitialIdentityFailureScenario(createProvider)
}

/**
 * Registers the scenario that discards when initial identity capture cannot be proven and
 * never invokes the callback.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerInitialIdentityFailureScenario(createProvider: ProviderContractFactory) {
  it('should discard when initial identity capture cannot be proven and never invokes the callback', async () => {
    const defect = new Error('initial identity capture failed')
    const controls = createProvider({
      identityReadFailure: {
        session: 1,
        read: 1,
        value: defect,
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
      expect(error).toBe(defect)
      expect(controls.events).toContain('release-finished:1:discard')
      expect(controls.events).not.toContain('release-finished:1:reuse')
    } finally {
      await coordinator.close()
    }
  })
}

/**
 * Registers the scenario that preserves a primitive primary when identity verification
 * fails.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerPrimitiveFailureScenario(createProvider: ProviderContractFactory) {
  it('should preserve a primitive primary when identity verification fails', async () => {
    const controls = createProvider({ mutateIdentityAfterCall: true })
    const coordinator = new OperationCoordinator(controls.provider)

    try {
      await expect(
        coordinator.run(async ({ executor }) => {
          await executor.run({ sql: 'mutate identity', params: [] })
          throw undefined
        }),
      ).rejects.toBeUndefined()

      expect(getOperationReleaseCleanupFailures(undefined)).toEqual([])
      expect(controls.events).toContain('release-finished:1:discard')
      expect(controls.events).not.toContain('release-finished:1:reuse')
    } finally {
      await coordinator.close()
    }
  })
}

/**
 * Registers the scenario that retains identity verification evidence before a later
 * release failure.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerCombinedIdentityCleanupScenario(
  createProvider: ProviderContractFactory,
) {
  it('should retain identity verification evidence before a later release failure', async () => {
    const primary = new Error('named statement failure')
    const release = new Error('release cleanup failure')
    const controls = createProvider({
      mutateIdentityAfterCall: true,
      mutationFailure: { session: 1, value: primary },
      releaseFailure: { session: 1, value: release },
    })

    const coordinator = new OperationCoordinator(controls.provider)

    try {
      const error = await coordinator
        .run(({ executor }) => executor.run({ sql: 'mutate then fail', params: [] }))
        .catch((cause: unknown) => cause)

      expect(error).toBe(primary)

      const cleanupFailures = getOperationReleaseCleanupFailures(error)
      expect(cleanupFailures).toHaveLength(2)

      expect(cleanupFailures[0]).toMatchObject({
        _tag: 'QueryError',
        message: expect.stringMatching(/identity changed/i) as unknown,
      })

      expect(cleanupFailures[1]).toBe(release)
      expect(controls.events).toContain('release-started:1:discard')
      expect(controls.events).not.toContain('release-started:1:reuse')
    } finally {
      await coordinator.close()
    }
  })
}

/**
 * Registers the scenario that retains release cleanup without replacing the primary
 * failure.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerReleaseScenarios(createProvider: ProviderContractFactory): void {
  it('should retain release cleanup without replacing the primary failure', async () => {
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

  it('should retain release cleanup when final identity verification also fails', async () => {
    const release = new Error('release cleanup failure')
    const defect = new Error('identity verification failed')
    const controls = createProvider({
      identityReadFailure: {
        session: 1,
        read: 2,
        value: defect,
      },
      releaseFailure: { session: 1, value: release },
    })

    const coordinator = new OperationCoordinator(controls.provider)

    try {
      const error = await coordinator
        .run(async () => undefined)
        .catch((cause: unknown) => cause)

      expect(error).toBe(defect)
      expect(getOperationReleaseCleanupFailures(error)).toEqual([release])
    } finally {
      await coordinator.close()
    }
  })
}

/**
 * Registers the scenario that preserves final identity cleanup evidence across plan and
 * execute wrapping.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 * @param migration - Planned migration whose steps or preview are inspected.
 */
function registerMigrationScenarios(
  createProvider: ProviderContractFactory,
  migration: ProviderMigrationContract,
): void {
  registerMigrationOutcomeScenarios(createProvider, migration)

  it('should preserve final identity cleanup evidence across plan and execute wrapping', async () => {
    const release = new Error('release cleanup failure')
    let verificationFailure = new Error('identity verification failed')

    /** Creates the cleanup failure db fixture used by the contract scenario. */
    const createCleanupFailureDb = () =>
      createDatabase({
        connector: migration.connector(),
        operationSessionProvider: createProvider({
          identityReadFailure: {
            session: 1,
            read: 2,
            value: verificationFailure,
          },
          releaseFailure: { session: 1, value: release },
        }).provider,
        schemas: migration.appliedSchemas(),
      })

    await assertPlanningIdentityCleanup(
      createCleanupFailureDb,
      verificationFailure,
      release,
    )

    verificationFailure = new Error('identity verification failed')
    const executeDb = createCleanupFailureDb()

    try {
      await expect(executeDb.migrate().execute()).rejects.toMatchObject({
        _tag: 'MigrationError',
        defect: true,
        stage: 'sessionCleanup',
        outcome: 'applied',
        cause: verificationFailure,
        cleanupFailures: [
          { stage: 'sessionCleanup', cause: verificationFailure },
          { stage: 'sessionCleanup', cause: release },
        ],
      })
    } finally {
      await executeDb.close()
    }
  })

  registerPlanningCleanupFailure(migration, createProvider)
}

/**
 * Registers planning cleanup failure checks against the selected dialect contract.
 *
 * @param migration - Planned migration whose steps or preview are inspected.
 * @param createProvider - Factory for a provider with the requested test controls.
 */
function registerPlanningCleanupFailure(
  migration: ProviderMigrationContract,
  createProvider: ProviderContractFactory,
) {
  it('should retain exact release cleanup when planning already failed structurally', async () => {
    const release = new Error('release cleanup failure')
    const db = createDatabase({
      connector: migration.connector(),
      operationSessionProvider: createProvider({
        releaseFailure: { session: 1, value: release },
      }).provider,
      schemas: migration.planningFailureSchemas(),
    })

    try {
      await expect(db.migrate().plan()).rejects.toMatchObject({
        _tag: 'MigrationError',
        stage: 'planning',
        cleanupFailures: [{ stage: 'sessionCleanup', cause: release }],
      })
    } finally {
      await db.close()
    }
  })
}

/**
 * Checks retained identity-verification and provider-release cleanup evidence during
 * planning.
 *
 * @param createCleanupFailureDb - Factory for a database whose session cleanup
 *   deliberately fails.
 * @param release - Callback that releases the fixture hold or lock.
 */
async function assertPlanningIdentityCleanup(
  createCleanupFailureDb: () => Db,
  verificationFailure: Error,
  release: Error,
) {
  const planningDb = createCleanupFailureDb()

  try {
    const failure = await planningDb
      .migrate()
      .plan()
      .catch((cause: unknown) => cause)

    expect(failure).toBe(verificationFailure)
    expect(getOperationReleaseCleanupFailures(failure)).toEqual([release])
  } finally {
    await planningDb.close()
  }
}

/**
 * Registers the scenario that preserves applied and unchanged migration outcomes across
 * release failure.
 *
 * @param createProvider - Factory for a provider with the requested test controls.
 * @param migration - Planned migration whose steps or preview are inspected.
 */
function registerMigrationOutcomeScenarios(
  createProvider: ProviderContractFactory,
  migration: ProviderMigrationContract,
) {
  it('should preserve applied and unchanged migration outcomes across release failure', async () => {
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
}

/**
 * Registers the common contract for an exclusive native operation-session provider.
 *
 * Migration participation is explicit. Supported fixtures exercise cleanup while
 * unsupported fixtures declare a reason.
 */
export function registerOperationSessionProviderContract(
  name: string,
  createProvider: ProviderContractFactory,
  migration: ProviderMigrationSupport,
): void {
  if (typeof createProvider !== 'function')
    throw new Error('Controlled operation-session contract needs a provider factory')

  validateProviderMigrationSupport(migration)

  describe(`${name} Dialect contract [operation-session/controlled]`, () => {
    registerStableIdentityScenario(createProvider)
    registerLeaseDrainScenario(createProvider)
    registerLifecycleScenarios(createProvider)
    registerInvalidSessionScenario(createProvider)
    registerUnsettledCancellationScenario(createProvider)
    registerIdentityChangeScenario(createProvider)
    registerIdentityScenarios(createProvider)
    registerIdentityFailureScenarios(createProvider)
    registerReleaseScenarios(createProvider)

    if (migration.state === 'supported') {
      registerMigrationScenarios(createProvider, migration.input)
    } else {
      it('should declare unsupported provider migration participation with a reason', () => {
        expect(migration.reason.trim().length).toBeGreaterThan(0)
      })
    }
  })
}
