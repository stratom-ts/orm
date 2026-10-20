import { sqliteSemanticContractInput } from './sqliteContractFixtures'
import {
  createSqliteCommonRuntime,
  createSqliteControllableProvider,
  createSqliteCoordinationRuntime,
  createSqliteProviderContractConnector,
  createSqliteProviderMigrationSchemas,
  createSqliteProviderPlanningFailureSchemas,
} from './sqliteSharedFixtures'

export const sqliteSemanticContractShard = {
  identity: { state: 'supported', input: sqliteSemanticContractInput.identity },
  naming: { state: 'supported', input: sqliteSemanticContractInput.naming },
  desiredSchema: {
    state: 'supported',
    input: sqliteSemanticContractInput.desiredSchema,
  },
  query: {
    state: 'supported',
    core: { state: 'supported', input: sqliteSemanticContractInput.query.core },
    scenarios: sqliteSemanticContractInput.query.scenarios,
    valueMapping: {
      state: 'supported',
      input: sqliteSemanticContractInput.query.valueMapping,
    },
  },
  catalog: { state: 'supported', input: sqliteSemanticContractInput.catalog },
  migration: { state: 'supported', input: sqliteSemanticContractInput.migration },
  lifecycle: { state: 'supported', input: sqliteSemanticContractInput.lifecycle },
} as const

export const sqliteOperationSessionContractShard = {
  operationSession: {
    state: 'supported',
    common: {
      state: 'supported',
      input: { createRuntime: createSqliteCommonRuntime },
    },
    controlled: {
      state: 'supported',
      input: {
        createProvider: createSqliteControllableProvider,
        migration: {
          state: 'supported',
          input: {
            connector: createSqliteProviderContractConnector,
            appliedSchemas: createSqliteProviderMigrationSchemas,
            planningFailureSchemas: createSqliteProviderPlanningFailureSchemas,
          },
        },
      },
    },
  },
} as const

export const sqliteCoordinationContractShard = {
  coordination: { state: 'supported', input: createSqliteCoordinationRuntime },
} as const
