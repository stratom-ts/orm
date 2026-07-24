import { resolve } from 'path'
import dts from 'vite-plugin-dts'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [dts()],
  test: {
    globals: true,
    environment: 'node',
  },
  resolve: {
    alias: [
      { find: /^@helpers\/(.*)/, replacement: resolve(__dirname, 'src/helpers/$1') },
      { find: /^@schemas\/(.*)/, replacement: resolve(__dirname, 'src/schemas/$1') },
      { find: /^@typings\/(.*)/, replacement: resolve(__dirname, 'src/types/$1') },
      { find: /^@utils\/(.*)/, replacement: resolve(__dirname, 'src/utils/$1') },
    ],
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'SchemaORM',
      fileName: 'schema-orm',
      formats: ['es', 'umd'],
    },
    rollupOptions: {
      external: ['valibot', 'kysely'],
      output: {
        globals: {
          valibot: 'valibot',
          kysely: 'kysely',
        },
      },
    },
  },
})
