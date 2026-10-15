import type { CompiledQuery, QuerySessionIdentity } from '@/dialects'

/** Whether a completed physical session may be reused or must be discarded. */
export type OperationSessionDisposition = 'reuse' | 'discard'

/** Stable identity of the database and physical backend serving an operation. */
export type OperationSessionIdentity = QuerySessionIdentity &
  Readonly<{
    physicalSession: string
  }>

/** An exclusive physical database session used for one root operation. */
export type OperationSession = {
  readonly identity: OperationSessionIdentity
  /**
   * Executes a row-returning query on the pinned physical session.
   *
   * @param query - Compiled SQL and ordered parameter bindings for the current physical
   *   call.
   *
   * @returns Native result rows from the session-bound physical SQL call.
   */
  query(query: CompiledQuery): Promise<unknown[]>
  /**
   * Executes a statement without requiring result rows.
   *
   * @param query - Compiled SQL and ordered parameter bindings for the current physical
   *   call.
   *
   * @returns The driver's affected-row count for DML, as a nonnegative safe integer.
   *   Statements without a meaningful count may return undefined. Missing or invalid
   *   DML counts are provider defects and cause writes to throw InvariantError.
   */
  run(query: CompiledQuery): Promise<number | undefined>
  /** Cancels the active physical-session operation. */
  cancel(): Promise<void>
  /**
   * Settles queued work and releases the lease for reuse or discard.
   *
   * @param disposition - Whether release may reuse the session or must discard it.
   */
  release(disposition: OperationSessionDisposition): Promise<void>
}

/** Opens exclusive physical sessions with native transaction affinity. */
export type OperationSessionProvider = {
  readonly nativeTransactions: true
  /**
   * Opens an exclusive physical-session lease.
   *
   * @returns An exclusive session lease whose identity remains stable until release.
   */
  open(): Promise<OperationSession>
  /** Closes owned resources after active work has settled. */
  close(): Promise<void>
}
