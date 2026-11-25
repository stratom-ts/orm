import { it } from 'vitest'

import { assertCtes, tables } from '../support/cteContract'

import { withPostgresDatabase } from './postgresIntegration'

it('should execute CTE chains, mapped outputs, recursion and transaction scopes', async () => {
  await withPostgresDatabase(tables, async ({ db }) => assertCtes(db))
})
