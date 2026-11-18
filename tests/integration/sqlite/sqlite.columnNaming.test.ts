import { it } from 'vitest'

import type { Db } from '@/index'
import { createDatabase, sqliteDialect } from '@/index'

import { assertNaming } from '../support/columnNamingContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('should use stable per-client naming throughout real SQLite operations', async () => {
  await withSqliteDatabase([], async ({ connector, native }) => {
    native.exec('pragma foreign_keys = on')
    const clients: Db[] = []
    try {
      await assertNaming((schemas, options) => {
        const db = createDatabase({ connector, schemas, ...options })
        clients.push(db)
        return db
      }, sqliteDialect)
    } finally {
      await Promise.all(clients.map((db) => db.close()))
    }
  })
})
