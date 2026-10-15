import type { CompiledQuery } from '@/dialects'

export type Executor = {
  /**
   * Run a query and return result rows (SELECT).
   *
   * @throws {QueryError} For invalid query or session use.
   * @throws {DriverError} For a native dependency failure.
   * @throws {Error} Unrecognized adapter defects propagate unchanged.
   */
  execute(query: CompiledQuery): Promise<unknown[]>
  /** Run a statement without requiring row results (DDL / DML). */
  run(query: CompiledQuery): Promise<void>
}
