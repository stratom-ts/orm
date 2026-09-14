import type { Connector } from 'db0'

import {
  POSTGRES_OPERATION_IDENTITY_SQL,
  POSTGRES_OPERATION_ROLLBACK_SQL,
  POSTGRES_OPERATION_UNLOCK_SQL,
} from '@/dialects/postgres/operationSession'
import type { OperationSession, OperationSessionProvider } from '@/index'

import type { ProviderContractFactoryOptions } from '../dialects/operationSessionProviderContract'

type Deferred = {
  promise: Promise<void>
  resolve(): void
}

export function deferred(): Deferred {
  let resolve!: () => void
  return {
    promise: new Promise<void>((done) => {
      resolve = done
    }),
    resolve,
  }
}

export function withDeadline<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('operation timed out')), milliseconds)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

export function createNativeConnector(options?: {
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
}) {
  let nextProcessId = 4000
  let client: ReturnType<typeof createClient> | undefined
  let disposeCount = 0
  let endCount = 0
  let activeCalls = 0
  let maxActiveCalls = 0
  let disposeFailures = options?.disposeFailures ?? 0
  let identityReads = 0
  const queryCalls: { text: string; values: unknown[] }[] = []

  const createClient = () => {
    const processID = nextProcessId++
    let activeQuery: object | null = null
    let rejectActive: ((cause: Error) => void) | undefined
    const nativeClient = {
      processID,
      database: 'operations_test',
      readyForQuery: true,
      get activeQuery() {
        return activeQuery
      },
      queryQueue: [],
      async end() {
        endCount++
        await options?.beforeEnd?.()
        rejectActive?.(new Error('native connection terminated'))
      },
      async query(
        query: string | { text: string; values: unknown[]; signal?: AbortSignal },
      ) {
        const text = typeof query === 'string' ? query : query.text
        const signal = typeof query === 'string' ? undefined : query.signal
        const values = typeof query === 'string' ? [] : query.values
        queryCalls.push({ text, values })

        if (text === POSTGRES_OPERATION_IDENTITY_SQL) {
          identityReads++

          if (identityReads === options?.identityFailureAt) {
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

        if (
          text === POSTGRES_OPERATION_ROLLBACK_SQL ||
          text === POSTGRES_OPERATION_UNLOCK_SQL
        ) {
          if (options?.releaseFailure) throw options.releaseFailure.value
          return { rows: [] }
        }

        activeQuery = {}
        nativeClient.readyForQuery = false
        activeCalls++
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls)

        try {
          const terminated = new Promise<never>((_, reject) => {
            rejectActive = reject
          })
          const rows = await Promise.race([
            options?.onQuery?.(text, signal, values) ?? Promise.resolve([]),
            terminated,
          ])
          return { rows }
        } finally {
          rejectActive = undefined
          activeQuery = null
          nativeClient.readyForQuery = true
          activeCalls--
        }
      },
    }
    return nativeClient
  }

  const connector: Connector & {
    readonly disposeCount: number
    readonly endCount: number
    readonly maxActiveCalls: number
    readonly queryCalls: readonly { text: string; values: unknown[] }[]
  } = {
    name: 'postgresql',
    dialect: 'postgresql',
    getInstance: () => (client ??= createClient()),
    exec: async () => ({}),
    prepare: () => {
      throw new Error('native provider must not use db0 prepare')
    },
    async dispose() {
      disposeCount++

      if (disposeFailures > 0) {
        disposeFailures--
        throw new Error('connector dispose failed')
      }

      client = undefined
    },
    get disposeCount() {
      return disposeCount
    },
    get endCount() {
      return endCount
    },
    get maxActiveCalls() {
      return maxActiveCalls
    },
    get queryCalls() {
      return queryCalls
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
  const events: string[] = []
  const calls: { session: number; sql: string }[] = []
  let openCount = 0
  let activeCalls = 0
  let maxActiveCalls = 0
  let closeCount = 0

  const provider: OperationSessionProvider = {
    nativeTransactions: true,
    async open() {
      const id = ++openCount
      events.push(`lease-opened:${id}`)
      if (options?.openFailure?.session === id) throw options.openFailure.value
      let released = false
      let queue = Promise.resolve()
      const identity = {
        database: options?.invalidInitialSession === 'identity' ? '' : 'coordinator_test',
        physicalSession: `physical-${id}`,
      }
      let identityMutated = false
      let identityReads = 0

      const readIdentity = () => {
        identityReads++

        if (
          options?.identityReadFailure?.session === id &&
          options.identityReadFailure.read === identityReads
        ) {
          throw options.identityReadFailure.value
        }

        return identity
      }

      const call = <T>(sql: string, operation: () => Promise<T>): Promise<T> => {
        if (released) throw new Error('released session used')
        const result = queue.then(async () => {
          calls.push({ session: id, sql })
          events.push(`statement:${id}:${sql}`)
          activeCalls++
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls)

          try {
            await options?.beforeCall?.(id, sql)

            if (options?.mutationFailure?.session === id) {
              throw options.mutationFailure.value
            }

            if (options?.failSession === id) throw new Error(`session ${id} failed`)
            return await operation()
          } finally {
            activeCalls--

            if (options?.mutateIdentityAfterCall && !identityMutated) {
              identityMutated = true
              identity.physicalSession = `changed-${id}`
            }
          }
        })
        queue = result.then(
          () => undefined,
          () => undefined,
        )
        return result
      }

      const session: OperationSession = {
        get identity() {
          return readIdentity()
        },
        query(query) {
          return call(query.sql, async () => {
            if (/current_database\(\)/i.test(query.sql)) {
              return [
                {
                  database: 'coordinator_test',
                  schema: 'public',
                  version: '160000',
                },
              ]
            }

            if (/-- catalog:namespace/i.test(query.sql)) {
              return [{ schema: 'public', owner: 'app' }]
            }

            if (/pg_advisory_unlock\(/i.test(query.sql)) {
              return [{ unlocked: options?.unlockResult ?? true }]
            }

            if (/pg_try_advisory_lock\(/i.test(query.sql)) {
              return [{ locked: true }]
            }

            return []
          })
        },
        run(query) {
          return call(query.sql, async () => undefined)
        },
        async cancel() {
          events.push(`cancel-requested:${id}`)
          await options?.beforeCancel?.(id)
        },
        async release(disposition) {
          if (released) throw new Error('released twice')
          released = true
          await queue
          events.push(`release-started:${id}:${disposition}`)
          await options?.beforeRelease?.(id)

          if (options?.releaseFailure?.session === id) {
            throw options.releaseFailure.value
          }

          events.push(`release-finished:${id}:${disposition}`)
        },
      }

      if (options?.invalidInitialSession === 'capability') {
        Object.assign(session as unknown as { cancel?: unknown }, { cancel: undefined })
      }

      return session
    },
    async close() {
      closeCount++
      events.push('provider-closed')
      if (options?.closeFailure) throw options.closeFailure.value
    },
  }

  return {
    provider,
    events,
    calls,
    get openCount() {
      return openCount
    },
    get maxActiveCalls() {
      return maxActiveCalls
    },
    get closeCount() {
      return closeCount
    },
  }
}

export function customConnector(): Connector {
  return {
    name: 'custom',
    dialect: 'postgresql',
    getInstance: () => ({}),
    exec: async () => ({}),
    prepare: () => {
      throw new Error('custom connector should be accessed only through its provider')
    },
  }
}
