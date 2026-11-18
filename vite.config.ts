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
      },
    },
  },
  resolve: {
    alias: [{ find: /^@\/(.*)/, replacement: resolve(import.meta.dirname, 'src/$1') }],
  },
  build: {
    lib: {
      entry: { index: 'src/index.ts', naming: 'src/naming.ts' },
      fileName: (_format, entryName) =>
        `${entryName === 'index' ? 'stratom' : entryName}.js`,
      formats: ['es'],
    },
    rollupOptions: {
      external: [
        'valibot',
        'db0',
        'node:async_hooks',
        'node:crypto',
        'node:fs',
        'node:util',
      ],
    },
  },
})
