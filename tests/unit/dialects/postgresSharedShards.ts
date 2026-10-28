import { postgresSemanticContractInput } from './postgresContractFixtures'
import { createPostgresControllableProvider } from './postgresOperationSessionFixtures'
import {
  createPostgresCoordinationRuntime,
  createPostgresOperationSessionCommonRuntime,
  createPostgresProviderContractConnector,
  createPostgresProviderMigrationSchemas,
  createPostgresProviderPlanningFailureSchemas,
} from './postgresSharedFixtures'

export const postgresSemanticContractShard = {
  identity: { state: 'supported', input: postgresSemanticContractInput.identity },
  naming: { state: 'supported', input: postgresSemanticContractInput.naming },
  desiredSchema: {
    state: 'supported',
    input: postgresSemanticContractInput.desiredSchema,
  },
  query: {
    state: 'supported',
    core: { state: 'supported', input: postgresSemanticContractInput.query.core },
    scenarios: postgresSemanticContractInput.query.scenarios,
    valueMapping: {
      state: 'supported',
      input: postgresSemanticContractInput.query.valueMapping,
    },
  },
  catalog: { state: 'supported', input: postgresSemanticContractInput.catalog },
  migration: { state: 'supported', input: postgresSemanticContractInput.migration },
  lifecycle: { state: 'supported', input: postgresSemanticContractInput.lifecycle },
} as const

export const postgresCoordinationContractShard = {
  coordination: { state: 'supported', input: createPostgresCoordinationRuntime },
} as const

export const postgresOperationSessionContractShard = {
  operationSession: {
    state: 'supported',
    common: {
      state: 'supported',
      input: { createRuntime: createPostgresOperationSessionCommonRuntime },
    },
    controlled: {
      state: 'supported',
      input: {
        createProvider: createPostgresControllableProvider,
        migration: {
          state: 'supported',
          input: {
            connector: createPostgresProviderContractConnector,
            appliedSchemas: createPostgresProviderMigrationSchemas,
            planningFailureSchemas: createPostgresProviderPlanningFailureSchemas,
          },
        },
      },
    },
  },
} as const
