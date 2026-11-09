import { it } from 'vitest'

import { Entries, assertKeyset } from '../support/keysetContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('should traverse SQLite keyset pages with duplicates, nulls, and mapped cursor values', async () => {
  await withSqliteDatabase([Entries], ({ db }) => assertKeyset(db))
})
