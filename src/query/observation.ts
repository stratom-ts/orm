/** The purpose of SQL sent through a pinned operation session. */
export type QuerySource = 'query' | 'lifecycle' | 'catalog' | 'coordination' | 'ddl'

/** One completed attempt at a pinned-session SQL call. */
export type QueryEvent = Readonly<{
  sql: string
  params: readonly unknown[]
  source: QuerySource
  method: 'query' | 'run'
  durationMs: number
}> &
  (Readonly<{ outcome: 'success' }> | Readonly<{ outcome: 'error'; error: unknown }>)

/** Receives completion events. Returned promises are handled but never awaited. */
export type QueryObserver = (event: QueryEvent) => void | Promise<void>

/** Internal source metadata, independent of compiled SQL identity. */
export type ExecutionOptions = Readonly<{ source: QuerySource }>
