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
        statements: 91,
        branches: 84,
        functions: 96,
        lines: 92,
        'src/{client.ts,defineTable.ts,schemas/**/*.ts}': {
          statements: 92,
          branches: 90,
          functions: 93,
          lines: 93,
        },
        'src/query/**/*.ts': {
          statements: 87,
          branches: 79,
          functions: 93,
          lines: 89,
        },
        'src/{ddl,migrations}/**/*.ts': {
          statements: 94,
          branches: 82,
          functions: 99,
          lines: 95,
        },
        'src/dialects/{catalog,resolve}.ts': {
          statements: 100,
          branches: 91,
          functions: 100,
          lines: 100,
        },
        'src/operations/**/*.ts': {
          statements: 93,
          branches: 86,
          functions: 100,
          lines: 95,
        },
        'src/dialects/postgres/**/*.ts': {
          statements: 90,
          branches: 84,
          functions: 97,
          lines: 91,
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
