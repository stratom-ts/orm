import { expect, it } from 'vitest'

import {
  assertSetOperations,
  scalarCardinalityQuery,
  tables,
} from '../support/setOperationsContract'

import { withPostgresDatabase } from './postgresIntegration'

it('should preserve native set semantics, grouping, mapping, pagination and subquery scopes', async () => {
  await withPostgresDatabase(tables, async ({ db }) => {
    await assertSetOperations(db)

    await expect(scalarCardinalityQuery(db).execute()).rejects.toMatchObject({
      _tag: 'DriverError',
      code: '21000',
    })
  })
})
