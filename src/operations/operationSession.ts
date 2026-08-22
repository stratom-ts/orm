import type { CompiledQuery } from '@/dialects'

/** Whether a completed physical session may be reused or must be discarded. */
export type OperationSessionDisposition = 'reuse' | 'discard'

/** Stable identity of the database and physical backend serving an operation. */
export type OperationSessionIdentity = Readonly<{
  database: string
  physicalSession: string
}>

/** An exclusive physical database session used for one root operation. */
export type OperationSession = {
  readonly identity: OperationSessionIdentity
  query(query: CompiledQuery): Promise<unknown[]>
  run(query: CompiledQuery): Promise<void>
  cancel(): Promise<void>
  release(disposition: OperationSessionDisposition): Promise<void>
}

/** Opens exclusive physical sessions with native transaction affinity. */
export type OperationSessionProvider = {
  readonly nativeTransactions: true
  open(): Promise<OperationSession>
  close(): Promise<void>
}
