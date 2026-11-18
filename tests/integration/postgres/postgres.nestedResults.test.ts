import { it } from 'vitest'

import {
  assertNestedCardinality,
  assertNestedResults,
  nestedTables,
} from '../support/nestedResultsContract'

import { withPostgresDatabase } from './postgresIntegration'

it('should group joined PostgreSQL rows by each nested relation key', async () => {
  await withPostgresDatabase(nestedTables, ({ db }) => assertNestedResults(db))
})

it('should reject a to-one PostgreSQL relation with multiple distinct keys', async () => {
  await withPostgresDatabase(nestedTables, ({ db }) => assertNestedCardinality(db))
})
