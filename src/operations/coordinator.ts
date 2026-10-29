import { AsyncLocalStorage } from 'node:async_hooks'

import type { CompiledQuery } from '@/dialects'
import type { NamespaceContext } from '@/migrations/canonicalRelationIdentity'
import type { Executor } from '@/query'
import type { ExecutionOptions, QueryEvent, QueryObserver } from '@/query/observation'
import type { NamespaceRole } from '@/schemas'
import type { DriverErrorClassifier } from '@/utils/error'
import { QueryError, attempt, classifyDriverError } from '@/utils/error'

import { operationCleanupFailures, withOperationCleanupFailure } from './cleanup'
import type {
  OperationSession,
  OperationSessionDisposition,
  OperationSessionIdentity,
  OperationSessionProvider,
} from './operationSession'

type OperationToken = {
  readonly coordinator: OperationCoordinator
  readonly executor: Executor
  readonly identity: OperationSessionIdentity
  active: boolean
  /** Marks the current physical session for disposal instead of reuse. */
  discard(): void
}

type OperationFrame = {
  readonly token: OperationToken
  readonly parent: OperationFrame | undefined
}

const activeOperation = new AsyncLocalStorage<OperationFrame>()

/** Reads session cleanup causes from the failure itself. */
export function getOperationReleaseCleanupFailures(cause: unknown): readonly unknown[] {
  return operationCleanupFailures(cause).map((failure) => failure.cause)
}

/** Keeps the first rejection and adds later cleanup failures as explicit diagnostics. */
function mergeOperationFailure(
  failed: boolean,
  error: unknown,
  failure: unknown,
): Readonly<{ failed: true; error: unknown }> {
  return {
    failed: true,
    error: failed ? withOperationCleanupFailure(error, failure) : failure,
  }
}

/**
 * Validates the operation session provider contract at runtime.
 *
 * @param provider - Provider to validate.
 */
function assertProvider(provider: unknown): asserts provider is OperationSessionProvider {
  const candidate = provider as Partial<OperationSessionProvider> | null

  if (
    candidate?.nativeTransactions !== true ||
    typeof candidate.open !== 'function' ||
    typeof candidate.close !== 'function'
  ) {
    throw new QueryError({
      message:
        'operationSessionProvider must provide pinned sessions with native transaction semantics',
    })
  }
}

/**
 * Validates a pinned operation session lifecycle.
 *
 * @param session - Session to validate.
 */
function assertSession(session: unknown): asserts session is OperationSession {
  const candidate = session as Partial<OperationSession> | null

  if (
    typeof candidate?.query !== 'function' ||
    typeof candidate.run !== 'function' ||
    typeof candidate.cancel !== 'function' ||
    typeof candidate.release !== 'function'
  ) {
    throw new QueryError({
      message: 'Operation session provider returned an invalid pinned session',
    })
  }
}

const NAMESPACE_ROLES = new Set<NamespaceRole>(['catalog', 'database', 'schema'])

/** Validates and snapshots optional writable-namespace session evidence. */
function captureNamespaceContext(value: unknown): NamespaceContext | undefined {
  if (value === undefined) return undefined

  if (typeof value !== 'object' || value === null || !('writableDefault' in value)) {
    throw new QueryError({
      message: 'Operation session provider returned an invalid namespace context',
    })
  }

  const writableDefault = value.writableDefault

  if (!Array.isArray(writableDefault)) {
    throw new QueryError({
      message: 'Operation session provider returned an invalid namespace context',
    })
  }

  const roles = new Set<NamespaceRole>()
  const snapshot = writableDefault.map((segment: unknown) => {
    if (
      typeof segment !== 'object' ||
      segment === null ||
      !('role' in segment) ||
      !NAMESPACE_ROLES.has(segment.role as NamespaceRole) ||
      roles.has(segment.role as NamespaceRole) ||
      !('spelling' in segment) ||
      typeof segment.spelling !== 'string' ||
      segment.spelling.length === 0
    ) {
      throw new QueryError({
        message: 'Operation session provider returned an invalid namespace context',
      })
    }

    const role = segment.role as NamespaceRole
    roles.add(role)
    return Object.freeze({ role, spelling: segment.spelling })
  })

  return Object.freeze({ writableDefault: Object.freeze(snapshot) })
}

/** Compares ordered writable-namespace snapshots without object serialization. */
function sameNamespaceContext(
  left: NamespaceContext | undefined,
  right: NamespaceContext | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right

  return (
    left.writableDefault.length === right.writableDefault.length &&
    left.writableDefault.every(
      (segment, index) =>
        segment.role === right.writableDefault[index]?.role &&
        segment.spelling === right.writableDefault[index]?.spelling,
    )
  )
}

/**
 * Captures and validates one immutable session-identity snapshot.
 *
 * @param session - Session to validate and snapshot.
 */
function captureSessionIdentity(session: OperationSession): OperationSessionIdentity {
  const identity = (session as { readonly identity?: Partial<OperationSessionIdentity> })
    .identity

  const database: unknown = identity?.database
  const physicalSession: unknown = identity?.physicalSession
  const namespaceContext = captureNamespaceContext(identity?.namespaceContext)

  if (
    typeof database !== 'string' ||
    database.length === 0 ||
    typeof physicalSession !== 'string' ||
    physicalSession.length === 0
  ) {
    throw new QueryError({
      message: 'Operation session provider returned an invalid pinned session',
    })
  }

  return Object.freeze({
    database,
    physicalSession,
    ...(namespaceContext === undefined ? {} : { namespaceContext }),
  })
}

/**
 * Proves that a validated leased session still identifies the captured physical backend.
 *
 * @param session - Leased session to verify before release.
 * @param expected - Identity captured after initial session validation.
 */
function assertStableSessionIdentity(
  session: OperationSession,
  expected: OperationSessionIdentity,
): void {
  const identity = (session as { readonly identity?: Partial<OperationSessionIdentity> })
    .identity

  const database: unknown = identity?.database
  const physicalSession: unknown = identity?.physicalSession
  const namespaceContext = captureNamespaceContext(identity?.namespaceContext)

  if (typeof database !== 'string' || typeof physicalSession !== 'string') {
    throw new QueryError({
      message: 'Unable to verify operation session identity before release',
    })
  }

  if (
    database !== expected.database ||
    physicalSession !== expected.physicalSession ||
    !sameNamespaceContext(namespaceContext, expected.namespaceContext)
  ) {
    throw new QueryError({
      message: 'Operation session identity changed before release',
    })
  }
}

export type OperationContext = Readonly<{
  executor: Executor
  identity: OperationSessionIdentity

  /** Marks the physical operation session for disposal. */
  discard(): void

  /** Cancels work currently running on the physical operation session. */
  cancel(): Promise<void>
}>

export class OperationCoordinator {
  private tail = Promise.resolve()
  private closing = false
  private closePromise: Promise<void> | undefined

  /**
   * Creates a coordinator for one operation session provider.
   *
   * @example
   *   const coordinator = new OperationCoordinator(provider)
   *
   * @param provider - Exclusive native operation session provider.
   */
  constructor(
    private readonly provider: OperationSessionProvider,
    private readonly classify?: DriverErrorClassifier,
    private readonly onQuery?: QueryObserver,
    private readonly queryParameters: 'include' | 'redact' = 'redact',
  ) {
    assertProvider(provider)
  }

  /**
   * Tests whether a token belongs to this coordinator and remains active.
   *
   * @example
   *   coordinator.isActiveToken(token)
   *
   * @param token - Operation token to test.
   */
  isActiveToken(token: OperationToken | undefined): boolean {
    return token?.coordinator === this && token.active
  }

  /**
   * Returns this coordinator's active token from asynchronous context.
   *
   * @example
   *   const token = coordinator.currentToken()
   */
  currentToken(): OperationToken | undefined {
    let frame = activeOperation.getStore()

    while (frame) {
      if (this.isActiveToken(frame.token)) return frame.token

      frame = frame.parent
    }

    return undefined
  }

  /**
   * Runs one root operation on an exclusive physical session.
   *
   * @example
   *   await coordinator.run(async ({ executor }) => executor.run(query))
   *
   * @param operation - Operation callback receiving scoped session capabilities.
   */
  run<T>(operation: (context: OperationContext) => Promise<T>): Promise<T> {
    if (this.currentToken()) {
      return Promise.reject(
        new QueryError({
          message:
            'Cannot use the root database client inside an active operation callback; use the scoped client instead',
        }),
      )
    }

    if (this.closing) {
      return Promise.reject(new QueryError({ message: 'Database has been closed' }))
    }

    const previous = this.tail
    const parent = activeOperation.getStore()
    let finish!: () => void
    this.tail = new Promise<void>((resolve) => {
      finish = resolve
    })

    return this.runSession(previous, parent, operation).finally(finish)
  }

  /**
   * Closes the provider after all queued operations finish.
   *
   * @example
   *   await coordinator.close()
   */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise

    this.closing = true
    this.closePromise = this.tail
      .then(() => this.provider.close())
      .catch((failure: unknown) => {
        throw this.classify ? classifyDriverError(failure, this.classify) : failure
      })
    return this.closePromise
  }
  /**
   * Opens, executes, verifies, and releases one exclusive operation session.
   *
   * @param previous - Queue promise for the preceding root operation.
   * @param parent - Parent relation or syntax node used by the fixture scenario.
   * @param operation - Work to run within the current session or error boundary.
   *
   * @returns The callback result after identity verification and lease release succeed.
   */
  private async runSession<T>(
    previous: Promise<void>,
    parent: ReturnType<typeof activeOperation.getStore>,
    operation: (context: OperationContext) => Promise<T>,
  ): Promise<T> {
    const state: OperationState<T> = {
      session: undefined,
      disposition: 'discard',
      operationFailed: false,
      operationError: undefined,
      result: undefined,
      capturedIdentity: undefined,
    }

    // Fresh sessions remain discard-only until their capabilities and identity pass.

    const operationAttempt = await attempt(() =>
      this.performOperation(state, previous, parent, operation),
    )

    if (!operationAttempt.ok) {
      state.operationFailed = true
      state.operationError = operationAttempt.error
    }

    await verifyOperationSession(state)

    await releaseOperationSession(state)

    if (state.operationFailed) {
      const classified = this.classify
        ? classifyDriverError(state.operationError, this.classify)
        : state.operationError

      throw classified
    }

    return state.result as T
  }
  /**
   * Runs a callback within its captured session identity and closes its asynchronous
   * scope afterward.
   *
   * @param state - Shared mutable state that preserves progress and cleanup outcomes
   *   across calls.
   * @param previous - Queue promise for the preceding root operation.
   * @param parent - Parent relation or syntax node used by the fixture scenario.
   * @param operation - Work to run within the current session or error boundary.
   */
  private async performOperation<T>(
    state: OperationState<T>,
    previous: Promise<void>,
    parent: ReturnType<typeof activeOperation.getStore>,
    operation: (context: OperationContext) => Promise<T>,
  ): Promise<void> {
    await previous
    state.session = await this.provider.open()
    assertSession(state.session)
    state.capturedIdentity = captureSessionIdentity(state.session)
    state.disposition = 'reuse'
    const executor = createSessionExecutor(
      state.session,
      this.classify,
      this.onQuery,
      this.queryParameters,
    )

    const token: OperationToken = {
      coordinator: this,
      executor,
      identity: state.capturedIdentity,
      active: true,
      /** Marks the physical session for disposal after the operation. */
      discard() {
        state.disposition = 'discard'
      },
    }

    state.result = await activeOperation
      .run({ token, parent }, () =>
        operation({
          executor,
          identity: token.identity,
          /** Marks the current physical session for disposal instead of reuse. */
          discard: () => token.discard(),
          /** Cancels work currently running on the pinned session. */
          cancel: () => {
            state.disposition = 'discard'
            return state.session!.cancel()
          },
        }),
      )
      .finally(() => {
        token.active = false
      })
  }
}

/**
 * Exposes pinned query and statement rejections under the selected member's policy.
 *
 * @param session - Pinned physical session whose identity and lifecycle must remain
 *   valid.
 *
 * @returns A pinned-session executor preserving unrecognized rejection identity.
 */
function createSessionExecutor(
  session: OperationSession,
  classify?: DriverErrorClassifier,
  onQuery?: QueryObserver,
  queryParameters: 'include' | 'redact' = 'redact',
): Executor {
  return {
    async execute(query, options) {
      try {
        return onQuery
          ? await observeQuery(
              query,
              options,
              'query',
              () => session.query(query),
              onQuery,
              queryParameters,
            )
          : await session.query(query)
      } catch (failure) {
        throw classify ? classifyDriverError(failure, classify) : failure
      }
    },
    async run(query, options) {
      try {
        return onQuery
          ? await observeQuery(
              query,
              options,
              'run',
              () => session.run(query),
              onQuery,
              queryParameters,
            )
          : await session.run(query)
      } catch (failure) {
        throw classify ? classifyDriverError(failure, classify) : failure
      }
    },
  }
}

/** Observes only the physical call, before error classification or session cleanup. */
async function observeQuery<T>(
  query: CompiledQuery,
  options: ExecutionOptions | undefined,
  method: QueryEvent['method'],
  call: () => Promise<T>,
  observer: QueryObserver,
  parameters: 'include' | 'redact',
): Promise<T> {
  const params = Object.freeze(
    query.params.map((value) => (parameters === 'include' ? value : '[REDACTED]')),
  )

  const start = performance.now()
  let outcome: { outcome: 'success' } | { outcome: 'error'; error: unknown } = {
    outcome: 'success',
  }

  try {
    return await call()
  } catch (error) {
    outcome = { outcome: 'error', error }
    throw error
  } finally {
    const durationMs = performance.now() - start
    notifyQuery(
      observer,
      Object.freeze({
        sql: query.sql,
        params,
        source: options?.source ?? 'query',
        method,
        durationMs,
        ...outcome,
      }),
    )
  }
}

type OperationState<T> = {
  session: OperationSession | undefined
  disposition: OperationSessionDisposition
  operationFailed: boolean
  operationError: unknown
  result: T | undefined
  capturedIdentity: OperationSessionIdentity | undefined
}

/**
 * Marks a session for discard when final identity verification fails.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 */
async function verifyOperationSession<T>(state: OperationState<T>): Promise<void> {
  if (state.session && state.capturedIdentity) {
    const activeSession = state.session
    const identity = state.capturedIdentity
    const verification = await attempt(async () =>
      assertStableSessionIdentity(activeSession, identity),
    )

    if (!verification.ok) {
      state.disposition = 'discard'
      const failure = mergeOperationFailure(
        state.operationFailed,
        state.operationError,
        verification.error,
      )

      state.operationFailed = failure.failed
      state.operationError = failure.error
    }
  }
}

/**
 * Releases the lease and preserves earlier operation or verification failures.
 *
 * @param state - Shared mutable state that preserves progress and cleanup outcomes across
 *   calls.
 */
async function releaseOperationSession<T>(state: OperationState<T>): Promise<void> {
  if (state.session) {
    const activeSession = state.session
    const release = await attempt(() => activeSession.release(state.disposition))

    if (!release.ok) {
      const failure = mergeOperationFailure(
        state.operationFailed,
        state.operationError,
        release.error,
      )

      state.operationFailed = failure.failed
      state.operationError = failure.error
    }
  }
}

/** Contains observer failures without extending the session lease to await them. */
function notifyQuery(observer: QueryObserver, event: QueryEvent): void {
  try {
    const result = observer(event)

    if (result) void Promise.resolve(result).catch(() => {})
  } catch {
    // Observers must not replace database results or failures.
  }
}
