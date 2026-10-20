import { expect, expectTypeOf, it } from 'vitest'

import type { createControllableProvider } from '../helpers/operationSessionFixtures'
import { createOperationSessionCommonRuntime } from '../helpers/operationSessionFixtures'

import { runOperationSessionCommonContract } from './dialectContractKit'
import {
  registerOperationSessionProviderContract,
  validateProviderMigrationSupport,
} from './operationSessionProviderContract'
import type {
  ProviderMigrationContract,
  ProviderMigrationSupport,
} from './operationSessionProviderContract'

type MissingPlanningFailureFixture = Readonly<{
  state: 'supported'
  input: Readonly<{
    connector(): never
    appliedSchemas(): readonly never[]
  }>
}>

it('should require migration participation and planning failure fixtures in provider contract types', () => {
  expectTypeOf<
    Parameters<typeof registerOperationSessionProviderContract>['length']
  >().toEqualTypeOf<3>()

  expectTypeOf<ProviderMigrationContract>().not.toExtend<ProviderMigrationSupport>()

  expectTypeOf<MissingPlanningFailureFixture>().not.toExtend<ProviderMigrationSupport>()

  expectTypeOf<{
    state: 'supported'
    input: {
      connector: () => never
      appliedSchemas: () => never[]
      planningFailureSchemas: () => never[]
    }
  }>().toExtend<ProviderMigrationSupport>()

  expectTypeOf<{
    state: 'unsupported'
    reason: string
  }>().toExtend<ProviderMigrationSupport>()
})

it('should require explicit provider migration participation before registering controlled scenarios', () => {
  expect(() =>
    validateProviderMigrationSupport({
      state: 'unsupported',
      reason: 'Custom adapter does not expose provider-backed migrations',
    }),
  ).not.toThrow()

  expect(() =>
    registerOperationSessionProviderContract(
      'missing migration',
      (() => ({})) as never,
      undefined as never,
    ),
  ).toThrow(/explicit migration participation/i)

  expect(() =>
    registerOperationSessionProviderContract(
      'missing planning failure',
      (() => ({})) as never,
      {
        state: 'supported',
        input: {
          connector: () => ({}),
          appliedSchemas: () => [],
        },
      } as never,
    ),
  ).toThrow(/planningFailureSchemas/i)

  expect(() =>
    registerOperationSessionProviderContract(
      'blank unsupported reason',
      (() => ({})) as never,
      {
        state: 'unsupported',
        reason: '  ',
      },
    ),
  ).toThrow(/non-empty unsupported reason/i)

  expect(() =>
    registerOperationSessionProviderContract(
      'invalid migration state',
      (() => ({})) as never,
      {
        state: 'unknown',
      } as never,
    ),
  ).toThrow(/explicit migration participation/i)
})

/**
 * Checks that retained cleanup evidence preserves verification and release order.
 *
 * @param controls - Mutable test observations and synchronization controls.
 * @param releaseEvent - Recorded session release used to check cleanup ordering.
 */
function expectCleanupOrder(
  controls: ReturnType<typeof createControllableProvider>,
  releaseEvent: string,
) {
  const releaseIndex = controls.events.indexOf(releaseEvent)
  const closeIndex = controls.events.indexOf('provider-closed')
  expect(releaseIndex).toBeGreaterThanOrEqual(0)
  expect(closeIndex).toBeGreaterThan(releaseIndex)
}

it('should discard and close after an operation failure', async () => {
  const { controls, runtime } = createOperationSessionCommonRuntime({ failSession: 1 })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toThrow(
    /session 1 failed/i,
  )

  expectCleanupOrder(controls, 'release-finished:1:discard')
  expect(controls.closeCount).toBe(1)
})

it('should clean up the common session after an assertion failure', async () => {
  const { controls, runtime } = createOperationSessionCommonRuntime({
    invalidInitialSession: 'identity',
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toThrow(
    /greater than 0/i,
  )

  expectCleanupOrder(controls, 'release-finished:1:discard')
  expect(controls.closeCount).toBe(1)
})

it('should preserve the primary operation failure when release and close also fail', async () => {
  const primary = new Error('primary operation failure')
  const { controls, runtime } = createOperationSessionCommonRuntime({
    /** Runs the configured synchronization or failure control before a fixture SQL call. */
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

it('should surface cleanup failure when the operation succeeds and still closes the provider', async () => {
  const release = new Error('release cleanup failure')
  const { controls, runtime } = createOperationSessionCommonRuntime({
    releaseFailure: { session: 1, value: release },
    closeFailure: { value: new Error('provider close failure') },
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toBe(release)
  expectCleanupOrder(controls, 'release-started:1:reuse')
  expect(controls.closeCount).toBe(1)
})

it('should surface an undefined close failure instead of silently passing', async () => {
  const { controls, runtime } = createOperationSessionCommonRuntime({
    closeFailure: { value: undefined },
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toBeUndefined()
  expectCleanupOrder(controls, 'release-finished:1:reuse')
  expect(controls.closeCount).toBe(1)
})
