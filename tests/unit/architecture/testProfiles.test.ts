import type { UserConfig } from 'vite'
import { describe, expect, it } from 'vitest'

import packageJson from '../../../package.json'
import baseConfig from '../../../vite.config.ts'
import coverageConfig from '../../../vitest.coverage.config.ts'
import integrationConfig from '../../../vitest.integration.config.ts'
import unitConfig from '../../../vitest.unit.config.ts'

const [unitProfile, integrationProfile, coverageProfile]: UserConfig[] = [
  unitConfig,
  integrationConfig,
  coverageConfig,
]

describe('Vitest profiles', () => {
  it('should register one package build for combined coverage and preserve profile boundaries', () => {
    expect(packageJson.scripts['test:coverage']).toContain(
      '--config vitest.coverage.config.ts',
    )

    expect(packageJson.scripts['test:coverage']).toContain('--coverage')

    expect(unitProfile.test?.include).toEqual(['tests/unit/**/*.test.ts'])
    expect(integrationProfile.test?.include).toEqual(['tests/integration/**/*.test.ts'])
    expect(unitProfile.test?.globalSetup).toBeUndefined()

    expect(integrationProfile.test?.globalSetup).toEqual([
      'tests/integration/support/buildPackage.ts',
    ])

    expect(coverageProfile.test?.include).toEqual([
      'tests/integration/**/*.test.ts',
      'tests/unit/**/*.test.ts',
    ])

    expect(coverageProfile.test?.globalSetup).toEqual([
      'tests/integration/support/buildPackage.ts',
    ])

    expect(coverageProfile.test?.testTimeout).toBe(45_000)
    expect(coverageProfile.test?.hookTimeout).toBe(40_000)

    expect(coverageProfile.test?.coverage?.thresholds).toEqual(
      baseConfig.test?.coverage?.thresholds,
    )
  })
})
