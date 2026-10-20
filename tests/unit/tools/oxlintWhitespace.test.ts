import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../../..')
const oxlintBin = resolve(projectRoot, 'node_modules/oxlint/bin/oxlint')
const ruleConfig = resolve(projectRoot, '.oxlintrc.json')

/**
 * Runs the repository whitespace fixes on temporary source and removes the fixture
 * afterward.
 *
 * @param {string} source - Original text used by the scanner or diagnostic.
 *
 * @returns {object} True when the inspected syntax requires this statement
 *   classification.
 */
async function formatWhitespace(source: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'stratom-oxfmt-whitespace-'))
  const fixture = resolve(directory, 'fixture.ts')

  try {
    await writeFile(fixture, source)
    const result = spawnSync(
      process.execPath,
      [
        oxlintBin,
        '--fix',
        '--config',
        ruleConfig,
        '--allow',
        'all',
        '--deny',
        'stratom/whitespace',
        fixture,
      ],
      { encoding: 'utf8' },
    )

    expect(result.status, result.stderr || result.stdout).toBe(0)
    return await readFile(fixture, 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Oxlint whitespace rule', () => {
  it('should put exactly one blank line around multiline blocks', async () => {
    const source = `export function example() {
  prepare()
  if (ready) {
    run()
  }


  finish()
}
`

    await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  prepare()

  if (ready) {
    run()
  }

  finish()
}
`)
  })

  it('should put the blank line before a comment attached to a single-line statement', async () => {
    const source = `export function example() {
  prepare()
  // Run only when ready.
  run()
}
`

    await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  prepare()

  // Run only when ready.
  run()
}
`)
  })
})

describe('Oxlint whitespace rule: keeps consecutive single-line if statements together', () => {
  it('should keep consecutive single-line if statements together', async () => {
    const source = `export function example() {
  if (first) { one() }
  if (second) { two() }
}
`

    await expect(formatWhitespace(source)).resolves.toBe(source)
  })

  it('should separate a comment attached to the next single-line if statement', async () => {
    const source = `export function example() {
  if (first) one()
  // Handle the second case.
  if (second) two()
  finish()
}
`

    await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  if (first) one()

  // Handle the second case.
  if (second) two()

  finish()
}
`)
  })
})

describe('Oxlint whitespace rule: puts exactly one blank line after a single-line if statement', () => {
  it('should put exactly one blank line after a single-line if statement', async () => {
    const source = `export function example(value?: string) {
  prepare()
  if (value) use(value)


  finish()
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(value?: string) {
  prepare()

  if (value) use(value)

  finish()
}
`)
  })
})

describe('Oxlint whitespace rule: pads a single-line if statement written with a block', () => {
  it('should pad a single-line if statement written with a block', async () => {
    const source = `export function example(value?: string) {
  if (value) { use(value) }
  finish()
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(value?: string) {
  if (value) { use(value) }

  finish()
}
`)
  })

  it('should keep consecutive single-line early returns together', async () => {
    const source = `export function example(first?: string, second?: string) {
  if (!first) return
  if (!second) return
  use(first, second)
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(first?: string, second?: string) {
  if (!first) return
  if (!second) return

  use(first, second)
}
`)
  })
})

describe('Oxlint whitespace rule: pads a single-line if statement written with a block: separates a final return from preceding single-line if statements', () => {
  it('should separate a final return from preceding single-line if statements', async () => {
    const source = `export function targetMember(target: Target) {
  if (target.kind === 'column') return target.column
  if (target.kind === 'index') return target.index
  return undefined
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function targetMember(target: Target) {
  if (target.kind === 'column') return target.column
  if (target.kind === 'index') return target.index

  return undefined
}
`)
  })
})

describe('Oxlint whitespace rule: separates a related %s declaration from a single-line if statement', () => {
  it.each([
    ['const', 'const ready = getReady()', 'finish()'],
    ['let', 'let ready = getReady()', 'ready = false\n  finish(ready)'],
  ])(
    'should separate a related %s declaration from a single-line if statement',
    async (_, declaration, followingStatements) => {
      const source = `export function example() {
  ${declaration}
  if (ready) run()
  ${followingStatements}
}
`

      await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  ${declaration}

  if (ready) run()

  ${followingStatements}
}
`)
    },
  )
})

describe('Oxlint whitespace declarations: pads a multiline const', () => {
  it('should put exactly one blank line after a multiline const declaration', async () => {
    const source = `export async function example() {
  const state: State = {
    ready: false,
    failures: [],
  }
  await prepare(state)
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export async function example() {
  const state: State = {
    ready: false,
    failures: [],
  }

  await prepare(state)
}
`)
  })

  it('should not mistake an ASI-protection semicolon for a multiline const', async () => {
    const source = `export function example(connector: Connector) {
  const getInstance = connector.getInstance
  ;(connector as { name: string }).name = 'custom'
}
`

    await expect(formatWhitespace(source)).resolves.toBe(source)
  })

  it('should put the blank line before an ASI-protection semicolon', async () => {
    const source = `export function example(connector: Connector) {
  const result = createResult(
    connector,
  )
  ;(connector as { result: Result }).result = result
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(connector: Connector) {
  const result = createResult(
    connector,
  )

  ;(connector as { result: Result }).result = result
}
`)
  })
})

describe('Oxlint whitespace declarations and calls', () => {
  it('should separate a related declaration from a multiline if statement', async () => {
    const source = `export function example() {
  const request = createRequest()
  if (ready) {
    run(request)
  }
}
`

    await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  const request = createRequest()

  if (ready) {
    run(request)
  }
}
`)
  })

  it('should still separate an unrelated variable declaration from a multiline block', async () => {
    const source = `export function example() {
  const requestId = createRequestId()
  if (ready) {
    run()
  }
  finish(requestId)
}
`

    await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  const requestId = createRequestId()

  if (ready) {
    run()
  }

  finish(requestId)
}
`)
  })
})

describe('Oxlint whitespace declarations and calls: puts exactly one blank line around a multiline function call', () => {
  it('should put exactly one blank line around a multiline function call', async () => {
    const source = `export async function example() {
  prepare()
  await run(
    first,
    second,
  )


  finish()
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export async function example() {
  prepare()

  await run(
    first,
    second,
  )

  finish()
}
`)
  })
})

describe('Oxlint whitespace declarations and calls: keeps a related %s declaration with a multiline function call', () => {
  it.each([
    ['const', 'const request = createRequest()', 'finish(request)'],
    [
      'let',
      'let request = createRequest()',
      'request = updateRequest(request)\n  finish(request)',
    ],
  ])(
    'should keep a related %s declaration with a multiline function call',
    async (_, declaration, followingStatements) => {
      const source = `export function example() {
  ${declaration}
  run(
    request,
    options,
  )
  ${followingStatements}
}
`

      await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  ${declaration}
  run(
    request,
    options,
  )

  ${followingStatements}
}
`)
    },
  )
})

describe('Oxlint whitespace declarations and calls: keeps a related %s declaration with a multiline function call: puts one blank line around a multiline optional call', () => {
  it('should put one blank line around a multiline optional call', async () => {
    const source = `export function example() {
  prepare()
  run?.(
    request,
  )
  finish()
}
`

    await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  prepare()

  run?.(
    request,
  )

  finish()
}
`)
  })
})

describe('Oxlint whitespace declarations and calls: keeps a related %s declaration with a multiline function call: separates an unrelated declaration from a multiline function call', () => {
  it('should separate an unrelated declaration from a multiline function call', async () => {
    const source = `export function example() {
  const requestId = createRequestId()
  run(
    request,
    options,
  )
  finish(requestId)
}
`

    await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  const requestId = createRequestId()

  run(
    request,
    options,
  )

  finish(requestId)
}
`)
  })
})

describe('Oxlint whitespace types and function chains', () => {
  it('should put exactly one blank line around a multiline type alias', async () => {
    const source = `export function example(value: string) {
  const before = value
  type Result = {
    value: string
  }


  const after: Result = { value: before }
  return after
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(value: string) {
  const before = value

  type Result = {
    value: string
  }

  const after: Result = { value: before }
  return after
}
`)
  })
})

describe('Oxlint whitespace types and function chains: puts the leading blank line before a comment on a multiline interface', () => {
  it('should put the leading blank line before a comment on a multiline interface', async () => {
    const source = `export const before = true
// Public result shape.
export interface Result {
  value: string
}
export const after = true
`

    await expect(formatWhitespace(source)).resolves.toBe(`export const before = true

// Public result shape.
export interface Result {
  value: string
}

export const after = true
`)
  })

  it('should not pad a single-line type alias', async () => {
    const source = `export const before = true
export type Result = { value: string }
export const after = true
`

    await expect(formatWhitespace(source)).resolves.toBe(source)
  })
})

describe('Oxlint whitespace types and function chains: puts exactly one blank line between multiline function chains', () => {
  it('should put exactly one blank line between multiline function chains', async () => {
    const source = `export function example(request: Request) {
  const absentRelations = request.absentRelations
    .map(resolveRelation)
    .filter(isAbsent)
    .sort(compareRelations)
  const completeNamespaces = request.completeNamespaces
    .map(resolveNamespace)
    .filter(isComplete)
    .sort(compareNamespaces)
  return { absentRelations, completeNamespaces }
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(request: Request) {
  const absentRelations = request.absentRelations
    .map(resolveRelation)
    .filter(isAbsent)
    .sort(compareRelations)

  const completeNamespaces = request.completeNamespaces
    .map(resolveNamespace)
    .filter(isComplete)
    .sort(compareNamespaces)

  return { absentRelations, completeNamespaces }
}
`)
  })
})

describe('Oxlint whitespace types and function chains: handles multiline call initializers', () => {
  it('should still pad a multiline const with a call initializer', async () => {
    const source = `export function example(value: string) {
  const result = createResult(
    value,
  )
  return result
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(value: string) {
  const result = createResult(
    value,
  )

  return result
}
`)
  })

  it('should not treat an object property as a declaration use', async () => {
    const source = `export function example() {
  const request = createRequest()
  run(
    { request: otherRequest },
  )
  finish(request)
}
`

    await expect(formatWhitespace(source)).resolves.toBe(`export function example() {
  const request = createRequest()

  run(
    { request: otherRequest },
  )

  finish(request)
}
`)
  })
})
