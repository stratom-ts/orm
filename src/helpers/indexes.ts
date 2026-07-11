import type { CompiledQuery, Kysely } from 'kysely'

/**
 * Builds `CREATE INDEX IF NOT EXISTS` queries for the given columns.
 *
 * @param db - Kysely instance
 * @param table - Table name
 * @param indexes - Column names to index
 * @returns Compiled index creation queries
 *
 * @example
 * ```ts
 * const queries = createIndexes(db, 'users', ['email', 'created_at'])
 * // users_email_idx, users_created_at_idx
 * ```
 */
export function createIndexes<T>(
  db: Kysely<T>,
  table: string,
  indexes?: string[],
) {
  const queries: CompiledQuery[] = []
  if (!indexes?.length) return queries
  for (const indexColumn of indexes) {
    const query = db.schema
      .createIndex(`${table}_${indexColumn}_idx`)
      .ifNotExists()
      .on(table)
      .column(indexColumn)
      .compile()
    queries.push(query)
  }
  return queries
}
