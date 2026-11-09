import { beforeAll, it } from 'vitest'

import {
  StandardTransforms,
  assertStandardTransformCrud,
} from '../support/standardTransformsContract'

import { waitForPostgres } from './postgres.setup'
import { withPostgresDatabase } from './postgresIntegration'

beforeAll(waitForPostgres)

it('should infer storage and map standard Valibot transforms through PostgreSQL CRUD', async () => {
  await withPostgresDatabase([StandardTransforms] as const, async ({ db }) => {
    await assertStandardTransformCrud(db, 'postgres')
  })
})
