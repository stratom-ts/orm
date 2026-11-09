import { it } from 'vitest'

import { Entries, assertKeyset } from '../support/keysetContract'

import { withPostgresDatabase } from './postgresIntegration'

it('should traverse PostgreSQL keyset pages with duplicates, nulls, and mapped cursor values', async () => {
  await withPostgresDatabase([Entries], ({ db }) => assertKeyset(db))
})
