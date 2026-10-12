import type { DatabaseSync } from 'node:sqlite'

/**
 * Reports whether a native SQLite connection has an open transaction on every supported
 * Node version, including those without `DatabaseSync.isTransaction`.
 *
 * @param database - Native connection whose transaction state is probed.
 *
 * @returns Whether a transaction is open.
 */
export function inTransaction(database: DatabaseSync): boolean {
  try {
    database.exec('begin')
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('within a transaction'))
      return true

    throw cause
  }

  database.exec('rollback')
  return false
}
