import { pipe, string } from 'valibot'

import { column, defineTable } from '@/index'

import {
  createControllableProvider,
  createOperationSessionCommonRuntime,
  customConnector,
} from '../helpers/operationSessionFixtures'
import { createPostgresMigrationRuntime } from '../helpers/postgresMigrationRuntimeFixtures'

import type { CoordinationContractFactory } from './migrationCoordinationContract'

/**
 * Creates the postgres coordination runtime fixture used by the contract scenario.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns The postgres coordination runtime fixture used by the contract scenario.
 */
const createPostgresCoordinationRuntime: CoordinationContractFactory = (options = {}) => {
  const runtime = createPostgresMigrationRuntime(options)
  return {
    ...runtime,
    /** Executes fixture SQL with the configured native observations. */
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
        /** Creates the runtime fixture used by the contract scenario. */
        createRuntime: () => createOperationSessionCommonRuntime().runtime,
      },
    },
    controlled: {
      state: 'supported',
      input: {
        createProvider: createControllableProvider,
        migration: {
          connector: customConnector,
          /**
           * Returns table handles used to exercise successful migration through the
           * provider.
           */
          appliedSchemas: () => [
            defineTable(
              'provider_contract_events',
              { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
              { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
            ),
          ],
          /** Returns table handles whose metadata forces a planning failure. */
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
