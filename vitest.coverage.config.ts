import { defineConfig, mergeConfig } from 'vitest/config'

import integrationConfig from './vitest.integration.config.ts'

export default mergeConfig(
  integrationConfig,
  defineConfig({
    test: {
      include: ['tests/unit/**/*.test.ts'],
    },
  }),
)
