import { it } from 'vitest'

import { runOperationSessionCommonContract } from '../../unit/dialects/dialectContractKit'
import { runDialectLifecycleContract } from '../../unit/dialects/dialectMemberContract'

import {
  createNativeSqliteCommonRuntime,
  createNativeSqliteLifecycleRuntime,
} from './sqliteNativeLifecycleFixtures'

it('routes the native SQLite public lifecycle, add-column migration, and cleanup through the selected member', async () => {
  await runDialectLifecycleContract(createNativeSqliteLifecycleRuntime())
})

it('runs the common session lifecycle on the native SQLite provider', async () => {
  await runOperationSessionCommonContract(createNativeSqliteCommonRuntime())
})
