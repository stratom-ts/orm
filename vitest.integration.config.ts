import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vite.config.ts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['tests/integration/**/*.test.ts'],
      globalSetup: ['tests/integration/support/buildPackage.ts'],
      testTimeout: 45_000,
      hookTimeout: 40_000,
    },
  }),
)
