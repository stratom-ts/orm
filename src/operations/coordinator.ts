import { AsyncLocalStorage } from 'node:async_hooks'

import type { Executor } from '@/query'
import { QueryError } from '@/utils/error'

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

/**
 * Validates the operation session provider contract at runtime.
 *
 * @param provider - Provider to validate.
 */
function assertProvider(provider: OperationSessionProvider): void {
  if (
    provider?.nativeTransactions !== true ||
    typeof provider.open !== 'function' ||
    typeof provider.close !== 'function'
  ) {
    throw new QueryError({
      message:
        'operationSessionProvider must provide pinned sessions with native transaction semantics',
    })
  }
}

/**
 * Validates a pinned operation session and its stable identity.
 *
 * @param session - Session to validate.
 */
function assertSession(session: OperationSession): void {
  const identity = session?.identity
  if (
    typeof session?.query !== 'function' ||
    typeof session.run !== 'function' ||
    typeof session.cancel !== 'function' ||
    typeof session.release !== 'function' ||
    typeof identity?.database !== 'string' ||
    identity.database.length === 0 ||
    typeof identity.physicalSession !== 'string' ||
    identity.physicalSession.length === 0
  ) {
    throw new QueryError({
      message: 'Operation session provider returned an invalid pinned session',
    })
  }
}

export type OperationContext = Readonly<{
  executor: Executor
  identity: OperationSessionIdentity
  discard(): void
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
      let disposition: OperationSessionDisposition = 'reuse'
      let operationFailed = false
      let operationError: unknown
      let result: T | undefined
      try {
        try {
          await previous
          session = await this.provider.open()
          assertSession(session)
          const database = session.identity.database
          const physicalSession = session.identity.physicalSession
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
            identity: session.identity,
            active: true,
            /** Marks the physical session for disposal after the operation. */
            discard() {
              disposition = 'discard'
            },
          }
          try {
            result = await activeOperation.run({ token, parent }, () =>
              operation({
                executor,
                identity: token.identity,
                discard: token.discard,
              }),
            )
            if (
              session.identity.database !== database ||
              session.identity.physicalSession !== physicalSession
            ) {
              disposition = 'discard'
              throw new QueryError({
                message: 'Operation session identity changed before release',
              })
            }
          } finally {
            token.active = false
          }
        } catch (cause) {
          operationFailed = true
          operationError = cause
        }

        if (session) {
          try {
            await session.release(disposition)
          } catch (cause) {
            if (!operationFailed) {
              operationFailed = true
              operationError = cause
            }
          }
        }

        if (operationFailed) throw operationError
        return result as T
      } finally {
        finish()
      }
    })()
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
