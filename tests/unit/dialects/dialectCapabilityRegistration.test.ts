import { describe, expect, it } from 'vitest'

import {
  shouldRegisterDialectIntegrationScenario,
  validateDialectIntegrationCapabilities,
} from '../../integration/support/dialectIntegrationContract'

import { registerDialectContractMember } from './dialectContractKit'

describe('Dialect contract capability registration', () => {
  it('rejects an omitted applicable unit-contract facet', () => {
    expect(() =>
      registerDialectContractMember(
        'incomplete member',
        {
          identity: { state: 'supported', shard: 'complete' },
          naming: { state: 'supported', shard: 'complete' },
          desiredSchema: { state: 'supported', shard: 'complete' },
          query: { state: 'supported', shard: 'complete' },
          catalog: { state: 'supported', shard: 'complete' },
          operationSession: { state: 'supported', shard: 'complete' },
          coordination: { state: 'supported', shard: 'complete' },
          migration: { state: 'supported', shard: 'complete' },
        } as never,
        {} as never,
      ),
    ).toThrow(/omits lifecycle/i)
  })

  it('rejects a supported shard whose lifecycle input is omitted', () => {
    const capabilities = {
      identity: { state: 'supported', shard: 'complete' },
      naming: { state: 'supported', shard: 'complete' },
      desiredSchema: { state: 'supported', shard: 'complete' },
      query: { state: 'supported', shard: 'complete' },
      catalog: { state: 'supported', shard: 'complete' },
      operationSession: { state: 'supported', shard: 'complete' },
      coordination: { state: 'supported', shard: 'complete' },
      migration: { state: 'supported', shard: 'complete' },
      lifecycle: { state: 'supported', shard: 'complete' },
    } as const

    expect(() =>
      registerDialectContractMember('incomplete lifecycle member', capabilities, {
        complete: {
          identity: {},
          naming: {},
          desiredSchema: {},
          query: {},
          catalog: {},
          operationSession: {},
          coordination: {},
          migration: {},
        },
      } as never),
    ).toThrow(/complete.*omits.*lifecycle input/i)
  })

  it('rejects an omitted declared shard', () => {
    const capabilities = {
      identity: { state: 'supported', shard: 'semantic' },
      naming: { state: 'supported', shard: 'semantic' },
      desiredSchema: { state: 'supported', shard: 'semantic' },
      query: { state: 'supported', shard: 'semantic' },
      catalog: { state: 'supported', shard: 'semantic' },
      operationSession: { state: 'supported', shard: 'operation-session' },
      coordination: { state: 'supported', shard: 'coordination' },
      migration: { state: 'supported', shard: 'semantic' },
      lifecycle: { state: 'supported', shard: 'semantic' },
    } as const
    expect(() =>
      registerDialectContractMember('incomplete member', capabilities, {
        semantic: {},
        'operation-session': {},
      } as never),
    ).toThrow(/omits declared shard coordination/i)
  })

  it.each(['query', 'operationSession'] as const)(
    'rejects a supported %s composite when the manifest declares it unsupported',
    (facet) => {
      const unsupportedCapability = {
        state: 'unsupported',
        reason: 'Not supported by this fixture',
        shard: 'complete',
      } as const
      const unsupportedInput = {
        state: 'unsupported',
        reason: 'Not supported by this fixture',
      } as const
      const capabilities = {
        identity: unsupportedCapability,
        naming: unsupportedCapability,
        desiredSchema: unsupportedCapability,
        query: unsupportedCapability,
        catalog: unsupportedCapability,
        operationSession: unsupportedCapability,
        coordination: unsupportedCapability,
        migration: unsupportedCapability,
        lifecycle: unsupportedCapability,
      }
      const supportedComposite =
        facet === 'query'
          ? {
              state: 'supported',
              core: unsupportedInput,
              scenarios: {},
              valueMapping: unsupportedInput,
            }
          : {
              state: 'supported',
              common: unsupportedInput,
              controlled: unsupportedInput,
            }

      expect(() =>
        registerDialectContractMember('mismatched member', capabilities, {
          complete: {
            identity: unsupportedInput,
            naming: unsupportedInput,
            desiredSchema: unsupportedInput,
            query: unsupportedInput,
            catalog: unsupportedInput,
            operationSession: unsupportedInput,
            coordination: unsupportedInput,
            migration: unsupportedInput,
            lifecycle: unsupportedInput,
            [facet]: supportedComposite,
          },
        } as never),
      ).toThrow(new RegExp(`shard complete disagrees about ${facet}`, 'i'))
    },
  )

  it('rejects blank unsupported integration capability reasons', () => {
    expect(() =>
      validateDialectIntegrationCapabilities({
        lifecycle: { state: 'supported' },
        query: { state: 'supported' },
        transaction: { state: 'unsupported', reason: '   ' },
        migration: { state: 'supported' },
        convergence: { state: 'supported' },
      }),
    ).toThrow(/transaction.*non-empty/i)
  })

  it('does not register a scenario requiring an unsupported integration capability', () => {
    expect(
      shouldRegisterDialectIntegrationScenario(
        {
          lifecycle: { state: 'supported' },
          query: { state: 'unsupported', reason: 'The fixture has no query transport' },
          transaction: { state: 'supported' },
          migration: { state: 'supported' },
          convergence: { state: 'supported' },
        },
        ['query', 'migration'],
      ),
    ).toBe(false)
  })
})
