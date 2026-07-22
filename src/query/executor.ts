import type { Database } from 'db0'

import type { CompiledQuery } from '@/dialects'
import { QueryError } from '@/utils/error'

export type Executor = {
  /** Run a query and return result rows (SELECT). */
  execute(query: CompiledQuery): Promise<unknown[]>
  /** Run a statement without requiring row results (DDL / DML). */
  run(query: CompiledQuery): Promise<void>
}

/**
 * Runs parameterized SQL through a db0 database instance.
 */
export function createDb0Executor(database: Database): Executor {
  const runPrepared = async (query: CompiledQuery) => {
    const statement = database.prepare(query.sql)
    if (query.params.length === 0) {
      return statement
    }
    return statement.bind(...(query.params as never[]))
  }

  return {
    async execute(query: CompiledQuery): Promise<unknown[]> {
      try {
        const statement = await runPrepared(query)
        return await statement.all()
      } catch (cause) {
        throw new QueryError({
          message:
            cause instanceof Error ? cause.message : 'Query execution failed',
          cause,
        })
      }
    },

    async run(query: CompiledQuery): Promise<void> {
      try {
        const statement = await runPrepared(query)
        await statement.run()
      } catch (cause) {
        throw new QueryError({
          message:
            cause instanceof Error
              ? cause.message
              : 'Statement execution failed',
          cause,
        })
      }
    },
  }
}
