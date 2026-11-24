import ts from '@typescript/typescript6'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))

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
