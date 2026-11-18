import { it } from 'vitest'

import {
  assertNestedCardinality,
  assertNestedResults,
  nestedTables,
} from '../support/nestedResultsContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('should group joined SQLite rows by each nested relation key', async () => {
  await withSqliteDatabase(nestedTables, ({ db }) => assertNestedResults(db))
})

it('should reject a to-one SQLite relation with multiple distinct keys', async () => {
  await withSqliteDatabase(nestedTables, ({ db }) => assertNestedCardinality(db))
})
