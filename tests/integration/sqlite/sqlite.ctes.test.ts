import { it } from 'vitest'

import { assertCtes, tables } from '../support/cteContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('should execute CTE chains, mapped outputs, recursion and transaction scopes', async () => {
  await withSqliteDatabase(tables, async ({ db }) => assertCtes(db))
})
