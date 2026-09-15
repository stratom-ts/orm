import { pipe, string } from 'valibot'
import { expect, it } from 'vitest'

import { column, defineTable } from '@/index'

import {
  createControllableProvider,
  customConnector,
} from '../helpers/operationSessionFixtures'

import {
  registerDialectContractKit,
  runOperationSessionCommonContract,
} from './dialectContractKit'

function createCommonRuntime(options?: Parameters<typeof createControllableProvider>[0]) {
  const controls = createControllableProvider(options)
  return {
    controls,
    runtime: {
      provider: controls.provider,
      events: () =>
        controls.events.flatMap((event) => {
          if (event === 'statement:1:contract query') return ['query' as const]
          if (event === 'statement:1:contract run') return ['run' as const]
          if (event === 'cancel-requested:1') return ['cancel' as const]
          if (event === 'release-finished:1:reuse') return ['release:reuse' as const]
          if (event === 'provider-closed') return ['close' as const]
          return []
        }),
    },
  }
}

function expectCleanupOrder(
  controls: ReturnType<typeof createControllableProvider>,
  releaseEvent: string,
) {
  const releaseIndex = controls.events.indexOf(releaseEvent)
  const closeIndex = controls.events.indexOf('provider-closed')
  expect(releaseIndex).toBeGreaterThanOrEqual(0)
  expect(closeIndex).toBeGreaterThan(releaseIndex)
}

it('discards and closes after an operation failure', async () => {
  const { controls, runtime } = createCommonRuntime({ failSession: 1 })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toThrow(
    /session 1 failed/i,
  )
  expectCleanupOrder(controls, 'release-finished:1:discard')
  expect(controls.closeCount).toBe(1)
})

it('cleans up the common session after an assertion failure', async () => {
  const { controls, runtime } = createCommonRuntime({
    invalidInitialSession: 'identity',
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toThrow(
    /greater than 0/i,
  )
  expectCleanupOrder(controls, 'release-finished:1:discard')
  expect(controls.closeCount).toBe(1)
})

it('preserves the primary operation failure when release and close also fail', async () => {
  const primary = new Error('primary operation failure')
  const { controls, runtime } = createCommonRuntime({
    beforeCall: async () => {
      throw primary
    },
    releaseFailure: { session: 1, value: new Error('release cleanup failure') },
    closeFailure: { value: new Error('provider close failure') },
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toBe(primary)
  expectCleanupOrder(controls, 'release-started:1:discard')
  expect(controls.closeCount).toBe(1)
})

it('surfaces cleanup failure when the operation succeeds and still closes the provider', async () => {
  const release = new Error('release cleanup failure')
  const { controls, runtime } = createCommonRuntime({
    releaseFailure: { session: 1, value: release },
    closeFailure: { value: new Error('provider close failure') },
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toBe(release)
  expectCleanupOrder(controls, 'release-started:1:reuse')
  expect(controls.closeCount).toBe(1)
})

it('surfaces an undefined close failure instead of silently passing', async () => {
  const { controls, runtime } = createCommonRuntime({
    closeFailure: { value: undefined },
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toBeUndefined()
  expectCleanupOrder(controls, 'release-finished:1:reuse')
  expect(controls.closeCount).toBe(1)
})

registerDialectContractKit({
  name: 'PostgreSQL custom connector adaptation',
  operationSession: {
    common: {
      state: 'supported',
      input: {
        createRuntime: () => createCommonRuntime().runtime,
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
