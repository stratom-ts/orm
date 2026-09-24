import { expect, it } from 'vitest'

import {
  createControllableProvider,
  createOperationSessionCommonRuntime,
} from '../helpers/operationSessionFixtures'

import { runOperationSessionCommonContract } from './dialectContractKit'

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
  const { controls, runtime } = createOperationSessionCommonRuntime({ failSession: 1 })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toThrow(
    /session 1 failed/i,
  )

  expectCleanupOrder(controls, 'release-finished:1:discard')
  expect(controls.closeCount).toBe(1)
})

it('cleans up the common session after an assertion failure', async () => {
  const { controls, runtime } = createOperationSessionCommonRuntime({
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
  const { controls, runtime } = createOperationSessionCommonRuntime({
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
  const { controls, runtime } = createOperationSessionCommonRuntime({
    releaseFailure: { session: 1, value: release },
    closeFailure: { value: new Error('provider close failure') },
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toBe(release)
  expectCleanupOrder(controls, 'release-started:1:reuse')
  expect(controls.closeCount).toBe(1)
})

it('surfaces an undefined close failure instead of silently passing', async () => {
  const { controls, runtime } = createOperationSessionCommonRuntime({
    closeFailure: { value: undefined },
  })

  await expect(runOperationSessionCommonContract(runtime)).rejects.toBeUndefined()
  expectCleanupOrder(controls, 'release-finished:1:reuse')
  expect(controls.closeCount).toBe(1)
})
