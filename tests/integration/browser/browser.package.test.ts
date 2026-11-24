import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { build, createLogger, createServer } from 'vite'
import type { Plugin } from 'vite'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const fixtures = 'tests/integration/browser/fixtures'
const execute = promisify(execFile)
const expectedAuthoring = {
  name: 'Example',
  table: true,
  related: true,
  unique: true,
  reference: 'id',
  lazyId: 'parent',
}

/** Records dependency resolution even when the consumer can remove the import later. */
function browserBoundary(resolved: string[]): Plugin {
  return {
    name: 'assert-browser-package-boundary',
    enforce: 'pre',
    resolveId(id) {
      if (
        id.startsWith('node:') ||
        builtinModules.includes(id) ||
        id === 'db0' ||
        id.startsWith('db0/')
      ) {
        resolved.push(id)
      }
    },
  }
}

it.each(['validator', 'authoring'])(
  'should evaluate the %s production consumer without Node dependencies or warnings',
  async (consumer) => {
    const resolved: string[] = []
    const warnings: string[] = []
    const result = await build({
      root,
      configFile: false,
      plugins: [browserBoundary(resolved)],
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: `${fixtures}/${consumer}-client.js`,
          onwarn(warning) {
            warnings.push(warning.message)
          },
          output: { format: 'iife', name: 'SharedSchemaClient' },
        },
      },
    })

    if (Array.isArray(result) || !('output' in result))
      throw new Error('Expected one browser build')

    const chunk = result.output.find(
      (output) => output.type === 'chunk' && output.isEntry,
    )

    if (chunk?.type !== 'chunk') throw new Error('Missing browser entry')

    const browser = { TextEncoder, TextDecoder, URL, URLSearchParams, result: undefined }
    runInNewContext(chunk.code, browser)

    expect(browser.result).toEqual(
      consumer === 'validator' ? { name: 'Example' } : expectedAuthoring,
    )

    expect(resolved).toEqual([])
    expect(warnings).toEqual([])
  },
)

it('should optimize and evaluate the authoring dependency graph in Vite development mode', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'stratom-vite-'))
  const resolved: string[] = []
  const warnings: string[] = []
  const logger = createLogger('silent')
  logger.warn = (message) => {
    warnings.push(message)
  }

  const server = await createServer({
    root,
    configFile: false,
    cacheDir,
    customLogger: logger,
    plugins: [browserBoundary(resolved)],
    server: { host: '127.0.0.1', port: 0 },
    optimizeDeps: {
      include: ['@stratom/orm/schema', 'valibot'],
      entries: [`${fixtures}/authoring-client.js`],
    },
  })

  try {
    await server.listen()
    const address = server.httpServer?.address()

    if (!address || typeof address === 'string')
      throw new Error('Missing dev server address')

    const { stdout } = await execute(process.execPath, [
      '--experimental-vm-modules',
      fileURLToPath(new URL('./evaluateDev.mjs', import.meta.url)),
      `http://127.0.0.1:${address.port}/${fixtures}/authoring-client.js`,
    ])

    const evaluation = JSON.parse(stdout) as { result: unknown; modules: string[] }
    expect(evaluation.result).toEqual(expectedAuthoring)

    expect(evaluation.modules).toEqual(
      expect.arrayContaining([
        expect.stringContaining('/deps/@stratom_orm_schema.js'),
        expect.stringContaining('/deps/valibot.js'),
      ]),
    )

    expect(resolved).toEqual([])
    expect(warnings).toEqual([])
  } finally {
    await server.close()
    await rm(cacheDir, { recursive: true, force: true })
  }
})
