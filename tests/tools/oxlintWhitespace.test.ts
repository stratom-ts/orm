import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(import.meta.dirname, '../..')
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
})
