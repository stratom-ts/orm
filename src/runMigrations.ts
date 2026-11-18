import type { Db } from './client'
import type { MigrationExecuteOptions } from './ddl'

/**
 * Executes the client's migration builder with its default permissions and policy.
 * The caller retains responsibility for closing the client.
 *
 * @param db - Client whose registered tables describe the desired schema.
 * @param options - Cancellation signal and execution deadlines passed to the builder.
 *
 * @returns Completion of `db.migrate().execute(options)`, with the same errors.
 */
function runMigrations(
  db: Pick<Db, 'migrate'>,
  options?: MigrationExecuteOptions,
): Promise<void> {
  return db.migrate().execute(options)
}

export { runMigrations }
