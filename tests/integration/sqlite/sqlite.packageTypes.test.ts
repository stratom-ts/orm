import ts from '@typescript/typescript6'
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(import.meta.url)
const compiler = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc')

it('should typecheck schema tables against the published root declarations', async () => {
  const directory = await mkdtemp(join(root, '.schema-consumer-'))
  try {
    const consumer = join(directory, 'consumer.mts')
    await copyFile(
      new URL('./fixtures/schema-consumer.ts.txt', import.meta.url),
      consumer,
    )

    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      compiler,
      '--ignoreConfig',
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--target',
      'ES2022',
      consumer,
    ])

    expect(stdout).toBe('')
    expect(stderr).toBe('')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('should expose every declared schema value at runtime', async () => {
  const program = ts.createProgram([join(root, 'dist/schema.d.ts')], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
  })

  const source = program.getSourceFile(join(root, 'dist/schema.d.ts'))

  if (!source) throw new Error('Missing schema declaration source')

  const checker = program.getTypeChecker()
  const symbol = checker.getSymbolAtLocation(source)

  if (!symbol) throw new Error('Missing schema declaration exports')

  const values = checker
    .getExportsOfModule(symbol)
    .filter((exported) => {
      const target =
        exported.flags & ts.SymbolFlags.Alias
          ? checker.getAliasedSymbol(exported)
          : exported

      return Boolean(target.flags & ts.SymbolFlags.Value)
    })
    .map((exported) => exported.name)
    .sort()

  const subpath = '@stratom/orm/schema'
  const runtime: unknown = await import(subpath)

  if (typeof runtime !== 'object' || runtime === null)
    throw new Error('Missing schema runtime exports')

  expect(Object.keys(runtime).sort()).toEqual(values)
})
