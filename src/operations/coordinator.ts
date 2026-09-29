import { AsyncLocalStorage } from 'node:async_hooks'

import type { NamespaceContext } from '@/migrations/canonicalRelationIdentity'
import type { Executor } from '@/query'
import type { NamespaceRole } from '@/schemas'
import { QueryError, attempt } from '@/utils/error'

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
  discard(): void
}

type OperationFrame = {
  readonly token: OperationToken
  readonly parent: OperationFrame | undefined
}

const activeOperation = new AsyncLocalStorage<OperationFrame>()
const operationReleaseCleanupFailures = new WeakMap<object, unknown[]>()

function retainOperationReleaseCleanupFailure(cause: unknown, failure: unknown): void {
  if (!((typeof cause === 'object' && cause !== null) || typeof cause === 'function')) {
    return
  }

  const failures = operationReleaseCleanupFailures.get(cause) ?? []
  failures.push(failure)
  operationReleaseCleanupFailures.set(cause, failures)
}

function mergeOperationFailure(
  failed: boolean,
  error: unknown,
  failure: unknown,
): Readonly<{ failed: true; error: unknown }> {
  if (failed) retainOperationReleaseCleanupFailure(error, failure)

  return { failed: true, error: failed ? error : failure }
}

/**
 * Reads provider-release cleanup failures retained beside an object primary rejection.
 *
 * @example
 *   const cleanupFailures = getOperationReleaseCleanupFailures(error)
 *
 * @param cause - Primary rejection that may have retained cleanup failures.
 */
export function getOperationReleaseCleanupFailures(cause: unknown): readonly unknown[] {
  return (typeof cause === 'object' && cause !== null) || typeof cause === 'function'
    ? (operationReleaseCleanupFailures.get(cause) ?? [])
    : []
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
  let database: unknown
  let physicalSession: unknown
  let namespaceContext: OperationSessionIdentity['namespaceContext']

  try {
    const identity = (
      session as { readonly identity?: Partial<OperationSessionIdentity> }
    ).identity
    database = identity?.database
    physicalSession = identity?.physicalSession
    namespaceContext = captureNamespaceContext(identity?.namespaceContext)
  } catch (cause) {
    throw new QueryError({
      message: 'Unable to capture operation session identity',
      cause,
    })
  }

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
  let database: unknown
  let physicalSession: unknown
  let namespaceContext: OperationSessionIdentity['namespaceContext']

  try {
    const identity = (
      session as { readonly identity?: Partial<OperationSessionIdentity> }
    ).identity
    database = identity?.database
    physicalSession = identity?.physicalSession
    namespaceContext = captureNamespaceContext(identity?.namespaceContext)
  } catch (cause) {
    throw new QueryError({
      message: 'Unable to verify operation session identity before release',
      cause,
    })
  }

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
  constructor(private readonly provider: OperationSessionProvider) {
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

    return (async () => {
      let session: OperationSession | undefined

      // Fresh sessions remain discard-only until their capabilities and identity pass.
      let disposition: OperationSessionDisposition = 'discard'
      let operationFailed = false
      let operationError: unknown
      let result: T | undefined
      let capturedIdentity: OperationSessionIdentity | undefined
      const operationAttempt = await attempt(async () => {
        await previous
        session = await this.provider.open()
        assertSession(session)
        capturedIdentity = captureSessionIdentity(session)
        disposition = 'reuse'
        const executor: Executor = {
          /**
           * Executes a query through the pinned operation session.
           *
           * @param query - Compiled query to execute.
           */
          async execute(query) {
            try {
              return await session!.query(query)
            } catch (cause) {
              if (cause instanceof QueryError) throw cause

              throw new QueryError({
                message:
                  cause instanceof Error ? cause.message : 'Query execution failed',
                cause,
              })
            }
          },
          /**
           * Executes a statement through the pinned operation session.
           *
           * @param query - Compiled query to execute.
           */
          async run(query) {
            try {
              await session!.run(query)
            } catch (cause) {
              if (cause instanceof QueryError) throw cause

              throw new QueryError({
                message:
                  cause instanceof Error ? cause.message : 'Statement execution failed',
                cause,
              })
            }
          },
        }
        const token: OperationToken = {
          coordinator: this,
          executor,
          identity: capturedIdentity,
          active: true,
          /** Marks the physical session for disposal after the operation. */
          discard() {
            disposition = 'discard'
          },
        }
        result = await activeOperation
          .run({ token, parent }, () =>
            operation({
              executor,
              identity: token.identity,
              discard: () => token.discard(),
              /** Cancels work currently running on the pinned session. */
              cancel: () => {
                disposition = 'discard'
                return session!.cancel()
              },
            }),
          )
          .finally(() => {
            token.active = false
          })
      })

      if (!operationAttempt.ok) {
        operationFailed = true
        operationError = operationAttempt.error
      }

      if (session && capturedIdentity) {
        const activeSession = session
        const identity = capturedIdentity
        const verification = await attempt(async () =>
          assertStableSessionIdentity(activeSession, identity),
        )

        if (!verification.ok) {
          disposition = 'discard'
          const failure = mergeOperationFailure(
            operationFailed,
            operationError,
            verification.error,
          )
          operationFailed = failure.failed
          operationError = failure.error
        }
      }

      if (session) {
        const activeSession = session
        const release = await attempt(() => activeSession.release(disposition))

        if (!release.ok) {
          const failure = mergeOperationFailure(
            operationFailed,
            operationError,
            release.error,
          )
          operationFailed = failure.failed
          operationError = failure.error
        }
      }

      if (operationFailed) throw operationError

      return result as T
    })().finally(finish)
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
    this.closePromise = this.tail.then(() => this.provider.close())
    return this.closePromise
  }
}
