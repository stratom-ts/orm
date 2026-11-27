import type { CompiledQuery } from '@/dialects'

import type { Cursor } from './cursor'
import type { ExecutionOptions, QuerySource } from './observation'

export type Executor = {
  openCursor?(query: CompiledQuery, signal?: AbortSignal): Promise<Cursor<unknown>>

  /**
   * Run a query and return result rows (SELECT).
   *
   * @throws {QueryError} For invalid query or session use.
   * @throws {DriverError} For a native dependency failure.
   * @throws {Error} Unrecognized adapter defects propagate unchanged.
   */
  execute(query: CompiledQuery, options?: ExecutionOptions): Promise<unknown[]>
  /**
   * Run a statement without requiring row results (DDL / DML).
   *
   * @returns The driver's nonnegative safe integer affected-row count for DML, or
   *   undefined for statements without a meaningful count.
   */
  run(query: CompiledQuery, options?: ExecutionOptions): Promise<number | undefined>
}

/** Supplies a source while preserving explicit metadata from composed executors. */
export function withQuerySource(executor: Executor, source: QuerySource): Executor {
  return {
    openCursor: executor.openCursor?.bind(executor),
    execute: (query, options) => executor.execute(query, options ?? { source }),
    run: (query, options) => executor.run(query, options ?? { source }),
  }
}
