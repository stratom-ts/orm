import assert from 'node:assert/strict'
import { SourceTextModule, createContext } from 'node:vm'

const context = createContext({ TextEncoder, TextDecoder, URL, URLSearchParams })

/** @type {Map<string, SourceTextModule>} */
const modules = new Map()

/**
 * Loads Vite's browser modules into an isolated context without Node globals.
 *
 * @param {string} url - URL served by the Vite development server.
 *
 * @returns {Promise<SourceTextModule>} The cached or fetched browser module.
 */
async function load(url) {
  const cached = modules.get(url)

  if (cached) return cached

  const response = await fetch(url)
  assert.equal(response.status, 200, url)
  const module = new SourceTextModule(await response.text(), {
    context,
    identifier: url,
    initializeImportMeta(meta) {
      meta.url = url
    },
  })

  modules.set(url, module)
  return module
}

const entry = await load(process.argv[2])
await entry.link((specifier, parent) => load(new URL(specifier, parent.identifier).href))
await entry.evaluate()

/** @type {unknown} */
const result = context.result

process.stdout.write(JSON.stringify({ result, modules: [...modules.keys()] }))
