import type { CompiledQuery, Kysely } from 'kysely'

/**
 * Creates database index creation queries for specified columns.
 *
 * @param db - The Kysely database instance
 * @param table - The name of the database table
 * @param indexes - Optional array of column names to create indexes for
 * @returns Array of compiled index creation queries
 * @example
 * ```ts
 * const queries = createIndexes(db, 'users', ['email', 'created_at'])
 * // Returns queries for creating users_email_idx and users_created_at_idx
 * ```
 */
export function createIndexes(
  db: Kysely<unknown>,
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
