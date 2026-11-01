import { it } from 'vitest'

import {
  StandardTransforms,
  assertStandardTransformCrud,
} from '../support/standardTransformsContract'

import { withSqliteDatabase } from './sqliteIntegration'

it('infers storage and maps standard Valibot transforms through SQLite CRUD', async () => {
  await withSqliteDatabase([StandardTransforms] as const, async ({ db }) => {
    await assertStandardTransformCrud(db, 'sqlite')
  })
})
