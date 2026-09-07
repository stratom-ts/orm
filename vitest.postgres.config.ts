import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vite.config.ts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['tests/integration/postgres.test.ts'],
      setupFiles: ['tests/integration/postgres.setup.ts'],
      fileParallelism: true,
    },
  }),
)
