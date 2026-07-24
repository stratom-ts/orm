import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const esm = await import('../dist/stratom.js')
const commonjs = require('../dist/stratom.umd.cjs')

assert.deepEqual(Object.keys(commonjs).sort(), Object.keys(esm).sort())

for (const [name, type] of Object.entries({
  createDb: 'function',
  defineTable: 'function',
  postgresDialect: 'object',
  unwrapDeep: 'function',
})) {
  assert.equal(typeof esm[name], type, `missing ESM export: ${name}`)
  assert.equal(typeof commonjs[name], type, `missing CommonJS export: ${name}`)
}

for (const name of [
  'inferPostgresType',
  'mapPostgresParamValue',
  'mapPostgresResultValue',
]) {
  assert.equal(name in esm, false, `unexpected ESM export: ${name}`)
  assert.equal(name in commonjs, false, `unexpected CommonJS export: ${name}`)
}

console.log('Package exports are synchronized.')
