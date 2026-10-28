import { pipe, string } from 'valibot'

import { column, defineTable } from '@/index'

import {
  createOperationSessionCommonRuntime,
  customConnector,
} from '../helpers/operationSessionFixtures'

import type { CoordinationContractFactory } from './migrationCoordinationContract'
import { createPostgresMigrationRuntime } from './postgresMigrationRuntimeFixtures'

/**
 * Creates the postgres coordination runtime fixture used by the contract scenario.
 *
 * @param options - Fixture controls for outcomes, observed calls, and failure scenarios.
 *
 * @returns The postgres coordination runtime fixture used by the contract scenario.
 */
export const createPostgresCoordinationRuntime: CoordinationContractFactory = (
  options = {},
) => {
  const runtime = createPostgresMigrationRuntime(options)
  return {
    ...runtime,
    /** Executes fixture SQL with the configured native observations. */
    execute: (runtimeOptions) => runtime.execute(undefined, runtimeOptions),
  }
}

/** Creates the generic lifecycle fixture used by PostgreSQL contract scenarios. */
export function createPostgresOperationSessionCommonRuntime() {
  return createOperationSessionCommonRuntime().runtime
}

/** Creates the connector selected by the PostgreSQL provider contract. */
export function createPostgresProviderContractConnector() {
  return customConnector('postgresql')
}

/** Creates the migration handles used by the controlled provider contract. */
export function createPostgresProviderMigrationSchemas() {
  return [
    defineTable(
      'provider_contract_events',
      { id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })) },
      { primaryKey: 'id', namespace: [{ role: 'schema', spelling: 'public' }] },
    ),
  ]
}

/** Creates invalid duplicate handles for the provider planning failure scenario. */
export function createPostgresProviderPlanningFailureSchemas() {
  return [
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
  ]
}
