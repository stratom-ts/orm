import type { Connector } from 'db0'

import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'
import type { OperationSession, OperationSessionProvider } from '@/index'

import type { ProviderContractFactoryOptions } from '../dialects/operationSessionProviderContract'

/**
 * Bounds fixture work with a 500-millisecond timeout and clears the timer on settlement.
 *
 * @param promise - Pending work whose settlement or timeout is observed.
 *
 * @returns The callback value after the operation and required cleanup complete.
 */
export function withDeadline<T>(promise: Promise<T>): Promise<T> {
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

/**
 * Creates a PostgreSQL connector fixture with observable leases, calls, cancellation, and
 * disposal.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A PostgreSQL connector fixture with observable leases, calls, cancellation,
 *   and disposal.
 */
export function createNativeConnector(options?: NativeConnectorOptions) {
  const state: NativeConnectorFixtureState = createNativeConnectorState(options)

  /** Creates the client fixture used by the contract scenario. */
  const createClient = () => createNativeFixtureClient(state, options)

  const connector: NativeConnectorFixture = {
    name: 'postgresql',
    dialect: 'postgresql',
    /** Returns the native client owned by the fixture connector. */
    getInstance: () => (state.client ??= createClient()),
    /** Executes connector SQL for the fixture scenario. */
    exec: async () => ({}),
    /** Prepares the fixture statement for the supplied SQL. */
    prepare: () => {
      throw new Error('native provider must not use db0 prepare')
    },
    /** Records disposal and closes owned fixture resources. */
    async dispose() {
      state.disposeCount++

      if (state.disposeFailures > 0) {
        state.disposeFailures--
        throw new Error('connector dispose failed')
      }

      state.client = undefined
    },
    /** Reports the number of connector disposal calls observed by the fixture. */
    get disposeCount() {
      return state.disposeCount
    },
    /** Reports the number of native client shutdown calls observed by the fixture. */
    get endCount() {
      return state.endCount
    },
    /** Reports the largest number of concurrent calls observed by the fixture. */
    get maxActiveCalls() {
      return state.maxActiveCalls
    },
    /** Returns the native query calls recorded by the fixture. */
    get queryCalls() {
      return state.queryCalls
    },
  }
  return connector
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
 * Supplies native identity, catalog, and lock observations for operation-session
 * scenarios.
 *
 * @param sql - Native SQL text being scanned, compiled, or observed.
 * @param unlockResult - Whether the fixture reports successful advisory-lock release.
 *
 * @returns Native identity, catalog, and lock observations for operation-session
 *   scenarios.
 */
function sessionQueryRows(sql: string, unlockResult: boolean): unknown[] {
  if (/current_database\(\)/i.test(sql)) {
    return [
      {
        database: 'coordinator_test',
        schema: 'public',
        version: '160000',
      },
    ]
  }

  if (/-- catalog:namespace/i.test(sql)) {
    return [{ schema: 'public', owner: 'app' }]
  }

  if (/pg_advisory_unlock\(/i.test(sql)) {
    return [{ unlocked: unlockResult }]
  }

  if (/pg_try_advisory_lock\(/i.test(sql)) {
    return [{ locked: true }]
  }

  return []
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
export function createControllableProvider(
  options?: ProviderContractFactoryOptions & {
    beforeCancel?: (session: number) => Promise<void>
    beforeRelease?: (session: number) => Promise<void>
    failSession?: number
    openFailure?: { session: number; value: unknown }
    closeFailure?: { value: unknown }
    unlockResult?: boolean
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
export function createOperationSessionCommonRuntime(
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
export function customConnector(): Connector {
  return {
    name: 'custom',
    dialect: 'postgresql',
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

type NativeConnectorFixtureState = {
  nextProcessId: number
  client: ReturnType<typeof createNativeFixtureClient> | undefined
  disposeCount: number
  endCount: number
  activeCalls: number
  maxActiveCalls: number
  disposeFailures: number
  identityReads: number
  queryCalls: { text: string; values: unknown[] }[]
}

/**
 * Creates the native client used by the controllable connector fixture.
 *
 * @param state - Mutable fixture state shared across observed calls and cleanup.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns The native client used by the controllable connector fixture.
 */
function createNativeFixtureClient(
  state: NativeConnectorFixtureState,
  options: Parameters<typeof createNativeConnector>[0],
) {
  const processID = state.nextProcessId++
  const queryState: NativeFixtureQueryState = {
    activeQuery: null,
    rejectActive: undefined,
  }

  const nativeClient = {
    processID,
    database: 'operations_test',
    readyForQuery: true,
    /** Reports the physical query currently active on the native client fixture. */
    get activeQuery() {
      return queryState.activeQuery
    },
    queryQueue: [],
    /** Closes the native PostgreSQL client and its physical connection. */
    async end() {
      state.endCount++
      await options?.beforeEnd?.()
      queryState.rejectActive?.(new Error('native connection terminated'))
    },
    /** Runs fixture SQL and records physical-session ownership. */
    query: (query: string | { text: string; values: unknown[]; signal?: AbortSignal }) =>
      executeNativeFixtureQuery(
        query,
        state,
        options,
        processID,
        queryState,
        nativeClient,
      ),
  }
  return nativeClient
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
        return sessionQueryRows(query.sql, options?.unlockResult ?? true)
      })
    },
    /** Runs a fixture statement with configured outcomes. */
    run(query) {
      return call(query.sql, async () => undefined)
    },
    /** Cancels the active physical-session operation. */
    cancel: () => cancelControllableSession(state, id, options),
    /** Releases the fixture lease with configured cleanup behavior. */
    release: (disposition) =>
      releaseControllableSession(disposition, sessionState, state, id, options),
  }

  if (options?.invalidInitialSession === 'capability') {
    Object.assign(session as unknown as { cancel?: unknown }, { cancel: undefined })
  }

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

      if (options?.mutationFailure?.session === id) {
        throw options.mutationFailure.value
      }

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

type NativeConnectorOptions = {
  onQuery?: (
    text: string,
    signal: AbortSignal | undefined,
    values: unknown[],
  ) => Promise<unknown[]>
  beforeEnd?: () => Promise<void>
  disposeFailures?: number
  releaseFailure?: { value: unknown }
  currentSchema?: string | (() => string)
  identityFailureAt?: number
}

type NativeFixtureQueryState = {
  activeQuery: object | null
  rejectActive: ((cause: Error) => void) | undefined
}

/**
 * Runs a native fixture query while tracking identity, activity, and configured failures.
 *
 * @param query - Compiled SQL and ordered parameter bindings for the current physical
 *   call.
 * @param state - Mutable fixture state shared across observed calls and cleanup.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param processID - Native backend identifier used as physical-session evidence.
 * @param queryState - Mutable query counters used to inject catalog races on repeat
 *   reads.
 * @param nativeClient - Native client whose query and shutdown behavior is observed.
 *
 * @returns Native result rows for identity, cleanup, or ordinary query execution.
 */
async function executeNativeFixtureQuery(
  query: string | { text: string; values: unknown[]; signal?: AbortSignal },
  state: NativeConnectorFixtureState,
  options: NativeConnectorOptions | undefined,
  processID: number,
  queryState: NativeFixtureQueryState,
  nativeClient: { readyForQuery: boolean },
) {
  const text = typeof query === 'string' ? query : query.text
  const signal = typeof query === 'string' ? undefined : query.signal
  const values = typeof query === 'string' ? [] : query.values
  state.queryCalls.push({ text, values })

  if (text === POSTGRES_OPERATION_IDENTITY_SQL) {
    return fixtureNativeIdentity(state, options, processID)
  }

  if (
    text === POSTGRES_OPERATION_ROLLBACK_SQL ||
    text === POSTGRES_OPERATION_UNLOCK_SQL
  ) {
    if (options?.releaseFailure) throw options.releaseFailure.value

    return { rows: [] }
  }

  queryState.activeQuery = {}
  nativeClient.readyForQuery = false
  state.activeCalls++
  state.maxActiveCalls = Math.max(state.maxActiveCalls, state.activeCalls)

  try {
    const terminated = new Promise<never>((_, reject) => {
      queryState.rejectActive = reject
    })
    const rows = await Promise.race([
      options?.onQuery?.(text, signal, values) ?? Promise.resolve([]),
      terminated,
    ])
    return { rows }
  } finally {
    queryState.rejectActive = undefined
    queryState.activeQuery = null
    nativeClient.readyForQuery = true
    state.activeCalls--
  }
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
        unlockResult?: boolean
      })
    | undefined,
  id: number,
  identity: { database: string; physicalSession: string },
) {
  sessionState.identityReads++

  if (
    options?.identityReadFailure?.session === id &&
    options.identityReadFailure.read === sessionState.identityReads
  ) {
    throw options.identityReadFailure.value
  }

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
        unlockResult?: boolean
      })
    | undefined,
) {
  if (sessionState.released) throw new Error('released twice')

  sessionState.released = true
  await sessionState.queue
  state.events.push(`release-started:${id}:${disposition}`)
  await options?.beforeRelease?.(id)

  if (options?.releaseFailure?.session === id) {
    throw options.releaseFailure.value
  }

  state.events.push(`release-finished:${id}:${disposition}`)
}

/**
 * Builds native backend evidence or injects the configured identity observation failure.
 *
 * @param state - Mutable fixture state shared across observed calls and cleanup.
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 * @param processID - Native backend identifier used as physical-session evidence.
 *
 * @returns Native backend evidence or injects the configured identity observation
 *   failure.
 */
function fixtureNativeIdentity(
  state: NativeConnectorFixtureState,
  options: NativeConnectorOptions | undefined,
  processID: number,
) {
  state.identityReads++

  if (state.identityReads === options?.identityFailureAt) {
    throw new Error('identity evidence unavailable')
  }

  return {
    rows: [
      {
        physicalSession: String(processID),
        database: 'operations_test',
        schema:
          typeof options?.currentSchema === 'function'
            ? options.currentSchema()
            : (options?.currentSchema ?? 'public'),
      },
    ],
  }
}

type NativeConnectorFixture = Connector & {
  readonly disposeCount: number
  readonly endCount: number
  readonly maxActiveCalls: number
  readonly queryCalls: readonly { text: string; values: unknown[] }[]
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
        unlockResult?: boolean
      })
    | undefined,
) {
  state.events.push(`cancel-requested:${id}`)
  await options?.beforeCancel?.(id)
}

/**
 * Initializes native-connector counters and configured disposal failures.
 *
 * @param options - Fixture failure and lifecycle controls.
 *
 * @returns Fresh mutable connector state.
 */
function createNativeConnectorState(
  options: NativeConnectorOptions | undefined,
): NativeConnectorFixtureState {
  return {
    nextProcessId: 4000,
    client: undefined,
    disposeCount: 0,
    endCount: 0,
    activeCalls: 0,
    maxActiveCalls: 0,
    disposeFailures: options?.disposeFailures ?? 0,
    identityReads: 0,
    queryCalls: [],
  }
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
