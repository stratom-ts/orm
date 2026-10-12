import nodeSqliteConnector from 'db0/connectors/node-sqlite'

import { createDatabase } from '@/index'

import type { DialectIntegrationAdapter } from '../support/dialectIntegrationContract'
import { registerDialectIntegrationScenarios } from '../support/dialectIntegrationContract'

const sqliteIntegration: DialectIntegrationAdapter = {
  name: 'SQLite node-sqlite',
  capabilities: {
    lifecycle: { state: 'supported' },
    query: { state: 'supported' },
    transaction: { state: 'supported' },
    migration: { state: 'supported' },
    convergence: { state: 'supported' },
  },
  /** Verifies native SQLite availability before registering production round trips. */
  readiness: async () => {
    const db = createDatabase({
      connector: nodeSqliteConnector({ name: ':memory:' }),
      schemas: [],
    })

    try {
      await db.ping()
    } finally {
      await db.close()
    }
  },
  /** Provides each shared integration scenario with its own native in-memory database. */
  withDatabase: async (schemas, callback) => {
    const db = createDatabase({
      connector: nodeSqliteConnector({ name: ':memory:' }),
      schemas,
    })

    try {
      return await callback({ db })
    } finally {
      await db.close()
    }
  },
}

registerDialectIntegrationScenarios(sqliteIntegration)
