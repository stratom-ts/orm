import { pipe, string } from 'valibot'

import { column, defineTable } from '@/index'

import {
  createControllableProvider,
  createOperationSessionCommonRuntime,
  customConnector,
} from '../helpers/operationSessionFixtures'
import { createPostgresMigrationRuntime } from '../helpers/postgresMigrationRuntimeFixtures'

import type { CoordinationContractFactory } from './migrationCoordinationContract'

const createPostgresCoordinationRuntime: CoordinationContractFactory = (options = {}) => {
  const runtime = createPostgresMigrationRuntime(options)
  return {
    ...runtime,
    execute: (runtimeOptions) => runtime.execute(undefined, runtimeOptions),
  }
}

export const postgresCoordinationContractShard = {
  coordination: { state: 'supported', input: createPostgresCoordinationRuntime },
} as const

export const postgresOperationSessionContractShard = {
  operationSession: {
    state: 'supported',
    common: {
      state: 'supported',
      input: {
        createRuntime: () => createOperationSessionCommonRuntime().runtime,
      },
    },
    controlled: {
      state: 'supported',
      input: {
        createProvider: createControllableProvider,
        migration: {
          connector: customConnector,
          appliedSchemas: () => [
            defineTable(
              'provider_contract_events',
              { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
              { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
            ),
          ],
          planningFailureSchemas: () => [
            defineTable(
              'provider_planning_events',
              { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
              { primaryKey: 'id' },
            ),
            defineTable(
              'provider_planning_events',
              { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
              { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
            ),
          ],
        },
      },
    },
  },
} as const
