import type { TracingChannel } from 'node:diagnostics_channel'

import type { CompiledQuery } from '@/dialects'

/** Process-wide diagnostics tracing channel for Stratom physical SQL attempts. */
export const QUERY_CHANNEL = 'stratom.query'

/** The purpose of SQL sent through a pinned operation session. */
export type QuerySource = 'query' | 'lifecycle' | 'catalog' | 'coordination' | 'ddl'

/**
 * Shared lifecycle context. Completion fields are populated before
 * error/asyncStart/asyncEnd.
 */
export type QueryEvent = {
  readonly query: string
  readonly params: readonly unknown[]
  readonly source: QuerySource
  readonly method: 'query' | 'run'
  durationMs?: number
  outcome?: 'success' | 'error'
  error?: unknown
}

/** Controls bound-value visibility on a traced client. */
export type TracingOptions = Readonly<{ queryParameters?: 'include' | 'redact' }>

/** Internal per-client selection; never stored on the shared coordinator. */
export type QueryTracing = Readonly<{
  channel: TracingChannel
  parameters: 'include' | 'redact'
}>

/** Internal execution metadata, independent of compiled SQL identity. */
export type ExecutionOptions = Readonly<{ source: QuerySource; tracing?: QueryTracing }>

/** Looks up tracing without requiring newer TracingChannel.hasSubscribers support. */
export function createQueryTracing(options: TracingOptions): QueryTracing | undefined {
  type Diagnostics = Partial<
    Pick<typeof import('node:diagnostics_channel'), 'tracingChannel'>
  >

  const runtime: {
    process?: { getBuiltinModule?: (name: string) => Diagnostics | undefined }
  } = globalThis

  let diagnostics: Diagnostics | undefined
  try {
    diagnostics = runtime.process?.getBuiltinModule?.('node:diagnostics_channel')
  } catch {
    return undefined
  }

  if (!diagnostics?.tracingChannel) return undefined

  return {
    channel: diagnostics.tracingChannel(QUERY_CHANNEL),
    parameters: options.queryParameters ?? 'redact',
  }
}

/** Publishes a lifecycle without exposing the physical result through tracePromise. */
export function traceQuery<T>(
  query: CompiledQuery,
  options: ExecutionOptions | undefined,
  method: QueryEvent['method'],
  call: () => Promise<T>,
  tracing: QueryTracing | undefined,
): Promise<T> {
  const channel = tracing?.channel

  if (
    !channel ||
    !(
      channel.start.hasSubscribers ||
      channel.end.hasSubscribers ||
      channel.error.hasSubscribers ||
      channel.asyncStart.hasSubscribers ||
      channel.asyncEnd.hasSubscribers
    )
  )
    return call()

  const event: QueryEvent = {
    query: query.sql,
    params: Object.freeze(
      query.params.map((v) => (tracing.parameters === 'include' ? v : '[REDACTED]')),
    ),
    source: options?.source ?? 'query',
    method,
  }

  // Dispatch after end subscribers so their time is outside the physical call.
  // tracePromise adds result to its context. Keep that value undefined, carrying rows separately.
  let result: T
  return channel
    .tracePromise(
      () =>
        Promise.resolve().then(async () => {
          const start = performance.now()
          try {
            result = await call()
            event.outcome = 'success'
          } catch (error) {
            event.outcome = 'error'
            event.error = error
            throw error
          } finally {
            event.durationMs = performance.now() - start
          }
        }),
      event,
    )
    .then(() => result)
}
