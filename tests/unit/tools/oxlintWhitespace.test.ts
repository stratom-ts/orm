import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../../..')
const oxlintBin = resolve(projectRoot, 'node_modules/oxlint/bin/oxlint')
const ruleConfig = resolve(projectRoot, '.oxlintrc.json')

async function formatWhitespace(source: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), 'stratom-oxfmt-whitespace-'))
  const fixture = resolve(directory, 'fixture.ts')

  try {
    await writeFile(fixture, source)
    const result = spawnSync(
      process.execPath,
      [oxlintBin, '--fix', '--config', ruleConfig, fixture],
      { encoding: 'utf8' },
    )

    expect(result.status, result.stderr || result.stdout).toBe(0)
    return await readFile(fixture, 'utf8')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe('Oxlint whitespace rule', () => {
  it('puts exactly one blank line around multiline blocks', async () => {
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

  it('puts the blank line before a comment attached to a single-line statement', async () => {
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

  it('does not separate adjacent single-line blocks without a comment', async () => {
    const source = `export function example() {
  if (first) { one() }
  if (second) { two() }
}
`

    await expect(formatWhitespace(source)).resolves.toBe(source)
  })

  it('puts exactly one blank line after a single-line early return', async () => {
    const source = `export function example(value?: string) {
  if (!value) return


  use(value)
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(value?: string) {
  if (!value) return

  use(value)
}
`)
  })

  it('pads an early return written as a single-line block', async () => {
    const source = `export function example(value?: string) {
  if (!value) { return }
  use(value)
}
`

    await expect(formatWhitespace(source)).resolves
      .toBe(`export function example(value?: string) {
  if (!value) { return }

  use(value)
}
`)
  })

  it('keeps consecutive single-line early returns together', async () => {
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

  it('keeps a final unconditional return with preceding early returns', async () => {
    const source = `export function targetMember(target: Target) {
  if (target.kind === 'column') return target.column
  if (target.kind === 'index') return target.index
  return undefined
}
`

    await expect(formatWhitespace(source)).resolves.toBe(source)
  })

  it('keeps a related variable declaration with the multiline block that consumes it', async () => {
    const source = `export function example() {
  const request = createRequest()
  if (ready) {
    run(request)
  }
}
`

    await expect(formatWhitespace(source)).resolves.toBe(source)
  })

  it('still separates an unrelated variable declaration from a multiline block', async () => {
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

  it('puts exactly one blank line around a multiline function call', async () => {
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

  it.each([
    ['const', 'const request = createRequest()', 'finish(request)'],
    [
      'let',
      'let request = createRequest()',
      'request = updateRequest(request)\n  finish(request)',
    ],
  ])(
    'keeps a related %s declaration with a multiline function call',
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

  it('puts one blank line around a multiline optional call', async () => {
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

  it('separates an unrelated declaration from a multiline function call', async () => {
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

  it('does not treat an object property as a declaration use', async () => {
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
