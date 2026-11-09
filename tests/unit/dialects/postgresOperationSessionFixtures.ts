import type { Connector } from 'db0'

import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'

import { createControllableProvider } from '../helpers/operationSessionFixtures'
import {
  applyPostgresFixtureDdl,
  postgresFixtureCatalogRows,
} from '../helpers/postgresDdlCatalog'

/**
 * Creates a PostgreSQL connector fixture with observable leases, calls, cancellation, and
 * disposal.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns A PostgreSQL connector fixture with observable leases, calls, cancellation,
 *   and disposal.
 */
function createPostgresNativeConnector(options?: NativeConnectorOptions) {
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

type PostgresControllableProviderOptions = Omit<
  NonNullable<Parameters<typeof createControllableProvider>[0]>,
  'queryRows'
> & {
  unlockResult?: boolean
}

/** Creates controlled sessions with PostgreSQL identity, catalog, and lock replies. */
function createPostgresControllableProvider(
  options?: PostgresControllableProviderOptions,
) {
  const tables: Parameters<typeof applyPostgresFixtureDdl>[1] = []
  return createControllableProvider({
    ...options,
    beforeCall: async (session, sql) => {
      await options?.beforeCall?.(session, sql)
      applyPostgresFixtureDdl(sql, tables)
    },
    queryRows: (sql) =>
      postgresFixtureCatalogRows(sql, tables) ?? postgresSessionQueryRows(sql, options),
  })
}

function postgresSessionQueryRows(
  sql: string,
  options: PostgresControllableProviderOptions | undefined,
): unknown[] {
  if (/current_database\(\)/i.test(sql))
    return [{ database: 'coordinator_test', schema: 'public', version: '160000' }]

  if (/-- catalog:namespace/i.test(sql)) return [{ schema: 'public', owner: 'app' }]

  if (/pg_advisory_unlock\(/i.test(sql))
    return [{ unlocked: options?.unlockResult ?? true }]

  if (/pg_try_advisory_lock\(/i.test(sql)) return [{ locked: true }]

  return []
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
  options: Parameters<typeof createPostgresNativeConnector>[0],
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
    /** Supplies the native parser for types without a query override. */
    getTypeParser: (_oid: number, _format?: string) => (value: string) => value,
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

type NativeConnectorOptions = {
  rowCount?: number | null
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

  if (text === POSTGRES_OPERATION_IDENTITY_SQL)
    return fixtureNativeIdentity(state, options, processID)

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

    return { rows, rowCount: options?.rowCount ?? null }
  } finally {
    queryState.rejectActive = undefined
    queryState.activeQuery = null
    nativeClient.readyForQuery = true
    state.activeCalls--
  }
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

  if (state.identityReads === options?.identityFailureAt)
    throw new Error('identity evidence unavailable')

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

export { createPostgresNativeConnector, createPostgresControllableProvider }
