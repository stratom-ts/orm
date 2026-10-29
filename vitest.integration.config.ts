import { defineConfig, mergeConfig } from 'vitest/config'

import baseConfig from './vite.config.ts'

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      include: ['tests/integration/**/*.test.ts'],
      globalSetup: ['tests/integration/support/buildPackage.ts'],
      // Early node:sqlite retains closed file handles until statements are collected.
      execArgv: process.platform === 'win32' ? ['--expose-gc'] : [],
      testTimeout: 45_000,
      hookTimeout: 40_000,
    },
  }),
)
