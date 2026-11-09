import type { Connector } from 'db0'

import type { OperationSession, OperationSessionProvider } from '@/index'

import type { ProviderContractFactoryOptions } from '../dialects/operationSessionProviderContract'

/**
 * Bounds fixture work with a 500-millisecond timeout and clears the timer on settlement.
 *
 * @param promise - Pending work whose settlement or timeout is observed.
 *
 * @returns The callback value after the operation and required cleanup complete.
 */
function withDeadline<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operation timed out')), 500)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause: unknown) => {
        clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

type ProviderControls = {
  provider: OperationSessionProvider
  events: string[]
  calls: { session: number; sql: string }[]
  get openCount(): number
  get maxActiveCalls(): number
  get closeCount(): number
}

/**
 * Creates an exclusive-session provider fixture with deterministic failure and
 * synchronization controls.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns An exclusive-session provider fixture with deterministic failure and
 *   synchronization controls.
 */
function createControllableProvider(
  options?: ProviderContractFactoryOptions & {
    queryRows?: (sql: string) => unknown[]
    beforeCancel?: (session: number) => Promise<void>
    beforeRelease?: (session: number) => Promise<void>
    failSession?: number
    openFailure?: { session: number; value: unknown }
    closeFailure?: { value: unknown }
    rowCount?: number
  },
): ProviderControls {
  const state: ControllableProviderState = {
    events: [],
    calls: [],
    openCount: 0,
    activeCalls: 0,
    maxActiveCalls: 0,
    closeCount: 0,
  }

  const provider: OperationSessionProvider = {
    nativeTransactions: true,
    /** Opens an exclusive fixture session with lifecycle controls. */
    open: () => openControllableSession(state, options),
    /** Closes the fixture provider after its leases settle. */
    async close() {
      state.closeCount++
      state.events.push('provider-closed')

      if (options?.closeFailure) throw options.closeFailure.value
    },
  }

  return {
    provider,
    events: state.events,
    calls: state.calls,
    /** Reports the number of native session leases opened by the fixture. */
    get openCount() {
      return state.openCount
    },
    /** Reports the largest number of concurrent calls observed by the fixture. */
    get maxActiveCalls() {
      return state.maxActiveCalls
    },
    /** Reports the number of provider shutdown calls observed by the fixture. */
    get closeCount() {
      return state.closeCount
    },
  }
}

/**
 * Creates the operation session common runtime fixture used by the contract scenario.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns The operation session common runtime fixture used by the contract scenario.
 */
function createOperationSessionCommonRuntime(
  options?: Parameters<typeof createControllableProvider>[0],
) {
  const controls = createControllableProvider(options)
  return {
    controls,
    runtime: {
      provider: controls.provider,
      /** Returns semantic operation events recorded by the fixture. */
      events: () =>
        controls.events.flatMap((event) => {
          if (event === 'statement:1:contract query') return ['query' as const]
          if (event === 'statement:1:contract run') return ['run' as const]
          if (event === 'cancel-requested:1') return ['cancel' as const]
          if (event === 'release-finished:1:reuse') return ['release:reuse' as const]
          if (event === 'provider-closed') return ['close' as const]

          return []
        }),
    },
  }
}

/**
 * Builds a connector that requires calls to go through its custom session provider.
 *
 * @returns A connector that requires calls to go through its custom session provider.
 */
function customConnector(dialect: Connector['dialect']): Connector {
  return {
    name: 'custom',
    dialect,
    /** Returns the native client owned by the fixture connector. */
    getInstance: () => ({}),
    /** Executes connector SQL for the fixture scenario. */
    exec: async () => ({}),
    /** Prepares the fixture statement for the supplied SQL. */
    prepare: () => {
      throw new Error('custom connector should be accessed only through its provider')
    },
  }
}

type ControllableProviderState = {
  events: string[]
  calls: { session: number; sql: string }[]
  openCount: number
  activeCalls: number
  maxActiveCalls: number
  closeCount: number
}

/**
 * Opens a fixture lease whose identity, queued calls, cancellation, and release can be
 * observed.
 *
 * @param state - Mutable fixture state shared across observed calls and cleanup.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A controlled session lease with observable identity, calls, and cleanup.
 */
async function openControllableSession(
  state: ControllableProviderState,
  options: Parameters<typeof createControllableProvider>[0],
) {
  const id = ++state.openCount
  state.events.push(`lease-opened:${id}`)

  if (options?.openFailure?.session === id) throw options.openFailure.value

  const sessionState: ControllableSessionState = createControllableSessionState()

  const identity = {
    database: options?.invalidInitialSession === 'identity' ? '' : 'coordinator_test',
    physicalSession: `physical-${id}`,
  }

  /** Serializes fixture SQL and records its physical-session ownership. */
  const call = <T>(sql: string, operation: () => Promise<T>) =>
    callControllableSession(sql, operation, sessionState, state, id, options, identity)

  const session: OperationSession = {
    /** Returns the session identity observed by the provider contract. */
    get identity() {
      return readControllableIdentity(sessionState, options, id, identity)
    },
    /** Runs fixture SQL and records physical-session ownership. */
    query(query) {
      return call(query.sql, async () => {
        return options?.queryRows?.(query.sql) ?? []
      })
    },
    /** Runs a fixture statement with configured outcomes. */
    run(query) {
      return call(query.sql, async () => options?.rowCount)
    },
    /** Cancels the active physical-session operation. */
    cancel: () => cancelControllableSession(state, id, options),
    /** Releases the fixture lease with configured cleanup behavior. */
    release: (disposition) =>
      releaseControllableSession(disposition, sessionState, state, id, options),
  }

  if (options?.invalidInitialSession === 'capability')
    Object.assign(session as unknown as { cancel?: unknown }, { cancel: undefined })

  return session
}

type ControllableSessionState = {
  released: boolean
  queue: Promise<void>
  identityMutated: boolean
  identityReads: number
}

/**
 * Serializes fixture SQL calls and records their session ownership and configured
 * failures.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 * @param operation - Work to run within the current session or error boundary.
 * @param sessionState - Mutable activity and identity state for the current fixture
 *   lease.
 * @param state - Mutable fixture state shared across observed calls and cleanup.
 * @param id - Session or graph identifier used to correlate observed calls.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns The callback value after the operation and required cleanup complete.
 */
function callControllableSession<T>(
  sql: string,
  operation: () => Promise<T>,
  sessionState: ControllableSessionState,
  state: ControllableProviderState,
  id: number,
  options: Parameters<typeof createControllableProvider>[0],
  identity: { database: string; physicalSession: string },
) {
  if (sessionState.released) throw new Error('released session used')

  const result = sessionState.queue.then(async () => {
    state.calls.push({ session: id, sql })
    state.events.push(`statement:${id}:${sql}`)
    state.activeCalls++
    state.maxActiveCalls = Math.max(state.maxActiveCalls, state.activeCalls)

    try {
      await options?.beforeCall?.(id, sql)

      if (options?.mutationFailure?.session === id) throw options.mutationFailure.value

      if (options?.failSession === id) throw new Error(`session ${id} failed`)

      return await operation()
    } finally {
      state.activeCalls--

      if (options?.mutateIdentityAfterCall && !sessionState.identityMutated) {
        sessionState.identityMutated = true
        identity.physicalSession = `changed-${id}`
      }
    }
  })

  sessionState.queue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

/**
 * Returns fixture identity or injects the configured identity-read rejection.
 *
 * @param sessionState - Mutable activity and identity state for the current fixture
 *   lease.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param id - Session or graph identifier used to correlate observed calls.
 * @param identity - Canonical relation or physical-session identity used by this
 *   operation.
 *
 * @returns Fixture identity or injects the configured identity-read rejection.
 */
function readControllableIdentity(
  sessionState: ControllableSessionState,
  options:
    | (Readonly<{
        beforeCall?: (session: number, sql: string) => Promise<void>
        beforeCancel?: (session: number) => Promise<void>
        releaseFailure?: Readonly<{ session: number; value: unknown }>
        identityReadFailure?: Readonly<{ session: number; read: number; value: unknown }>
        mutateIdentityAfterCall?: boolean
        mutationFailure?: Readonly<{ session: number; value: unknown }>
        invalidInitialSession?: 'identity' | 'capability'
      }> & {
        beforeCancel?: (session: number) => Promise<void>
        beforeRelease?: (session: number) => Promise<void>
        failSession?: number
        openFailure?: { session: number; value: unknown }
        closeFailure?: { value: unknown }
      })
    | undefined,
  id: number,
  identity: { database: string; physicalSession: string },
) {
  sessionState.identityReads++

  if (
    options?.identityReadFailure?.session === id &&
    options.identityReadFailure.read === sessionState.identityReads
  )
    throw options.identityReadFailure.value

  return identity
}

/**
 * Drains fixture calls and records release, including configured release failures.
 *
 * @param disposition - Whether release may reuse the session or must discard it.
 * @param sessionState - Mutable activity and identity state for the current fixture
 *   lease.
 * @param state - Mutable fixture state shared across observed calls and cleanup.
 * @param id - Session or graph identifier used to correlate observed calls.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 */
async function releaseControllableSession(
  disposition: Parameters<OperationSession['release']>[0],
  sessionState: ControllableSessionState,
  state: ControllableProviderState,
  id: number,
  options:
    | (Readonly<{
        beforeCall?: (session: number, sql: string) => Promise<void>
        beforeCancel?: (session: number) => Promise<void>
        releaseFailure?: Readonly<{ session: number; value: unknown }>
        identityReadFailure?: Readonly<{ session: number; read: number; value: unknown }>
        mutateIdentityAfterCall?: boolean
        mutationFailure?: Readonly<{ session: number; value: unknown }>
        invalidInitialSession?: 'identity' | 'capability'
      }> & {
        beforeCancel?: (session: number) => Promise<void>
        beforeRelease?: (session: number) => Promise<void>
        failSession?: number
        openFailure?: { session: number; value: unknown }
        closeFailure?: { value: unknown }
      })
    | undefined,
) {
  if (sessionState.released) throw new Error('released twice')

  sessionState.released = true
  await sessionState.queue
  state.events.push(`release-started:${id}:${disposition}`)
  await options?.beforeRelease?.(id)

  if (options?.releaseFailure?.session === id) throw options.releaseFailure.value

  state.events.push(`release-finished:${id}:${disposition}`)
}

/** Records cancellation and runs the fixture's cancellation hook. */
async function cancelControllableSession(
  state: ControllableProviderState,
  id: number,
  options:
    | (Readonly<{
        beforeCall?: (session: number, sql: string) => Promise<void>
        beforeCancel?: (session: number) => Promise<void>
        releaseFailure?: Readonly<{ session: number; value: unknown }>
        identityReadFailure?: Readonly<{ session: number; read: number; value: unknown }>
        mutateIdentityAfterCall?: boolean
        mutationFailure?: Readonly<{ session: number; value: unknown }>
        invalidInitialSession?: 'identity' | 'capability'
      }> & {
        beforeCancel?: (session: number) => Promise<void>
        beforeRelease?: (session: number) => Promise<void>
        failSession?: number
        openFailure?: { session: number; value: unknown }
        closeFailure?: { value: unknown }
      })
    | undefined,
) {
  state.events.push(`cancel-requested:${id}`)
  await options?.beforeCancel?.(id)
}

/**
 * Initializes a fixture lease with no active calls or identity changes.
 *
 * @returns Fresh mutable lease state.
 */
function createControllableSessionState(): ControllableSessionState {
  return {
    released: false,
    queue: Promise.resolve(),
    identityMutated: false,
    identityReads: 0,
  }
}

export {
  withDeadline,
  createControllableProvider,
  createOperationSessionCommonRuntime,
  customConnector,
}
