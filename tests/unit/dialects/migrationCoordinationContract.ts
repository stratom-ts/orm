import { describe, expect, it } from 'vitest'

export type CoordinationContractEvent =
  | 'acquire'
  | 'release'
  | 'transaction'
  | 'introspection'
  | 'ddl'

/** Physical-dialect adapter for exercising exclusion without SQL assumptions. */
export type CoordinationContractLockManager = Readonly<{
  tryAcquire(owner: string, key: string): boolean
  release(owner: string, key: string): void
}>

export type CoordinationContractRuntime = {
  execute(options?: {
    lockTimeoutMs?: number
    signal?: AbortSignal
  }): Promise<{ outcome: 'applied' | 'unchanged' }>
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
    it('acquires before protected work and releases in reverse phase order', async () => {
      const runtime = createRuntime({ applicationId: 'contract' })
      await expect(runtime.execute()).resolves.toEqual({ outcome: 'applied' })
      const events = runtime.events()
      expect(events.indexOf('acquire')).toBeLessThan(events.indexOf('transaction'))
      expect(events.indexOf('transaction')).toBeLessThan(events.indexOf('release'))
    })

    it('excludes a same-scope client until the first client releases', async () => {
      const owners = new Map<string, string>()
      const sharedLockManager: CoordinationContractLockManager = {
        tryAcquire(owner, key) {
          const current = owners.get(key)
          if (current !== undefined) return current === owner

          owners.set(key, owner)
          return true
        },
        release(owner, key) {
          if (owners.get(key) === owner) owners.delete(key)
        },
      }
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

    it('classifies timeout as unchanged and retryable before protected work', async () => {
      const runtime = createRuntime({ applicationId: 'contract', lockResults: [false] })
      await expect(runtime.execute({ lockTimeoutMs: 0 })).rejects.toMatchObject({
        stage: 'lock',
        outcome: 'unchanged',
        retryable: true,
      })
      expect(protectedWork(runtime.events())).toBe(false)
    })

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
  })
}
