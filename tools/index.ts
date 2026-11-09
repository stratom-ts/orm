import testTitleShould from './oxlint-test-title-rule.mjs'
import padMultilineBlocks from './oxlint-whitespace-plugin.mjs'

export default {
  meta: { name: 'stratom' },
  rules: { whitespace: padMultilineBlocks, 'test-title-should': testTitleShould },
}
