import { pipe, string } from 'valibot'

import { column, defineTable } from '@/index'

import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

import { registerDialectContractKit } from './dialectContractKit'

registerDialectContractKit({
  name: 'PostgreSQL custom connector adaptation',
  operationSession: {
    common: {
      state: 'supported',
      input: {
        createRuntime() {
          const controls = createControllableProvider()
          return {
            provider: controls.provider,
            events: () =>
              controls.events.flatMap((event) => {
                if (event === 'statement:1:contract query') return ['query' as const]
                if (event === 'statement:1:contract run') return ['run' as const]
                if (event === 'cancel-requested:1') return ['cancel' as const]

                if (event === 'release-finished:1:reuse')
                  return ['release:reuse' as const]
                if (event === 'provider-closed') return ['close' as const]
                return []
              }),
          }
        },
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
              {
                id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
              },
              {
                primaryKey: 'id',
                namespace: [{ role: 'schema', spelling: 'public' }],
              },
            ),
          ],
          planningFailureSchemas: () => [
            defineTable(
              'provider_planning_events',
              {
                id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
              },
              { primaryKey: 'id' },
            ),
            defineTable(
              'provider_planning_events',
              {
                id: pipe(string(), column({ physicalType: { postgresql: 'uuid' } })),
              },
              {
                primaryKey: 'id',
                namespace: [{ role: 'schema', spelling: 'public' }],
              },
            ),
          ],
        },
      },
    },
  },
})
