import { describe, expect, it } from 'vitest'

export type CoordinationContractEvent =
  | 'acquire'
  | 'release'
  | 'transaction'
  | 'introspection'
  | 'ddl'
  | 'unclassified'

/** Physical-dialect adapter for exercising exclusion without SQL assumptions. */
export type CoordinationContractLockManager = Readonly<{
  /**
   * Claims a fixture coordination lock when no competing owner holds it.
   *
   * @param owner - Canonical relation that owns the physical name or constraint.
   * @param key - Native row field or identity component being addressed.
   *
   * @returns True when the lock is free or already held by this owner.
   */
  tryAcquire(owner: string, key: string): boolean
  /**
   * Records lease release with the configured disposition and failure behavior.
   *
   * @param owner - Canonical relation that owns the physical name or constraint.
   * @param key - Native row field or identity component being addressed.
   */
  release(owner: string, key: string): void
}>

export type CoordinationContractRuntime = {
  /**
   * Executes the compiled query through its owning session or executor.
   *
   * @param options - Fixture controls for outcomes, observed calls, and failure
   *   scenarios.
   *
   * @returns The execute result used by the scenario.
   */
  execute(options?: {
    lockTimeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ outcome: 'applied' | 'unchanged' }>
  /**
   * Returns semantic operation events recorded by the fixture.
   *
   * @returns Semantic operation events recorded by the fixture.
   */
  events(): readonly CoordinationContractEvent[]
  /** Resolves an adapter-provided hold after the first protected phase starts. */
  releaseHold(): void
  /** Resolves when the requested semantic event has been observed. */
  waitFor(event: CoordinationContractEvent): Promise<void>
}

export type CoordinationContractFactory = (options?: {
  applicationId?: string
  clientId?: string
  lockResults?: boolean[]
  releaseResults?: boolean[]
  noWork?: boolean
  holdAfterTransaction?: boolean
  sharedLockManager?: CoordinationContractLockManager
}) => CoordinationContractRuntime

/**
 * Reports whether a runtime crossed into migration work protected by coordination.
 *
 * @param events - Semantic runtime events observed by the contract adapter.
 */
function protectedWork(events: readonly CoordinationContractEvent[]): boolean {
  return events.some((event) => ['transaction', 'introspection', 'ddl'].includes(event))
}

/** Reports whether coordination encloses a genuine transaction event. */
function hasCoordinatedTransaction(
  events: readonly CoordinationContractEvent[],
): boolean {
  const acquire = events.indexOf('acquire')
  const transaction = events.indexOf('transaction')
  const release = events.indexOf('release')
  return acquire >= 0 && acquire < transaction && transaction < release
}

/** Reports whether every protected event is enclosed by one coordination lease. */
function hasOrderedProtectedWork(events: readonly CoordinationContractEvent[]): boolean {
  const acquire = events.indexOf('acquire')
  const release = events.indexOf('release')

  if (acquire < 0 || release <= acquire) return false

  return events.every((event, index) => {
    if (!['transaction', 'introspection', 'ddl'].includes(event)) return true

    return acquire < index && index < release
  })
}

/**
 * Dialect-runtime coordination contract. Adapters expose semantic events and
 * controls; physical SQL and transaction primitives remain outside this suite.
 *
 * @example
 *   registerMigrationCoordinationContract('PostgreSQL', createPostgresHarness)
 *
 * @param name - Dialect name included in the generated test-suite label.
 * @param createRuntime - Factory adapting a physical runtime to semantic controls.
 */
export function registerMigrationCoordinationContract(
  name: string,
  createRuntime: CoordinationContractFactory,
): void {
  describe(`${name} Dialect contract [coordination]`, () => {
    registerCoordinationOrderingScenario(createRuntime)

    it('excludes a same-scope client until the first client releases', async () => {
      const owners = new Map<string, string>()
      const sharedLockManager: CoordinationContractLockManager =
        createCoordinationLockManager(owners)
      const first = createRuntime({
        applicationId: 'contract',
        clientId: 'first',
        holdAfterTransaction: true,
        sharedLockManager,
      })
      const second = createRuntime({
        applicationId: 'contract',
        clientId: 'second',
        sharedLockManager,
      })

      const firstPending = first.execute()
      await first.waitFor('transaction')

      await expect(second.execute({ lockTimeoutMs: 0 })).rejects.toMatchObject({
        stage: 'lock',
        outcome: 'unchanged',
      })

      expect(protectedWork(second.events())).toBe(false)

      first.releaseHold()
      await expect(firstPending).resolves.toEqual({ outcome: 'applied' })
      const afterRelease = createRuntime({
        applicationId: 'contract',
        clientId: 'third',
        sharedLockManager,
      })
      await expect(afterRelease.execute()).resolves.toEqual({ outcome: 'applied' })
    })

    registerTransactionEvidenceScenario()

    registerProtectedWorkOrderingScenario()

    registerCoordinationFailureScenarios(createRuntime)
  })
}

/**
 * Creates shared lock ownership that excludes competing fixture clients.
 *
 * @param owners - Fixture lock ownership indexed by advisory-lock identity.
 *
 * @returns Shared lock ownership that excludes competing fixture clients.
 */
function createCoordinationLockManager(owners: Map<string, string>): Readonly<{
  tryAcquire(owner: string, key: string): boolean
  release(owner: string, key: string): void
}> {
  return {
    /** Claims a fixture coordination lock when no competing owner holds it. */
    tryAcquire(owner, key) {
      const current = owners.get(key)

      if (current !== undefined) return current === owner

      owners.set(key, owner)
      return true
    },
    /** Releases the fixture lease with configured cleanup behavior. */
    release(owner, key) {
      if (owners.get(key) === owner) owners.delete(key)
    },
  }
}

/** Registers the scenario that rejects protected work before acquisition or after release. */
function registerProtectedWorkOrderingScenario() {
  it('rejects protected work before acquisition or after release', () => {
    expect(hasOrderedProtectedWork(['transaction', 'acquire', 'release'])).toBe(false)
    expect(hasOrderedProtectedWork(['acquire', 'release', 'ddl'])).toBe(false)

    expect(hasOrderedProtectedWork(['acquire', 'introspection', 'ddl', 'release'])).toBe(
      true,
    )
  })
}

/**
 * Registers the scenario that requires a genuine transaction event between acquire and
 * release.
 */
function registerTransactionEvidenceScenario() {
  it('requires a genuine transaction event between acquire and release', () => {
    expect(hasCoordinatedTransaction(['acquire', 'unclassified', 'release'])).toBe(false)
  })
}

/**
 * Registers the scenario that acquires before protected work and releases in reverse
 * phase order.
 *
 * @param createRuntime - Factory for the dialect runtime exercised by these contract
 *   scenarios.
 */
function registerCoordinationOrderingScenario(
  createRuntime: CoordinationContractFactory,
) {
  it('acquires before protected work and releases in reverse phase order', async () => {
    const runtime = createRuntime({ applicationId: 'contract' })
    await expect(runtime.execute()).resolves.toEqual({ outcome: 'applied' })
    expect(hasCoordinatedTransaction(runtime.events())).toBe(true)
    expect(hasOrderedProtectedWork(runtime.events())).toBe(true)
  })
}

/**
 * Registers the scenario that classifies abort as unchanged and retryable before
 * protected work.
 *
 * @param createRuntime - Factory for the dialect runtime exercised by these contract
 *   scenarios.
 */
function registerCoordinationFailureScenarios(
  createRuntime: CoordinationContractFactory,
) {
  registerCoordinationTimeoutScenario(createRuntime)

  it('classifies abort as unchanged and retryable before protected work', async () => {
    const controller = new AbortController()
    const runtime = createRuntime({ applicationId: 'contract', lockResults: [false] })
    const pending = runtime.execute({ signal: controller.signal })
    await runtime.waitFor('acquire')
    controller.abort()

    await expect(pending).rejects.toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })

    expect(protectedWork(runtime.events())).toBe(false)
  })

  it('preserves applied and unchanged outcomes after release cleanup failure', async () => {
    const applied = createRuntime({
      applicationId: 'contract',
      releaseResults: [false],
    })
    await expect(applied.execute()).rejects.toMatchObject({
      stage: 'unlock',
      outcome: 'applied',
      cleanupFailures: [{ stage: 'unlock' }],
    })

    const unchanged = createRuntime({
      applicationId: 'contract',
      noWork: true,
      releaseResults: [false],
    })
    await expect(unchanged.execute()).rejects.toMatchObject({
      stage: 'unlock',
      outcome: 'unchanged',
      cleanupFailures: [{ stage: 'unlock' }],
    })
  })
}

/**
 * Registers the scenario that classifies timeout as unchanged and retryable before
 * protected work.
 *
 * @param createRuntime - Factory for the dialect runtime exercised by these contract
 *   scenarios.
 */
function registerCoordinationTimeoutScenario(createRuntime: CoordinationContractFactory) {
  it('classifies timeout as unchanged and retryable before protected work', async () => {
    const runtime = createRuntime({ applicationId: 'contract', lockResults: [false] })
    await expect(runtime.execute({ lockTimeoutMs: 0 })).rejects.toMatchObject({
      stage: 'lock',
      outcome: 'unchanged',
      retryable: true,
    })

    expect(protectedWork(runtime.events())).toBe(false)
  })
}
