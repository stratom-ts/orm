import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import dts from 'vite-plugin-dts'
import { defineConfig } from 'vitest/config'

const require = createRequire(import.meta.url)
const typescript6Package = require.resolve('@typescript/typescript6/package.json')
const typescript6CompilerFolder = dirname(
  createRequire(typescript6Package).resolve('@typescript/old/package.json'),
)

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*.ts'],
      bundleTypes: {
        invokeOptions: {
          typescriptCompilerFolder: typescript6CompilerFolder,
        },
      },
      outDirs: ['dist', { dir: 'dist', moduleFormat: 'cjs' }],
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['dotenv/config'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/index.ts',
        'src/ddl/index.ts',
        'src/dialects/index.ts',
        'src/query/index.ts',
        'src/schemas/index.ts',
        'src/schemas/actions/index.ts',
        'src/schemas/utils/index.ts',
        'src/types/index.ts',
        'src/utils/index.ts',
        'src/dialects/types.ts',
        'src/query/ast.ts',
        'src/schemas/tableSchema.ts',
        'src/schemas/actions/types.ts',
        'src/types/constraints.ts',
        'src/types/equals.ts',
        'src/types/prettify.ts',
        'src/types/schema.ts',
        'src/types/views.ts',
      ],
      thresholds: {
        statements: 91.43,
        branches: 84.42,
        functions: 96.95,
        lines: 92.81,
        'src/{client.ts,defineTable.ts,schemas/**}': {
          statements: 92.26,
          branches: 90.24,
          functions: 93.54,
          lines: 93.47,
        },
        'src/query/**': {
          statements: 87.35,
          branches: 79.69,
          functions: 93.58,
          lines: 89.24,
        },
        'src/{ddl/**,migrations/**}': {
          statements: 94.52,
          branches: 82.96,
          functions: 99.54,
          lines: 95.92,
        },
        'src/dialects/resolve.ts': {
          statements: 100,
          branches: 91.66,
          functions: 100,
          lines: 100,
        },
        'src/operations/**': {
          statements: 93.49,
          branches: 86.4,
          functions: 100,
          lines: 95.61,
        },
        'src/dialects/postgres/**': {
          statements: 90.51,
          branches: 84.56,
          functions: 97.37,
          lines: 91.7,
        },
      },
    },
  },
  resolve: {
    alias: [{ find: /^@\/(.*)/, replacement: resolve(import.meta.dirname, 'src/$1') }],
  },
  build: {
    lib: {
      entry: ['src/index.ts'],
      name: 'Stratom',
      fileName: 'stratom',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['valibot', 'db0', 'node:async_hooks', 'node:crypto'],
      output: {
        globals: {
          valibot: 'valibot',
          db0: 'db0',
          'node:async_hooks': 'async_hooks',
          'node:crypto': 'crypto',
        },
      },
    },
  },
})
