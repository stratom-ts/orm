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
  /**
   * Run a statement without requiring row results (DDL / DML).
   *
   * @returns The driver's nonnegative safe integer affected-row count for DML, or
   *   undefined for statements without a meaningful count.
   */
  run(query: CompiledQuery): Promise<number | undefined>
}
