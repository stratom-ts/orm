import { it } from 'vitest'

import { postgresDialect } from '@/index'

import { assertNaming } from '../support/columnNamingContract'

import { withPostgresDatabase } from './postgresIntegration'

it('should use stable per-client naming throughout real PostgreSQL operations', async () => {
  await withPostgresDatabase([], async ({ createDatabase, schema }) => {
    await assertNaming(createDatabase, postgresDialect, [schema])
  })
})
