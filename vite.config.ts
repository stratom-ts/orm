import { resolve } from 'path'
import dts from 'vite-plugin-dts'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [dts({ include: ['src/**/*.ts'] })],
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: [{ find: /^@\/(.*)/, replacement: resolve(__dirname, 'src/$1') }],
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'SchemaORM',
      fileName: 'schema-orm',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['valibot', 'db0'],
      output: {
        globals: {
          valibot: 'valibot',
          db0: 'db0',
        },
      },
    },
  },
})
