import { describe, expect, it } from 'vitest'

import {
  registerDialectIntegrationScenario,
  shouldRegisterDialectIntegrationScenario,
  validateDialectIntegrationCapabilities,
} from '../../integration/support/dialectIntegrationContract'
import type { DialectIntegrationAdapter } from '../../integration/support/dialectIntegrationContract'

import type { DialectContractMemberCapabilities } from './dialectContractKit'
import { registerDialectContractMember } from './dialectContractKit'
import { postgresSemanticContractShard } from './postgresSharedShards'
import { sqliteSemanticContractShard } from './sqliteSharedShards'

it('should preflight nested controlled migration support before registering any suite', () => {
  const unsupported = {
    state: 'unsupported',
    reason: 'Not applicable to this adapter',
  } as const

  const capabilities = {
    identity: { ...unsupported, shard: 'complete' },
    naming: { ...unsupported, shard: 'complete' },
    desiredSchema: { ...unsupported, shard: 'complete' },
    query: { ...unsupported, shard: 'complete' },
    catalog: { ...unsupported, shard: 'complete' },
    operationSession: { state: 'supported', shard: 'complete' },
    coordination: { ...unsupported, shard: 'complete' },
    migration: { ...unsupported, shard: 'complete' },
    lifecycle: { ...unsupported, shard: 'complete' },
  } as const

  expect(() =>
    registerDialectContractMember('malformed provider', capabilities, {
      complete: {
        identity: unsupported,
        naming: unsupported,
        desiredSchema: unsupported,
        query: unsupported,
        catalog: unsupported,
        operationSession: {
          state: 'supported',
          common: unsupported,
          controlled: {
            state: 'supported',
            input: { createProvider: () => ({}), migration: undefined },
          },
        },
        coordination: unsupported,
        migration: unsupported,
        lifecycle: unsupported,
      },
    } as never),
  ).toThrow(/explicit migration participation/i)
})

function registerMalformedMigration(migrationInput: unknown): void {
  const unsupported = {
    state: 'unsupported',
    reason: 'Not applicable to this adapter',
  } as const

  const capabilities = {
    identity: { ...unsupported, shard: 'complete' },
    naming: { ...unsupported, shard: 'complete' },
    desiredSchema: { ...unsupported, shard: 'complete' },
    query: { ...unsupported, shard: 'complete' },
    catalog: { ...unsupported, shard: 'complete' },
    operationSession: {
      state: 'unsupported',
      reason: unsupported.reason,
      shard: 'complete',
    },
    coordination: { ...unsupported, shard: 'complete' },
    migration: { state: 'supported', shard: 'complete' },
    lifecycle: { ...unsupported, shard: 'complete' },
  } as const

  registerDialectContractMember('malformed migration', capabilities, {
    complete: {
      identity: unsupported,
      naming: unsupported,
      desiredSchema: unsupported,
      query: unsupported,
      catalog: unsupported,
      operationSession: unsupported,
      coordination: unsupported,
      migration: { state: 'supported', input: migrationInput },
      lifecycle: unsupported,
    },
  } as never)
}

it.each([
  [
    'missing unsupportedLowering',
    { lowering: { createCase: () => ({}) } },
    /unsupportedLowering declaration/i,
  ],
  [
    'missing lowering createCase',
    {
      lowering: {},
      unsupportedLowering: { state: 'unsupported', reason: 'adapter limitation' },
    },
    /lowering createCase factory/i,
  ],
  [
    'missing supported unsupportedLowering createCase',
    {
      lowering: { createCase: () => ({}) },
      unsupportedLowering: { state: 'supported', input: {} },
    },
    /unsupportedLowering declaration/i,
  ],
  [
    'blank unsupported reason',
    {
      lowering: { createCase: () => ({}) },
      unsupportedLowering: { state: 'unsupported', reason: ' ' },
    },
    /non-empty reason/i,
  ],
  [
    'invalid unsupportedLowering state',
    { lowering: { createCase: () => ({}) }, unsupportedLowering: { state: 'other' } },
    /invalid state/i,
  ],
] as const)(
  'should preflight malformed migration lowering: %s',
  (_name, input, message) => {
    expect(() => registerMalformedMigration(input)).toThrow(message)
  },
)

function registerMalformedQuery(query: unknown): void {
  const unsupported = {
    state: 'unsupported',
    reason: 'Not applicable to this adapter',
  } as const

  const capabilities = {
    identity: { ...unsupported, shard: 'complete' },
    naming: { ...unsupported, shard: 'complete' },
    desiredSchema: { ...unsupported, shard: 'complete' },
    query: { state: 'supported', shard: 'complete' },
    catalog: { ...unsupported, shard: 'complete' },
    operationSession: { ...unsupported, shard: 'complete' },
    coordination: { ...unsupported, shard: 'complete' },
    migration: { ...unsupported, shard: 'complete' },
    lifecycle: { ...unsupported, shard: 'complete' },
  } as const

  registerDialectContractMember('malformed query', capabilities, {
    complete: {
      identity: unsupported,
      naming: unsupported,
      desiredSchema: unsupported,
      query,
      catalog: unsupported,
      operationSession: unsupported,
      coordination: unsupported,
      migration: unsupported,
      lifecycle: unsupported,
    },
  } as never)
}

it('should preflight a missing required compiler scenario before registering suites', () => {
  const scenarios = { ...postgresSemanticContractShard.query.scenarios }
  delete (scenarios as Record<string, unknown>)['select.join.right']

  expect(() =>
    registerMalformedQuery({ ...postgresSemanticContractShard.query, scenarios }),
  ).toThrow(/omits required scenario select\.join\.right/i)
})

it('should preflight unsupported compiler scenarios without a reason before registering suites', () => {
  const scenarios = {
    ...sqliteSemanticContractShard.query.scenarios,
    'select.join.right': {
      support: {
        ...sqliteSemanticContractShard.query.scenarios['select.join.right'].support,
        reason: ' ',
      },
    },
  }

  expect(() =>
    registerMalformedQuery({ ...sqliteSemanticContractShard.query, scenarios }),
  ).toThrow(/scenario select\.join\.right needs a non-empty unsupported reason/i)
})

describe('Dialect contract capability registration', () => {
  it('should reject an omitted applicable unit-contract facet', () => {
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
})

describe('Dialect contract capability registration: rejects a supported shard whose lifecycle input is omitted', () => {
  it('should reject a supported shard whose lifecycle input is omitted', () => {
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
})

describe('Dialect contract capability registration: rejects an omitted declared shard', () => {
  it('should reject an omitted declared shard', () => {
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
})

describe('Dialect contract capability registration: rejects a supported %s composite when the manifest declares it unsupported', () => {
  it.each(['query', 'operationSession'] as const)(
    'should reject a supported %s composite when the manifest declares it unsupported',
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

      assertUnsupportedCapabilityRegistration(
        capabilities,
        unsupportedInput,
        facet,
        supportedComposite,
      )
    },
  )
})

describe('Dialect contract capability registration: rejects a supported %s composite when the manifest declares it unsupported: rejects blank unsupported integration capability reasons', () => {
  it('should reject blank unsupported integration capability reasons', () => {
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
})

describe('Dialect contract capability registration: does not register a scenario requiring an unsupported integration capability', () => {
  it('should not register a scenario requiring an unsupported integration capability', () => {
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

  it('should register supported scenarios through the actual integration registration seam', () => {
    const registered: string[] = []
    const adapter = {
      capabilities: {
        lifecycle: { state: 'supported' },
        query: { state: 'supported' },
        transaction: { state: 'supported' },
        migration: { state: 'supported' },
        convergence: { state: 'supported' },
      },
    } satisfies Pick<DialectIntegrationAdapter, 'capabilities'>

    registerDialectIntegrationScenario(
      adapter,
      ['query', 'migration'],
      'should run a supported scenario',
      async () => undefined,
      (title) => registered.push(title),
    )

    expect(registered).toEqual(['should run a supported scenario'])
  })
})

describe('Dialect contract capability registration: does not register a scenario requiring an unsupported integration capability: does not register unsupported scenarios through the actual integration seam', () => {
  it('should not register unsupported scenarios through the actual integration seam', () => {
    const registered: string[] = []
    const adapter = {
      capabilities: {
        lifecycle: { state: 'supported' },
        query: { state: 'unsupported', reason: 'No query transport' },
        transaction: { state: 'supported' },
        migration: { state: 'supported' },
        convergence: { state: 'supported' },
      },
    } satisfies Pick<DialectIntegrationAdapter, 'capabilities'>

    registerDialectIntegrationScenario(
      adapter,
      ['query', 'migration'],
      'should run an unsupported scenario',
      async () => undefined,
      (title) => registered.push(title),
    )

    expect(registered).toEqual([])
  })
})

/**
 * Checks unsupported capability registration in the current test scenario.
 *
 * @param capabilities - Explicit supported, unsupported, or unavailable evidence for each
 *   contract capability.
 * @param unsupportedInput - Input used to verify explicit unsupported-capability
 *   behavior.
 * @param facet - Dialect facet whose capability or invocation is inspected.
 * @param supportedComposite - Composite fixture capabilities expected to remain
 *   supported.
 */
function assertUnsupportedCapabilityRegistration(
  capabilities: DialectContractMemberCapabilities,
  unsupportedInput: { state: 'unsupported'; reason: string },
  facet: 'query' | 'operationSession',
  supportedComposite: unknown,
) {
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
    }),
  ).toThrow(new RegExp(`shard complete disagrees about ${facet}`, 'i'))
}
