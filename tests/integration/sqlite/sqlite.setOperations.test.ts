import { expect, it } from 'vitest'

import {
  assertSetOperations,
  scalarCardinalityQuery,
  tables,
} from '../support/setOperationsContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('should preserve native set semantics, grouping, mapping, pagination and subquery scopes', async () => {
  await withSqliteDatabase(tables, async ({ db }) => {
    await assertSetOperations(db)
    await expect(scalarCardinalityQuery(db).execute()).resolves.toEqual([{ value: 3 }])
  })
})
