import type { CompiledQuery } from '@/dialects'

export type Executor = {
  /** Run a query and return result rows (SELECT). */
  execute(query: CompiledQuery): Promise<unknown[]>
  /** Run a statement without requiring row results (DDL / DML). */
  run(query: CompiledQuery): Promise<void>
}
