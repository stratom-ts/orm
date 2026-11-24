import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { build } from 'vite'
import { expect, it } from 'vitest'

const require = createRequire(import.meta.url)

/** Defines the shared application module and its browser consumer. */
function browserModules(consumeTable: boolean): Record<string, string> {
  return {
    'schema-client-entry': `
        import { parse } from 'valibot'
        import { formSchema, patchSchema, requiredSchema${consumeTable ? ', Related' : ''} } from 'shared-schema'
        globalThis.result = {
          form: parse(formSchema, { name: 'Example' }),
          patch: parse(patchSchema, {}),
          required: parse(requiredSchema, { name: 'Required' }),
          ${consumeTable ? "table: parse(Related.getSchema(), { id: 'child', exampleId: 'parent', lazyId: 'parent' })," : ''}
        }
      `,
    'shared-schema': `
        import { object, string, pick, partial, required, pipe } from 'valibot'
        import { defineTable, column, reference } from '@stratom/orm'
        export const schema = object({ id: string(), name: string() })
        export const formSchema = pick(schema, ['name'])
        export const patchSchema = partial(formSchema)
        export const requiredSchema = required(patchSchema)
        export const Table = defineTable('examples', schema.entries, { primaryKey: 'id' })
        export const Related = defineTable('related', {
          id: pipe(string(), column({ unique: true })),
          exampleId: reference(Table, 'id'),
          lazyId: reference(string(), () => Table, 'id'),
        }, { primaryKey: 'id' })
      `,
  }
}

it.each([false, true])(
  'should evaluate shared validators in a browser (consume table: %s)',
  async (consumeTable) => {
    const modules = browserModules(consumeTable)

    const result = await build({
      configFile: false,
      mode: 'production',
      logLevel: 'silent',
      plugins: [
        {
          name: 'shared-schema-browser',
          resolveId(id) {
            if (id in modules) return `\0${id}`

            // Resolve package exports to dist, just as an installed consumer does.
            if (id === 'valibot' || id === '@stratom/orm') return require.resolve(id)
          },
          load(id) {
            return modules[id.slice(1)]
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: 'schema-client-entry',
          output: { format: 'iife', name: 'SharedSchemaClient' },
        },
      },
    })

    if (Array.isArray(result) || !('output' in result)) {
      throw new Error('Expected one browser bundle')
    }

    const chunk = result.output.find(
      (output) => output.type === 'chunk' && output.isEntry,
    )

    if (chunk?.type !== 'chunk') throw new Error('Expected a browser entry')

    const browserGlobal = { TextEncoder, TextDecoder, URL, URLSearchParams, result: {} }
    runInNewContext(chunk.code, browserGlobal)

    expect(browserGlobal.result).toEqual({
      form: { name: 'Example' },
      patch: {},
      required: { name: 'Required' },
      ...(consumeTable
        ? { table: { id: 'child', exampleId: 'parent', lazyId: 'parent' } }
        : {}),
    })

    // Server async contexts and catalog introspection SQL must shake out.
    expect(chunk.code).not.toMatch(/AsyncLocalStorage|pg_catalog|sqlite_schema/)
  },
)
