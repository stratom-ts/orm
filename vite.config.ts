import { resolve } from 'path'
import dts from 'vite-plugin-dts'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    dts({
      include: ['src/**/*.ts'],
      bundleTypes: true,
      outDirs: ['dist', { dir: 'dist', moduleFormat: 'cjs' }],
    }),
  ],
  test: {
    globals: true,
    environment: 'node',
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
        statements: 88,
        branches: 80,
        functions: 95,
        lines: 90,
      },
    },
  },
  resolve: {
    alias: [{ find: /^@\/(.*)/, replacement: resolve(__dirname, 'src/$1') }],
  },
  build: {
    lib: {
      entry: ['src/index.ts'],
      name: 'Stratom',
      fileName: 'stratom',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['valibot', 'db0', 'node:async_hooks'],
      output: {
        globals: {
          valibot: 'valibot',
          db0: 'db0',
          'node:async_hooks': 'async_hooks',
        },
      },
    },
  },
})
